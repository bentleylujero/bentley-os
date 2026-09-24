// retrieve-folder.ts — folder-scoped chunk retrieval for the remote MCP
// connector's search_folder tool. Deliberately NOT retrieveContext()/retrieve.ts:
// that path searches a second, non-document Qdrant collection too and feeds
// /think's reasoning pipeline. This one stays documents-only, filters by the
// Qdrant payload `folder` key (must_match, no fallback — an unscoped search
// would defeat the point of a folder-scoped tool), and returns raw chunks —
// the MCP caller (claude.ai, or whoever else is
// on the other end of the connection) does its own reasoning, so no /think, no
// classify/router, no synthesis here (Ticket 5 §1 — deliberate).
//
// Postgres documents.folder is the ONE source of truth for folder (ontology-
// first). The Qdrant payload `folder` key is a derived copy, kept in sync by
// embed-doc.ts for NEW points and by the /resync-folders job for the 24
// pre-existing points that predate that write. This file only reads — title,
// chunk text, and folder in the response all come from Postgres, never trusted
// from the Qdrant payload, same source-of-truth rule retrieve.ts follows.
import postgres from 'postgres';
import { embedText } from './embed.ts';

const sql = postgres(process.env.DATABASE_URL || '', {
  max: 2,
  idle_timeout: 20,
});

const QDRANT_URL = process.env.QDRANT_URL || 'http://qdrant:6333';
const QDRANT_DOCUMENTS = 'documents'; // same collection embed-doc.ts writes to
const PER_DOCUMENT_CAP = 2; // mirrors retrieve.ts — one document can't crowd out the rest
const QUERY_MAX_CHARS = 2000; // length-cap before embedding (embedText caps again at 8000)
const TIMEOUT_MS = 30_000;

// Same rule as the documents.folder check constraint (0012): trim + lowercase.
export function normalizeFolder(input: string): string {
  return input.trim().toLowerCase();
}

export interface FolderChunk {
  document_id: string;
  title: string | null;
  folder: string;
  chunk_index: number;
  score: number;
  text: string;
}

interface QdrantHit {
  id: string;
  score: number;
  payload?: Record<string, any>;
}

async function searchByFolder(
  vector: number[],
  folder: string,
  limit: number,
): Promise<QdrantHit[]> {
  const res = await fetch(`${QDRANT_URL}/collections/${QDRANT_DOCUMENTS}/points/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      vector,
      limit,
      with_payload: true,
      filter: { must: [{ key: 'folder', match: { value: folder } }] },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(`Qdrant search HTTP ${res.status} (${QDRANT_DOCUMENTS}): ${body.slice(0, 500)}`);
  }
  const data = await res.json();
  const result = data?.result;
  if (!Array.isArray(result)) {
    throw new Error(`Qdrant search returned malformed result (${QDRANT_DOCUMENTS})`);
  }
  return result.map((r: any) => ({
    id: String(r.id),
    score: Number(r.score),
    payload: r.payload ?? undefined,
  }));
}

// Embeds `query` once (reusing the §8 embedText seam — not reimplemented),
// searches Qdrant restricted to the `folder` payload key (must_match, no
// fallback to an unfiltered search — a folder with no resynced/embedded points
// legitimately yields zero results, not a wider search), caps to
// PER_DOCUMENT_CAP chunks per document (mirrors retrieve.ts), then SELECTs
// chunk text + title + folder from Postgres — the source of truth — joined
// document_chunks -> documents by the Qdrant point id, filtered AGAIN by
// d.folder = folder. The Qdrant payload is a derived copy that can only be
// trusted to narrow the vector search; a Postgres hit whose document's real
// folder doesn't match (a Qdrant payload gone stale relative to Postgres,
// e.g. after a future folder-move that skipped /resync-folders) must not be
// returned just because the derived copy said otherwise.
export async function retrieveFolderChunks(
  folder: string,
  query: string,
  limit: number,
): Promise<FolderChunk[]> {
  const vector = await embedText(query.slice(0, QUERY_MAX_CHARS));
  const hits = await searchByFolder(vector, folder, Math.max(limit * 3, limit));
  if (hits.length === 0) return [];

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

  capped.sort((a, b) => b.score - a.score);
  const top = capped.slice(0, limit);

  const ids = top.map((h) => h.id);
  const rows = await sql<
    Array<{ id: string; document_id: string; text: string | null; title: string | null; folder: string | null }>
  >`
    select dc.id, dc.document_id, dc.text, d.title, d.folder
    from document_chunks dc
    join documents d on d.id = dc.document_id
    where dc.id in ${sql(ids)} and d.folder = ${folder}
  `;
  const byId = new Map(rows.map((r) => [r.id, r]));

  return top
    .map((h): FolderChunk | null => {
      const row = byId.get(h.id);
      if (row?.text == null) return null; // hit with no matching row is dropped, not a crash
      return {
        document_id: row.document_id,
        title: row.title,
        folder: row.folder ?? folder,
        chunk_index: Number(h.payload?.chunk_index),
        score: h.score,
        text: row.text,
      };
    })
    .filter((c): c is FolderChunk => c !== null);
}
