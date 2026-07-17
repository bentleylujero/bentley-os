// embed-doc.ts — the DOCUMENT embedding pipeline. Reads documents that have a
// body but no embedding yet, CHUNKS each via Chonkie RecursiveChunker (512-token
// target, safely under 3-small's 8191-token cap per §7), writes one
// document_chunks row per chunk, embeds each chunk via the SHARED embedText()
// (the §8 swap seam — reused, not reimplemented), upserts each chunk vector into
// Qdrant's `documents` collection keyed on the chunk uuid, and stamps
// documents.embedded_at on success.
//
// Mirrors embed.ts: same postgres client, per-DOCUMENT independent audit
// (marionette.embed_doc), one bad document cannot sink the batch. The vectors
// live in Qdrant (derived index); the FACT of being embedded lives on the
// document row. Chunk TEXT lives in Postgres (document_chunks) — the source of
// truth; Qdrant holds only vector + light payload.
//
// This is the "first long-form source" the email pipeline deferred chunking to.
// ONE document = MANY chunks = MANY vectors. Emails stay one-vector (see embed.ts).

import postgres from 'postgres';
import { RecursiveChunker } from '@chonkiejs/core';
import { embedText } from './embed.ts';   // reuse the §8 swap seam — do NOT reimplement
import { audit } from './audit.ts';

const sql = postgres(process.env.DATABASE_URL || '', {
  max: 2,
  idle_timeout: 20,
});

const EMBED_MODEL = 'text-embedding-3-small';
const EMBED_DIM = 1536;
const QDRANT_URL = process.env.QDRANT_URL || 'http://qdrant:6333';
const QDRANT_COLLECTION = 'documents';
const CHUNK_SIZE_TOKENS = 512;           // standard RAG granularity, well under embed cap
const TIMEOUT_MS = 60_000;

interface DocRow {
  id: string;              // uuid
  title: string | null;
  body: string | null;
}

interface ChunkOut {
  text: string;
  token_count: number;
}

// Chunk a document body via Chonkie. Returns [] for empty/whitespace bodies.
async function chunkBody(body: string): Promise<ChunkOut[]> {
  const text = (body ?? '').trim();
  if (!text) return [];
  const chunker = await RecursiveChunker.create({ chunkSize: CHUNK_SIZE_TOKENS });
  const chunks = await chunker.chunk(text);
  return chunks.map((c: any) => ({
    text: c.text,
    token_count: typeof c.tokenCount === 'number' ? c.tokenCount : 0,
  }));
}

// Upsert one chunk vector into Qdrant's documents collection, keyed on the chunk
// uuid. Light payload for display/filter at retrieval time; chunk TEXT stays in
// Postgres (document_chunks), the source of truth — retrieve.ts SELECTs it back.
async function upsertChunkVector(
  chunkId: string,
  documentId: string,
  chunkIndex: number,
  title: string | null,
  vector: number[],
): Promise<void> {
  const res = await fetch(`${QDRANT_URL}/collections/${QDRANT_COLLECTION}/points`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      points: [
        {
          id: chunkId,
          vector,
          payload: {
            document_id: documentId,
            chunk_index: chunkIndex,
            title: title ?? '',
          },
        },
      ],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(`Qdrant upsert HTTP ${res.status}: ${body.slice(0, 500)}`);
  }
}

// Embed up to `limit` un-embedded documents (newest first, via
// idx_documents_unembedded). Each DOCUMENT audits independently — one bad
// document must not sink the batch. Within a document, all chunks must land
// before embedded_at is stamped; a mid-document failure leaves embedded_at NULL
// so the whole doc is re-picked on retry (chunk rows upsert idempotently via the
// (document_id, chunk_index) unique constraint).
export async function embedDocBatch(limit: number): Promise<{
  processed: number;
  results: Array<{ id: string; ok: boolean; chunks?: number; error?: string }>;
}> {
  const docs = await sql<DocRow[]>`
    select id, title, body
    from documents
    where body is not null and embedded_at is null
    order by created_at desc nulls last
    limit ${limit}
  `;

  const results = [];
  for (const doc of docs) {
    try {
      const chunks = await chunkBody(doc.body ?? '');
      if (chunks.length === 0) {
        // Empty body — nothing to embed; stamp it so it leaves the work-queue.
        await sql`update documents set embedded_at = now() where id = ${doc.id}`;
        await audit({
          action: 'marionette.embed_doc',
          target: doc.id,
          outcome: 'success',
          payload: { model: EMBED_MODEL, dim: EMBED_DIM, chunks: 0, note: 'empty body' },
        });
        results.push({ id: doc.id, ok: true, chunks: 0 });
        continue;
      }

      let index = 0;
      for (const chunk of chunks) {
        // Upsert the chunk row first (idempotent on re-run), get its id back.
        const [row] = await sql<{ id: string }[]>`
          insert into document_chunks (document_id, chunk_index, text, token_count)
          values (${doc.id}, ${index}, ${chunk.text}, ${chunk.token_count})
          on conflict (document_id, chunk_index)
          do update set text = excluded.text, token_count = excluded.token_count
          returning id
        `;
        const vector = await embedText(chunk.text);
        await upsertChunkVector(row.id, doc.id, index, doc.title, vector);
        index++;
      }

      await sql`update documents set embedded_at = now() where id = ${doc.id}`;
      await audit({
        action: 'marionette.embed_doc',
        target: doc.id,
        outcome: 'success',
        payload: { model: EMBED_MODEL, dim: EMBED_DIM, chunks: chunks.length },
      });
      results.push({ id: doc.id, ok: true, chunks: chunks.length });
    } catch (err: any) {
      const message = err?.message || String(err);
      await audit({
        action: 'marionette.embed_doc',
        target: doc.id,
        outcome: 'error',
        payload: { error: message },
      });
      results.push({ id: doc.id, ok: false, error: message });
    }
  }

  return { processed: docs.length, results };
}
