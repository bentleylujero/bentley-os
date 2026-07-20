// retrieve.ts — grounded Q&A retrieval. Given a natural-language request, embeds
// it ONCE with the SAME model/pipeline used at ingest (embedText from embed.ts,
// OpenAI text-embedding-3-small — one embedding space, no mismatch), then
// searches TWO Qdrant collections in parallel with that single vector:
//   - `emails`    : one email = one vector (see embed.ts), body SELECTed back
//                   from Postgres `emails`.
//   - `documents` : one document = many chunk vectors (see embed-doc.ts), chunk
//                   TEXT SELECTed back from Postgres `document_chunks`.
// Qdrant never stores body/chunk text — Postgres is the one source of truth for
// both paths. Results merge by score (best first) and truncate to TOP_K total.
// Reasoning over the result stays in /think; this file only fetches and shapes.
//
// Both collections share the embedding space, so their cosine scores are directly
// comparable — one merged, score-sorted list is honest. A documents-side failure
// is isolated so it can never sink a query that email alone could answer.
import postgres from 'postgres';
import { embedText } from './embed.ts';

const sql = postgres(process.env.DATABASE_URL || '', {
  max: 2,
  idle_timeout: 20,
});

const QDRANT_URL = process.env.QDRANT_URL || 'http://qdrant:6333';
// Two collections, side by side. Structural, not configuration — the pipelines
// that fill them (embed.ts, embed-doc.ts) hardcode these same names, so they are
// not env vars.
const QDRANT_EMAILS = 'emails';
const QDRANT_DOCUMENTS = 'documents';
const TOP_K = 10;
const PER_DOCUMENT_CAP = 2; // at most 2 chunks from any one document survive
const TIMEOUT_MS = 30_000;

// Discriminated union on `kind` — retrieval returns the union; the citation
// branch lives in the formatter (data-gate.ts), not here.
export interface RetrievedEmail {
  kind: 'email';
  id: string;
  score: number;
  subject: string | null;
  body: string | null;
  received_at: string | null;
}

export interface RetrievedChunk {
  kind: 'chunk';
  id: string; // the chunk uuid (document_chunks.id / Qdrant point id)
  score: number;
  document_id: string;
  chunk_index: number;
  title: string | null;
  text: string | null;
}

export type Retrieved = RetrievedEmail | RetrievedChunk;

interface QdrantHit {
  id: string;
  score: number;
  payload?: Record<string, any>;
}

// One collection, one search. `withPayload` off for emails (id is enough — body
// comes from Postgres); on for documents (payload carries document_id /
// chunk_index / title, needed to cap and cite before the Postgres read).
async function searchQdrant(
  collection: string,
  vector: number[],
  withPayload: boolean,
): Promise<QdrantHit[]> {
  const res = await fetch(`${QDRANT_URL}/collections/${collection}/points/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vector, limit: TOP_K, with_payload: withPayload }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(`Qdrant search HTTP ${res.status} (${collection}): ${body.slice(0, 500)}`);
  }
  const data = await res.json();
  const result = data?.result;
  if (!Array.isArray(result)) {
    throw new Error(`Qdrant search returned malformed result (${collection})`);
  }
  return result.map((r: any) => ({
    id: String(r.id),
    score: Number(r.score),
    payload: r.payload ?? undefined,
  }));
}

// emails path: search (no payload) → SELECT real bodies from Postgres by id.
// Throws on failure — the caller (/think) degrades to "no context injected",
// and retrieveContext lets this one propagate so email stays the load-bearing path.
async function retrieveEmails(vector: number[]): Promise<RetrievedEmail[]> {
  const hits = await searchQdrant(QDRANT_EMAILS, vector, false);
  if (hits.length === 0) return [];

  const ids = hits.map((h) => h.id);
  const rows = await sql<
    Array<{ id: string; subject: string | null; body: string | null; received_at: string | null }>
  >`
    select id, subject, body, received_at
    from emails
    where id in ${sql(ids)}
  `;

  const byId = new Map(rows.map((r) => [r.id, r]));
  return hits
    .map((h): RetrievedEmail => {
      const row = byId.get(h.id);
      return {
        kind: 'email',
        id: h.id,
        score: h.score,
        subject: row?.subject ?? null,
        body: row?.body ?? null,
        received_at: row?.received_at ?? null,
      };
    })
    .filter((r) => r.body != null); // a hit with no matching row is dropped, not a crash
}

// documents path: search (WITH payload) → cap to PER_DOCUMENT_CAP per document on
// the payload BEFORE hitting Postgres → SELECT chunk text from document_chunks by
// id. Chunk TEXT never comes from Qdrant payload — same one-source-of-truth rule
// the emails path follows.
async function retrieveChunks(vector: number[]): Promise<RetrievedChunk[]> {
  const hits = await searchQdrant(QDRANT_DOCUMENTS, vector, true);
  if (hits.length === 0) return [];

  // Per-document cap, applied on the payload before the Postgres read: group by
  // document_id, keep the PER_DOCUMENT_CAP highest-scoring chunks per document,
  // discard the rest. A hit with no document_id can be neither capped nor cited,
  // so it is dropped here.
  const byDoc = new Map<string, QdrantHit[]>();
  for (const h of hits) {
    const docId = h.payload?.document_id;
    if (typeof docId !== 'string') continue;
    const arr = byDoc.get(docId) ?? [];
    arr.push(h);
    byDoc.set(docId, arr);
  }
  const capped: QdrantHit[] = [];
  for (const arr of byDoc.values()) {
    arr.sort((a, b) => b.score - a.score);
    capped.push(...arr.slice(0, PER_DOCUMENT_CAP));
  }
  if (capped.length === 0) return [];

  const ids = capped.map((h) => h.id);
  const rows = await sql<Array<{ id: string; text: string | null }>>`
    select id, text
    from document_chunks
    where id in ${sql(ids)}
  `;

  const byId = new Map(rows.map((r) => [r.id, r]));
  return capped
    .map((h): RetrievedChunk => ({
      kind: 'chunk',
      id: h.id,
      score: h.score,
      document_id: String(h.payload?.document_id),
      chunk_index: Number(h.payload?.chunk_index),
      title: typeof h.payload?.title === 'string' ? h.payload.title : null,
      text: byId.get(h.id)?.text ?? null,
    }))
    .filter((r) => r.text != null); // a hit with no matching row is dropped, not a crash
}

// Embeds the request ONCE, fires both collection searches in parallel at TOP_K
// each, merges by score (best first), truncates to TOP_K total. The emails path
// may throw (caller degrades to "no context injected"); the documents path is
// isolated — a documents-side failure logs and yields [], so email can still
// answer. Mirrors the graceful-degradation pattern in system-sight/audit-sight.
export async function retrieveContext(request: string): Promise<Retrieved[]> {
  const vector = await embedText(request);

  const [emails, chunks] = await Promise.all([
    retrieveEmails(vector),
    retrieveChunks(vector).catch((err) => {
      console.error('[retrieve] documents retrieval failed, continuing with emails only:', err);
      return [] as RetrievedChunk[];
    }),
  ]);

  return [...emails, ...chunks]
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_K);
}
