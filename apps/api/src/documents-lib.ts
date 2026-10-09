// documents-lib.ts — logic shared by the HTTP routes (routes/documents.ts) and
// the MCP tools (mcp-tools.ts). Imports only the pg pool, so it is safe for the
// stdio-only MCP entrypoint (which must never pull in routes/index.ts — see
// mcp-stdio.ts). No reasoning, no embedding (§9): api writes the row,
// marionette embeds it later via the /embed-doc drain.
import { createHash } from 'node:crypto';
import { pool } from './db/pool.js';

// Single definition of "a folder name": lowercase/trimmed (mirrors the DB CHECK
// documents_folder_normalized) and, for names a human or Claude *creates*,
// restricted to a boring charset so it is safe in URLs, HTML and logs.
export function normalizeFolder(input: unknown): string {
  if (typeof input !== 'string') return 'general';
  const trimmed = input.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : 'general';
}

const FOLDER_RE = /^[a-z0-9][a-z0-9 _.-]{0,63}$/;
export function isValidFolderName(name: string): boolean {
  return FOLDER_RE.test(name);
}

export const MAX_DOC_CHARS = 2_000_000;

export interface DocumentRow {
  id: string;
  title: string;
  mime: string;
  char_count: number;
  created_at: string;
  embedded_at: string | null;
  folder: string;
}

// Inserts a document unless an identical-content one is already in that folder
// (content hash lives in source_id; unique index uq_documents_folder_source_id).
// This is what makes re-running a bulk directory ingest safe. The folder is
// auto-registered by the trg_documents_register_folder trigger (unexposed).
export async function insertDocument(a: {
  title: string;
  mime: string;
  text: string;
  folder: string;
  source: string;
}): Promise<{ document: DocumentRow; duplicate: boolean }> {
  const hash = 'sha256:' + createHash('sha256').update(a.text).digest('hex');
  const ins = await pool.query<DocumentRow>(
    `insert into documents (title, source, source_id, mime, body, char_count, folder)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (folder, source_id) where source_id is not null do nothing
     returning id, title, mime, char_count, created_at, embedded_at, folder`,
    [a.title, a.source, hash, a.mime, a.text, a.text.length, a.folder],
  );
  if (ins.rows[0]) return { document: ins.rows[0], duplicate: false };
  const ex = await pool.query<DocumentRow>(
    `select id, title, mime, char_count, created_at, embedded_at, folder
     from documents where folder = $1 and source_id = $2`,
    [a.folder, hash],
  );
  return { document: ex.rows[0]!, duplicate: true };
}
