import { Hono } from 'hono';
import mammoth from 'mammoth';
import { extractText as pdfExtractText, getDocumentProxy } from 'unpdf';
import { extractPptxText } from '../extract/pptx.js';
import { pool } from '../db/pool.js';
import { audit } from '../db/audit.js';
import {
  insertDocument,
  isValidFolderName,
  normalizeFolder,
  MAX_DOC_CHARS,
} from '../documents-lib.js';

export const documentsRoute = new Hono();

const MARIONETTE = 'http://marionette:4200';
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Thrown by extractText for a MIME we deliberately don't handle yet, OR for a
// file whose text layer came back effectively empty. The handler maps this to a
// 415 (not a 500) — a clean rejection, not a crash.
class UnsupportedType extends Error {
  constructor(message: string) {
    super(message);
  }
}

// A file that parses fine but yields no real text is silent garbage: an empty
// documents row that embeds to nothing. Reject loudly at upload instead. Covers
// image-only DOCX today and scanned PDFs when that case lands.
const MIN_CHARS = 20;

const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PPTX_MIME =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';

// Plain-text formats, matched by extension because browsers and curl label most
// of them application/octet-stream (or nothing). The stored mime is normalized
// from this table so the documents table stays tidy. `.env` and key/cert files
// are deliberately absent — secrets don't belong in a searchable index.
const TEXT_EXT_MIME: Record<string, string> = {
  md: 'text/markdown', markdown: 'text/markdown', txt: 'text/plain',
  rst: 'text/plain', org: 'text/plain', tex: 'text/plain', log: 'text/plain',
  csv: 'text/csv', tsv: 'text/tab-separated-values',
  json: 'application/json', jsonl: 'application/json', ndjson: 'application/json',
  yaml: 'application/yaml', yml: 'application/yaml', toml: 'text/plain',
  ini: 'text/plain', cfg: 'text/plain', conf: 'text/plain',
  xml: 'application/xml', html: 'text/html', htm: 'text/html', svg: 'text/plain',
  css: 'text/plain', scss: 'text/plain', sql: 'text/plain',
  py: 'text/plain', js: 'text/plain', mjs: 'text/plain', cjs: 'text/plain',
  ts: 'text/plain', tsx: 'text/plain', jsx: 'text/plain', java: 'text/plain',
  c: 'text/plain', h: 'text/plain', cpp: 'text/plain', hpp: 'text/plain',
  cs: 'text/plain', go: 'text/plain', rs: 'text/plain', rb: 'text/plain',
  php: 'text/plain', sh: 'text/plain', bash: 'text/plain', zsh: 'text/plain',
  swift: 'text/plain', kt: 'text/plain', dart: 'text/plain', lua: 'text/plain',
  r: 'text/plain', pl: 'text/plain',
};

// Binary formats we can parse, recognised by extension when the client sent a
// generic content-type (curl and many browsers do for .docx/.pptx).
const EXT_PARSER_MIME: Record<string, string> = {
  docx: DOCX_MIME,
  pptx: PPTX_MIME,
  pdf: 'application/pdf',
};

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

// extractText — the single content seam. api does NO interpretation of the text
// (§9) — it just pulls the raw string. Returns the text AND the mime to store.
async function extractText(file: File): Promise<{ text: string; mime: string }> {
  const declared = file.type || 'application/octet-stream';
  let text: string;

  const ext = extOf(file.name || '');
  const textExtMime = TEXT_EXT_MIME[ext];
  const parserMime =
    declared === 'application/octet-stream' ? (EXT_PARSER_MIME[ext] ?? declared) : declared;
  let mime = parserMime;
  const isTextual =
    declared.startsWith('text/') ||
    declared === 'application/json' ||
    declared === 'application/xml' ||
    declared === 'application/x-yaml' ||
    declared === 'application/yaml';

  switch (parserMime) {
    case DOCX_MIME: {
      const buffer = Buffer.from(await file.arrayBuffer());
      const result = await mammoth.extractRawText({ buffer });
      text = result.value;
      break;
    }

    case PPTX_MIME: {
      // Slide text + speaker notes, in slide order, with '## Slide N' headers
      // so chunks carry provenance. Pure zip+XML — no OCR, no model call (§9).
      const bytes = new Uint8Array(await file.arrayBuffer());
      text = extractPptxText(bytes);
      break;
    }

    case 'application/pdf': {
      // Text layer only. A scanned/image-only PDF yields ~nothing and falls
      // through to the MIN_CHARS guard below as a clean 415. OCR is a separate,
      // later slice — this seam accommodates it without rework.
      const bytes = new Uint8Array(await file.arrayBuffer());
      const pdf = await getDocumentProxy(bytes);
      const { text: pdfText } = await pdfExtractText(pdf, { mergePages: true });
      text = pdfText;
      break;
    }

    default: {
      if (!isTextual && !textExtMime) {
        throw new UnsupportedType(`unsupported file type: ${declared}`);
      }
      text = await file.text();
      // A NUL byte means it is really binary wearing a text extension.
      if (text.includes('\u0000')) {
        throw new UnsupportedType(`${file.name || 'file'} looks binary, not text`);
      }
      if (textExtMime) mime = textExtMime;
    }
  }

  if (text.trim().length < MIN_CHARS) {
    throw new UnsupportedType(
      `no usable text extracted from ${declared} — file may be empty or image-only`,
    );
  }
  if (text.length > MAX_DOC_CHARS) {
    throw new UnsupportedType(
      `document too large (${text.length} chars; limit ${MAX_DOC_CHARS})`,
    );
  }
  return { text, mime };
}

// POST /documents — multipart upload. api extracts text + writes the row only;
// marionette embeds it later (Chonkie chunks -> OpenAI 3-small -> Qdrant) via the
// /embed-doc work-queue, which drains on embedded_at IS NULL. No reasoning here (§9).
// Identical content already in the folder -> 200 {duplicate:true}, no new row.
documentsRoute.post('/documents', async (c) => {
  let file: unknown;
  let folderInput: unknown;
  try {
    const body = await c.req.parseBody();
    file = body['file'];
    folderInput = body['folder'];
  } catch {
    return c.json({ error: 'file required' }, 400);
  }
  if (!(file instanceof File)) return c.json({ error: 'file required' }, 400);
  if (file.size > MAX_UPLOAD_BYTES) {
    return c.json({ error: `file too large (limit ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)` }, 413);
  }

  const folder = normalizeFolder(folderInput);
  if (!isValidFolderName(folder)) {
    return c.json({ error: 'invalid folder name (letters, digits, space, _ . - ; max 64)' }, 400);
  }

  let extracted: { text: string; mime: string };
  try {
    extracted = await extractText(file);
  } catch (err) {
    if (err instanceof UnsupportedType) return c.json({ error: err.message }, 415);
    console.error('POST /documents extract failed:', err);
    return c.json({ error: 'could not read file' }, 400);
  }

  try {
    const { document, duplicate } = await insertDocument({
      title: file.name || 'untitled',
      mime: extracted.mime,
      text: extracted.text,
      folder,
      source: 'upload',
    });
    return c.json({ document, duplicate }, duplicate ? 200 : 201);
  } catch (err) {
    console.error('POST /documents failed:', err);
    return c.json({ error: 'insert failed' }, 500);
  }
});

// GET /documents?folder=&limit= — document list for the dashboard (no bodies).
documentsRoute.get('/documents', async (c) => {
  const folder = c.req.query('folder');
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 200, 1), 500);
  const { rows } = await pool.query(
    `select id, title, folder, mime, char_count, created_at, embedded_at
     from documents
     where ($1::text is null or folder = $1)
     order by created_at desc
     limit $2`,
    [folder ? normalizeFolder(folder) : null, limit],
  );
  return c.json({ documents: rows });
});

// PATCH /documents/:id  { folder } — move a document to another folder.
// Postgres documents.folder is the one record; the Qdrant `folder` payload is a
// derived copy, so we ask marionette to resync just this document (api never
// touches Qdrant — §9). If that call fails the move still stands (retrieval is
// also constrained by Postgres folder, so nothing leaks) but the document is
// unfindable in its new folder until /resync-folders runs; we say so.
documentsRoute.patch('/documents/:id', async (c) => {
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) return c.json({ error: 'bad id' }, 400);
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'json body required' }, 400); }
  const folder = normalizeFolder(body?.folder);
  if (!isValidFolderName(folder)) {
    return c.json({ error: 'invalid folder name (letters, digits, space, _ . - ; max 64)' }, 400);
  }

  let from: string;
  try {
    const cur = await pool.query(`select folder from documents where id = $1`, [id]);
    if (cur.rowCount === 0) return c.json({ error: 'not found' }, 404);
    from = cur.rows[0].folder;
    if (from !== folder) {
      await pool.query(`update documents set folder = $1 where id = $2`, [folder, id]);
    }
  } catch (err: any) {
    // 23505 = the target folder already holds identical content.
    if (err?.code === '23505') {
      return c.json({ error: 'that folder already contains an identical document' }, 409);
    }
    console.error('PATCH /documents/:id failed:', err);
    return c.json({ error: 'move failed' }, 500);
  }

  let synced = true;
  let syncError: string | undefined;
  if (from !== folder) {
    try {
      const res = await fetch(`${MARIONETTE}/resync-folders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ document_ids: [id] }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`marionette ${res.status}`);
      const r: any = await res.json();
      if (Array.isArray(r?.errors) && r.errors.length > 0) throw new Error(r.errors[0].error);
    } catch (err: any) {
      synced = false;
      syncError = err?.message ?? String(err);
    }
    await audit({
      action: 'documents.move',
      target: id,
      outcome: synced ? 'success' : 'moved_resync_failed',
      payload: { from, to: folder, ...(syncError ? { error: syncError } : {}) },
    });
  }
  return c.json({ id, folder, from, qdrant_synced: synced, ...(syncError ? { warning: syncError } : {}) });
});

// GET /documents/folders — folders with doc counts and MCP exposure. Pure read,
// no reasoning (§9). `folders` (plain names) is kept for older callers.
documentsRoute.get('/documents/folders', async (c) => {
  const { rows } = await pool.query(
    `select f.name, f.mcp_exposed, count(d.id)::int as doc_count
     from document_folders f
     left join documents d on d.folder = f.name
     group by f.name, f.mcp_exposed
     order by f.name`,
  );
  return c.json({ folders: rows.map((r) => r.name as string), details: rows });
});

// POST /documents/folders  { name, mcp_exposed? } — create an (empty) folder.
documentsRoute.post('/documents/folders', async (c) => {
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'json body required' }, 400); }
  const name = normalizeFolder(body?.name);
  if (typeof body?.name !== 'string' || !isValidFolderName(name)) {
    return c.json({ error: 'invalid folder name (letters, digits, space, _ . - ; max 64)' }, 400);
  }
  const exposed = body?.mcp_exposed === true;
  const { rows } = await pool.query(
    `insert into document_folders (name, mcp_exposed) values ($1, $2)
     on conflict (name) do nothing
     returning name, mcp_exposed`,
    [name, exposed],
  );
  if (rows[0]) {
    await audit({ action: 'documents.folder_create', target: name, outcome: 'success', payload: { mcp_exposed: exposed } });
    return c.json({ folder: rows[0], created: true }, 201);
  }
  return c.json({ folder: { name }, created: false }, 200);
});

// PATCH /documents/folders/:name  { mcp_exposed } — the ONE place exposure is
// changed. No MCP tool can reach this; only the dashboard can widen access.
documentsRoute.patch('/documents/folders/:name', async (c) => {
  const name = normalizeFolder(c.req.param('name'));
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'json body required' }, 400); }
  if (typeof body?.mcp_exposed !== 'boolean') return c.json({ error: 'mcp_exposed (boolean) required' }, 400);
  const { rows } = await pool.query(
    `update document_folders set mcp_exposed = $2 where name = $1 returning name, mcp_exposed`,
    [name, body.mcp_exposed],
  );
  if (!rows[0]) return c.json({ error: 'not found' }, 404);
  await audit({ action: 'documents.folder_exposure', target: name, outcome: 'success', payload: { mcp_exposed: body.mcp_exposed } });
  return c.json({ folder: rows[0] });
});

// DELETE /documents/folders/:name — only an EMPTY folder, never 'general'.
// (documents.folder -> document_folders FK would refuse a non-empty one anyway.)
documentsRoute.delete('/documents/folders/:name', async (c) => {
  const name = normalizeFolder(c.req.param('name'));
  if (name === 'general') return c.json({ error: "'general' cannot be deleted" }, 400);
  const used = await pool.query(`select 1 from documents where folder = $1 limit 1`, [name]);
  if ((used.rowCount ?? 0) > 0) return c.json({ error: 'folder is not empty — move its documents first' }, 409);
  const del = await pool.query(`delete from document_folders where name = $1`, [name]);
  if (del.rowCount === 0) return c.json({ error: 'not found' }, 404);
  await audit({ action: 'documents.folder_delete', target: name, outcome: 'success' });
  return c.json({ deleted: name });
});
