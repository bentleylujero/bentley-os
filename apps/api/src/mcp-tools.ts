// mcp-tools.ts — transport-agnostic tool logic for the MCP relay. No
// reasoning, no prompts, no embeddings live here (§9 — that's marionette's
// job). This module reads/writes Postgres directly for folder + document
// access, and forwards search to marionette's POST /retrieve/folder.
//
// EXPOSURE: a folder is visible to a connected Claude only if
// document_folders.mcp_exposed is true. That flag is written ONLY by the
// dashboard routes in routes/documents.ts — no tool in this file can change it,
// so a connected Claude can never widen its own access. It is read fresh on
// every call (never cached), so a dashboard toggle takes effect immediately and
// an empty set fails closed. (This replaces the old MCP_ALLOWED_FOLDERS env var,
// which is now ignored.)
//
// WRITES: upload_document is the one write tool. It can only ADD a document to
// an already-exposed folder — no overwrite, no delete, no folder creation.
//
// registerTools() attaches the tools to an already-constructed McpServer; it
// knows nothing about which transport that server is connected to.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { pool } from './db/pool.js';
import { audit as baseAudit, type AuditRow } from './db/audit.js';
import { insertDocument, normalizeFolder, MAX_DOC_CHARS } from './documents-lib.js';

const MARIONETTE = 'http://marionette:4200';
const MAX_RESULT_CHARS = 12_000;
const FETCH_TIMEOUT_MS = 30_000;

async function isExposed(folder: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `select 1 from document_folders where name = $1 and mcp_exposed`,
    [folder],
  );
  return (rowCount ?? 0) > 0;
}

function text(t: string) {
  return { content: [{ type: 'text' as const, text: t }] };
}
function err(t: string) {
  return { isError: true, content: [{ type: 'text' as const, text: t }] };
}

interface FolderChunk {
  document_id: string;
  title: string | null;
  folder: string;
  chunk_index: number;
  score: number;
  text: string;
}

export interface ToolCtx {
  transport: 'stdio' | 'http';
  clientId?: string;
}

export function registerTools(server: McpServer, ctx: ToolCtx): void {
  // Every mcp.* audit row carries which transport and which OAuth client made the call.
  const audit = (row: AuditRow) =>
    baseAudit({
      ...row,
      payload: { ...(row.payload as object | undefined), transport: ctx.transport, client_id: ctx.clientId ?? null },
    });

  server.registerTool(
    'list_folders',
    {
      title: 'List folders',
      description:
        'List the document folders exposed to this connection, each with its document count.',
      inputSchema: {},
    },
    async () => {
      const { rows } = await pool.query<{ folder: string; doc_count: number }>(
        `select f.name as folder, count(d.id)::int as doc_count
         from document_folders f
         left join documents d on d.folder = f.name
         where f.mcp_exposed
         group by f.name
         order by f.name`,
      );

      await audit({
        action: 'mcp.list_folders',
        outcome: rows.length === 0 ? 'empty_allowlist' : 'success',
        payload: { result_count: rows.length },
      });

      if (rows.length === 0) {
        return text('No folders are exposed to this connector. Turn one on in the Bentley OS dashboard (Knowledge Base card).');
      }
      return text(rows.map((r) => `${r.folder} (${r.doc_count} docs)`).join('\n'));
    },
  );

  server.registerTool(
    'list_documents',
    {
      title: 'List documents',
      description:
        'List the documents in one exposed folder (id, title, size, whether it is searchable yet). Use the id with get_document to read one in full.',
      inputSchema: {
        folder: z.string().min(1).max(200),
        limit: z.number().int().min(1).optional(),
      },
    },
    async ({ folder, limit }) => {
      const f = normalizeFolder(folder);
      if (!(await isExposed(f))) {
        await audit({ action: 'mcp.list_documents', target: f, outcome: 'rejected_not_allowed', payload: { result_count: 0 } });
        return err(`Folder "${f}" is not exposed to this connector.`);
      }
      const cap = Math.min(Math.max(limit ?? 100, 1), 200);
      const { rows } = await pool.query(
        `select id, title, mime, char_count, created_at, embedded_at
         from documents where folder = $1 order by created_at desc limit $2`,
        [f, cap],
      );
      await audit({ action: 'mcp.list_documents', target: f, outcome: 'success', payload: { result_count: rows.length } });
      if (rows.length === 0) return text(`Folder "${f}" is empty.`);
      return text(
        rows
          .map(
            (r) =>
              `${r.id} | ${r.title} | ${r.mime} | ${r.char_count} chars | ${r.embedded_at ? 'searchable' : 'indexing (not searchable yet)'}`,
          )
          .join('\n'),
      );
    },
  );

  server.registerTool(
    'get_document',
    {
      title: 'Get document',
      description:
        'Read the full text of one document by id (from list_documents or search results). Long documents are paged: pass offset to continue where the previous page stopped.',
      inputSchema: {
        document_id: z.string().uuid(),
        offset: z.number().int().min(0).optional(),
        max_chars: z.number().int().min(1).optional(),
      },
    },
    async ({ document_id, offset, max_chars }) => {
      const start = offset ?? 0;
      const n = Math.min(Math.max(max_chars ?? MAX_RESULT_CHARS, 1), MAX_RESULT_CHARS);
      const { rows } = await pool.query(
        `select d.id, d.title, d.folder, d.char_count, substr(d.body, $2::int + 1, $3::int) as page
         from documents d
         join document_folders f on f.name = d.folder
         where d.id = $1 and f.mcp_exposed`,
        [document_id, start, n],
      );
      const r = rows[0];
      if (!r) {
        // Same answer whether the id is unknown or its folder is not exposed.
        await audit({ action: 'mcp.get_document', target: document_id, outcome: 'rejected_not_found_or_not_allowed', payload: {} });
        return err('Document not found, or its folder is not exposed to this connector.');
      }
      await audit({ action: 'mcp.get_document', target: document_id, outcome: 'success', payload: { folder: r.folder, offset: start, returned_chars: r.page.length } });
      const end = start + r.page.length;
      const footer =
        end < r.char_count
          ? `\n[continues — ${r.char_count - end} more chars; call get_document again with offset=${end}]`
          : '\n[end of document]';
      return text(`# ${r.title} — ${r.folder} — chars ${start}-${end} of ${r.char_count}\n${r.page}${footer}`);
    },
  );

  server.registerTool(
    'upload_document',
    {
      title: 'Upload document',
      description:
        'Add a text document to an exposed folder so it becomes searchable (indexing takes up to ~5 minutes). Add-only: it cannot overwrite or delete, and cannot create folders. Identical content already in the folder is skipped.',
      inputSchema: {
        folder: z.string().min(1).max(200),
        title: z.string().min(1).max(200),
        content: z.string().min(20).max(MAX_DOC_CHARS),
      },
    },
    async ({ folder, title, content }) => {
      const f = normalizeFolder(folder);
      if (!(await isExposed(f))) {
        await audit({ action: 'mcp.upload_document', target: f, outcome: 'rejected_not_allowed', payload: {} });
        return err(`Folder "${f}" is not exposed to this connector (create/expose it in the dashboard first).`);
      }
      const t = title.trim();
      const mime = /\.md$/i.test(t) ? 'text/markdown' : /\.csv$/i.test(t) ? 'text/csv' : /\.json$/i.test(t) ? 'application/json' : 'text/plain';
      try {
        const { document, duplicate } = await insertDocument({ title: t, mime, text: content, folder: f, source: 'mcp' });
        await audit({
          action: 'mcp.upload_document',
          target: f,
          outcome: duplicate ? 'duplicate' : 'success',
          payload: { document_id: document.id, char_count: document.char_count },
        });
        return text(
          duplicate
            ? `Identical content already exists in "${f}" as ${document.id} ("${document.title}"); nothing added.`
            : `Added "${document.title}" to "${f}" (${document.id}, ${document.char_count} chars). It will be searchable within ~5 minutes.`,
        );
      } catch (e: any) {
        await audit({ action: 'mcp.upload_document', target: f, outcome: 'error', payload: { error: e?.message ?? String(e) } });
        return err(`Upload failed: ${e?.message ?? String(e)}`);
      }
    },
  );

  server.registerTool(
    'search_folder',
    {
      title: 'Search folder',
      description:
        'Search one allowed document folder for chunks relevant to a query. Rejects folders not in the allow-list without contacting marionette.',
      inputSchema: {
        folder: z.string().min(1).max(200),
        query: z.string().min(1).max(2000),
        // No upper bound here — capping to 10 is the handler's job (below), not
        // a validation rejection, so an over-limit request degrades gracefully
        // instead of erroring.
        limit: z.number().int().min(1).optional(),
      },
    },
    async ({ folder, query, limit }) => {
      const normalizedFolder = normalizeFolder(folder);
      const cappedLimit = Math.min(Math.max(limit ?? 5, 1), 10);

      if (!(await isExposed(normalizedFolder))) {
        await audit({
          action: 'mcp.search_folder',
          target: normalizedFolder,
          outcome: 'rejected_not_allowed',
          payload: { result_count: 0 },
        });
        return {
          isError: true,
          content: [
            { type: 'text' as const, text: `Folder "${normalizedFolder}" is not exposed to this connector.` },
          ],
        };
      }

      let res: Response;
      try {
        res = await fetch(`${MARIONETTE}/retrieve/folder`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folder: normalizedFolder, query, limit: cappedLimit }),
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
      } catch (err: any) {
        const message = err?.message ?? String(err);
        await audit({
          action: 'mcp.search_folder',
          target: normalizedFolder,
          outcome: 'error',
          payload: { result_count: 0, error: message },
        });
        return { isError: true, content: [{ type: 'text' as const, text: `Retrieval failed: ${message}` }] };
      }

      if (!res.ok) {
        const body = await res.text().catch(() => '<unreadable>');
        await audit({
          action: 'mcp.search_folder',
          target: normalizedFolder,
          outcome: 'error',
          payload: { result_count: 0, status: res.status },
        });
        return {
          isError: true,
          content: [
            { type: 'text' as const, text: `marionette /retrieve/folder returned ${res.status}: ${body.slice(0, 500)}` },
          ],
        };
      }

      const data: any = await res.json();
      const chunks: FolderChunk[] = Array.isArray(data?.chunks) ? data.chunks : [];

      await audit({
        action: 'mcp.search_folder',
        target: normalizedFolder,
        outcome: 'success',
        payload: { result_count: chunks.length },
      });

      if (chunks.length === 0) {
        return {
          content: [{ type: 'text' as const, text: `No results in folder "${normalizedFolder}" for that query.` }],
        };
      }

      let total = 0;
      let truncated = false;
      const parts: string[] = [];
      for (const c of chunks) {
        const block = `# ${c.title ?? '(untitled)'} — ${c.folder} — chunk ${c.chunk_index} — score ${c.score.toFixed(3)}\n${c.text}`;
        if (total + block.length > MAX_RESULT_CHARS) {
          truncated = true;
          break;
        }
        parts.push(block);
        total += block.length;
      }
      if (truncated) {
        parts.push(`[truncated — output capped at ~${MAX_RESULT_CHARS} characters]`);
      }

      return { content: [{ type: 'text' as const, text: parts.join('\n---\n') }] };
    },
  );
}
