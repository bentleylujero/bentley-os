// mcp-stdio.ts — read-only MCP relay exposing Postgres documents.folder (and
// marionette's folder-scoped retrieval) as a knowledge base over stdio.
//
// This is a SEPARATE entrypoint from index.ts, launched directly by Claude
// Desktop as `docker exec -i <container> env MCP_ALLOWED_FOLDERS=... node
// dist/mcp-stdio.js`. It must never import routes/index.ts or
// ingestion/scheduler.ts — those pull in the cron drain and the Telegram
// webhook guard (which throws at import time if its env vars are unset), and
// neither belongs on a stdio-only process a human launches ad hoc.
//
// No reasoning, no prompts, no embeddings live here (§9 — that's
// marionette's job). This relay does exactly two things: read
// Postgres directly for folder listings, and forward search to marionette's
// already-committed POST /retrieve/folder. Exposure is gated ONLY by the
// MCP_ALLOWED_FOLDERS env var (never a tool argument, never the DB) — unset
// or empty fails closed.
//
// stdio protocol discipline: nothing may reach stdout except the SDK's own
// newline-delimited JSON-RPC traffic. All diagnostics go to stderr.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { pool } from './db/pool.js';
import { audit } from './db/audit.js';

const MARIONETTE = 'http://marionette:4200';
const MAX_RESULT_CHARS = 12_000;
const FETCH_TIMEOUT_MS = 30_000;

function normalizeFolder(input: string): string {
  return input.trim().toLowerCase();
}

const ALLOWED_FOLDERS = new Set(
  (process.env.MCP_ALLOWED_FOLDERS ?? '')
    .split(',')
    .map(normalizeFolder)
    .filter((f) => f.length > 0),
);

interface FolderChunk {
  document_id: string;
  title: string | null;
  folder: string;
  chunk_index: number;
  score: number;
  text: string;
}

const server = new McpServer({ name: 'bentley-os-folders', version: '1.0.0' });

server.registerTool(
  'list_folders',
  {
    title: 'List folders',
    description:
      'List the document folders exposed to this connection, each with its document count.',
    inputSchema: {},
  },
  async () => {
    if (ALLOWED_FOLDERS.size === 0) {
      await audit({
        action: 'mcp.list_folders',
        outcome: 'empty_allowlist',
        payload: { result_count: 0 },
      });
      return {
        content: [{ type: 'text' as const, text: 'No folders are exposed to this connector (MCP_ALLOWED_FOLDERS is unset or empty).' }],
      };
    }

    const { rows } = await pool.query<{ folder: string; doc_count: number }>(
      `select folder, count(*)::int as doc_count
       from documents
       where folder = any($1::text[])
       group by folder
       order by folder`,
      [[...ALLOWED_FOLDERS]],
    );

    await audit({
      action: 'mcp.list_folders',
      outcome: 'success',
      payload: { result_count: rows.length },
    });

    if (rows.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No documents found in the allowed folders.' }] };
    }
    const text = rows.map((r) => `${r.folder} (${r.doc_count} docs)`).join('\n');
    return { content: [{ type: 'text' as const, text }] };
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

    if (!ALLOWED_FOLDERS.has(normalizedFolder)) {
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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('[mcp-stdio] fatal error', err);
  process.exit(1);
});
