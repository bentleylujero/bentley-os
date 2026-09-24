// resync-folders.ts — idempotent backfill: sets the Qdrant `folder` payload
// key on every chunk point from Postgres documents.folder, the ONE source of
// truth for folder (ontology-first — Qdrant's copy is derived, never
// authoritative). Fixes points embedded before embed-doc.ts started writing
// `folder` into new points (see embed-doc.ts:82) — those old points carry no
// `folder` key at all, so a folder-scoped Qdrant filter silently returns
// nothing for them until this runs.
//
// Uses Qdrant's set-payload operation (merges the `folder` key onto existing
// points by id — leaves document_id/chunk_index/title untouched), targeted by
// each document's chunk ids from document_chunks. Per-document independent:
// one bad document cannot sink the batch, mirrors embed-doc.ts's per-document
// audit pattern. Re-running writes the same value again — no drift, no net
// change. NOT wired to /think, cron, or the auto-drain — manual POST only.
import postgres from 'postgres';
import { audit } from './audit.ts';

const sql = postgres(process.env.DATABASE_URL || '', {
  max: 2,
  idle_timeout: 20,
});

const QDRANT_URL = process.env.QDRANT_URL || 'http://qdrant:6333';
const QDRANT_DOCUMENTS = 'documents'; // same collection embed-doc.ts writes to
const TIMEOUT_MS = 30_000;

interface DocRow {
  id: string;
  folder: string;
}

// Merges { folder } onto the given point ids. Leaves other payload keys
// (document_id, chunk_index, title) untouched — this is a set, not an upsert.
async function setFolderPayload(pointIds: string[], folder: string): Promise<void> {
  const res = await fetch(`${QDRANT_URL}/collections/${QDRANT_DOCUMENTS}/points/payload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      payload: { folder },
      points: pointIds,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(`Qdrant set-payload HTTP ${res.status} (${QDRANT_DOCUMENTS}): ${body.slice(0, 500)}`);
  }
}

async function countMissingFolder(): Promise<number> {
  const res = await fetch(`${QDRANT_URL}/collections/${QDRANT_DOCUMENTS}/points/count`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filter: { must: [{ is_empty: { key: 'folder' } }] },
      exact: true,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(`Qdrant count HTTP ${res.status} (${QDRANT_DOCUMENTS}): ${body.slice(0, 500)}`);
  }
  const data = await res.json();
  return Number(data?.result?.count ?? 0);
}

export interface ResyncResult {
  documents_scanned: number;
  points_updated: number;
  points_missing_folder_after: number;
  errors: Array<{ document_id: string; error: string }>;
}

// For each document (optionally bounded by `limit`, newest first — mirrors
// embed-doc.ts's ordering), sets the Qdrant `folder` payload to
// documents.folder on every one of that document's chunk points (targeted by
// document_chunks.id — the same uuids embed-doc.ts used as Qdrant point ids).
// A document with zero chunk rows (unembedded) is scanned but has nothing to
// update. One audit_log row per RUN (not per document), counts in payload.
export async function resyncFolders(limit?: number): Promise<ResyncResult> {
  const docs =
    typeof limit === 'number' && Number.isInteger(limit) && limit > 0
      ? await sql<DocRow[]>`select id, folder from documents order by created_at desc nulls last limit ${limit}`
      : await sql<DocRow[]>`select id, folder from documents order by created_at desc nulls last`;

  let pointsUpdated = 0;
  const errors: Array<{ document_id: string; error: string }> = [];

  for (const doc of docs) {
    try {
      const chunkRows = await sql<{ id: string }[]>`
        select id from document_chunks where document_id = ${doc.id}
      `;
      if (chunkRows.length === 0) continue;
      const pointIds = chunkRows.map((r) => r.id);
      await setFolderPayload(pointIds, doc.folder);
      pointsUpdated += pointIds.length;
    } catch (err: any) {
      errors.push({ document_id: doc.id, error: err?.message || String(err) });
    }
  }

  const pointsMissingAfter = await countMissingFolder();

  const result: ResyncResult = {
    documents_scanned: docs.length,
    points_updated: pointsUpdated,
    points_missing_folder_after: pointsMissingAfter,
    errors,
  };

  await audit({
    action: 'marionette.resync_folders',
    outcome: errors.length === 0 ? 'success' : 'partial',
    payload: result,
  });

  return result;
}
