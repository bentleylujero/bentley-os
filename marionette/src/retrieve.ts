// retrieve.ts — grounded Q&A retrieval. Given a natural-language request, embeds
// it with the SAME model/pipeline used at ingest (embedText from embed.ts, OpenAI
// text-embedding-3-small — one embedding space, no mismatch), searches Qdrant's
// `emails` collection for the top-K nearest vectors, then SELECTs the real
// bodies back from Postgres (the one source of truth — Qdrant never stores body
// text, see embed.ts). Reasoning over the result stays in /think; this file only
// fetches and shapes context.
//
// Mirrors embed.ts's connection/timeout conventions exactly. One email = one
// vector, no chunking (see embed.ts's comment on this — same seam, unused
// until a long-form source exists).
import postgres from 'postgres';
import { embedText } from './embed.ts';

const sql = postgres(process.env.DATABASE_URL || '', {
  max: 2,
  idle_timeout: 20,
});

const QDRANT_URL = process.env.QDRANT_URL || 'http://qdrant:6333';
const QDRANT_COLLECTION = 'emails';
const TOP_K = 10;
const TIMEOUT_MS = 30_000;

export interface RetrievedEmail {
  id: string;
  score: number;
  subject: string | null;
  body: string | null;
  received_at: string | null;
}

interface QdrantHit {
  id: string;
  score: number;
}

async function searchQdrant(vector: number[]): Promise<QdrantHit[]> {
  const res = await fetch(`${QDRANT_URL}/collections/${QDRANT_COLLECTION}/points/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vector, limit: TOP_K, with_payload: false }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(`Qdrant search HTTP ${res.status}: ${body.slice(0, 500)}`);
  }
  const data = await res.json();
  const result = data?.result;
  if (!Array.isArray(result)) {
    throw new Error('Qdrant search returned malformed result');
  }
  return result.map((r: any) => ({ id: String(r.id), score: Number(r.score) }));
}

// Embeds the request, searches Qdrant, SELECTs real bodies from Postgres for
// the hits, returns them ordered by score (best first). Throws on any failure
// rather than swallowing it — the caller (/think) wraps this in try/catch and
// degrades to "no context injected", same pattern as audit-sight.
export async function retrieveContext(request: string): Promise<RetrievedEmail[]> {
  const vector = await embedText(request);
  const hits = await searchQdrant(vector);
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
    .map((h) => {
      const row = byId.get(h.id);
      return {
        id: h.id,
        score: h.score,
        subject: row?.subject ?? null,
        body: row?.body ?? null,
        received_at: row?.received_at ?? null,
      };
    })
    .filter((r) => r.body != null); // a hit with no matching row is dropped, not a crash
}
