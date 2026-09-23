// question-router.ts — decides, per /think request, WHICH pre-fetch blocks the
// reasoning turn needs, and (since Ticket 4) WHICH folder to scope a documents
// lookup to, if any. Replaces the two hand-written keyword gates
// (isDataQuestion in data-gate.ts, isSystemStatusQuestion in system-sight.ts).
//
// WHY THIS EXISTS: the keyword gates were substring matches over a hand-picked
// phrase list. They failed silently and often — "what's the key promise in the
// chickens creative brief?" matched nothing, so retrieval never ran and Mari
// answered "I can't see that" while holding the document in Qdrant. Every fix
// was another guess at phrasing. See THE_BIBLE.md §8 (question-router).
//
// DESIGN: one cheap classify pass on deepseek-v4-flash, forced JSON, booleans
// (+ optional folder) out. This is a ROUTING decision, not a reasoning one — it
// never sees the retrieved content and never writes anything.
//
// FAILURE MODE IS THE WHOLE POINT: if the router call fails, times out, or
// returns junk, we fall back to the keyword gates (folder is simply absent in
// that path — no folder scoping, same as before Ticket 4). Degraded = today's
// behavior, never worse than today. The gates stay in the tree for exactly this
// reason.
//
// FOLDER GROUNDING (Ticket 4): folders are freeform TEXT on `documents`, no
// lookup table (see THE_BIBLE.md folder design decisions) — so the model can
// only ever pick a folder that actually exists, never hallucinate one that
// silently returns zero results. getKnownFolders() reads the real distinct set
// each call; the router is told EXACTLY those strings and told to omit folder
// entirely if the request doesn't clearly name one of them. routeQuestion
// re-validates the model's answer against that same list before returning it —
// a mismatch (typo, hallucination, stale list) becomes null, i.e. "search
// everything," never a filter that silently empties the result set.
import postgres from 'postgres';
import { callDeepSeek } from './deepseek.ts';

const ROUTER_MODEL = process.env.MARIONETTE_ROUTER_MODEL || 'deepseek-v4-flash';

const sql = postgres(process.env.DATABASE_URL || '', {
  max: 2,
  idle_timeout: 20,
});

export interface Route {
  needs_data: boolean;
  needs_system: boolean;
  // null = no folder scope (search everything) — either the request didn't
  // name one, or the model's answer didn't match a real folder.
  folder: string | null;
  // 'router' when the model decided; 'fallback' when we degraded to keywords.
  // Surfaced in the audit payload so a silently-degrading router is visible.
  source: 'router' | 'fallback';
}

const BASE_PROMPT = `You are a routing classifier inside a personal homelab assistant. You do NOT answer the user's question. You decide only which data sources must be fetched before another model answers it.

Two sources exist:

1. OWNER DATA — the owner's ingested email and their uploaded documents (briefs, memos, specs, reports, plans, notes, PDFs, Word files, markdown). Set needs_data true if answering would require looking at the actual CONTENT of any email or document the owner has. This includes questions that name or allude to a specific document or message ("the chickens creative brief", "that thing I uploaded", "what does the plan say"), questions asking to find/recall/summarize/quote owner material, and questions about a topic the owner would plausibly have written down. When in doubt, set it TRUE — a wasted lookup is cheap, a missed one makes the assistant claim blindness while holding the answer.

2. SYSTEM ACTIVITY — the homelab's own audit ledger: deploys, service restarts, reasoning calls, delegations, failures, action approvals. Set needs_system true if the question is about what the SYSTEM has been doing, its health, recent work, or whether something failed or deployed.

Both can be true. Both can be false (greetings, general knowledge, math, coding requests, chit-chat).`;

// Folder section is only appended when folders actually exist — an empty
// owner corpus means no grounding is possible, so the contract stays the
// two-boolean shape from before Ticket 4 and the model is never asked to
// invent something it has no basis for.
function buildRouterPrompt(knownFolders: string[]): string {
  if (knownFolders.length === 0) {
    return `${BASE_PROMPT}

Respond with a single JSON object and nothing else:
{"needs_data": <boolean>, "needs_system": <boolean>}`;
  }
  const folderList = knownFolders.map((f) => `"${f}"`).join(', ');
  return `${BASE_PROMPT}

3. FOLDER SCOPE — the owner's documents are organized into folders. The folders that currently exist are exactly: ${folderList}. Set "folder" to one of these EXACT strings only if the owner explicitly names or clearly refers to that folder (e.g. "look in my Career folder", "check the Recipes folder", "in Taxes"). If the request does not clearly name one of these existing folders, set "folder" to null — never invent a folder that is not in this list, and never set one just because the topic loosely relates to it. Folder is independent of needs_data; a folder-scoped request is still needs_data true.

Respond with a single JSON object and nothing else:
{"needs_data": <boolean>, "needs_system": <boolean>, "folder": <one of the exact strings above, or null>}`;
}

// Coerce whatever came back into strict booleans. A model returning "true",
// 1, or null must never become a truthy object.
function coerceBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.trim().toLowerCase() === 'true';
  if (typeof v === 'number') return v === 1;
  return false;
}

// Only a value that exactly matches (after the same lowercase+trim
// normalization used when folders are written) a folder that REALLY exists
// survives. Everything else — wrong type, typo, hallucination, a folder that
// existed when the prompt was built but was renamed a moment later — becomes
// null. null means "no filter," i.e. fail OPEN to searching everything, never
// fail closed to a filter that silently returns nothing.
function coerceFolder(v: unknown, knownFolders: string[]): string | null {
  if (typeof v !== 'string') return null;
  const normalized = v.trim().toLowerCase();
  return knownFolders.includes(normalized) ? normalized : null;
}

// Real distinct folder set, read fresh each call — no lookup table exists by
// design (see THE_BIBLE.md), so this IS the folder registry. Caller degrades
// to [] on failure (same graceful-degradation pattern as ingest-sight /
// audit-sight in index.ts): a failed read here means the router just won't
// offer folder grounding this turn, not that /think breaks.
export async function getKnownFolders(): Promise<string[]> {
  const rows = await sql<{ folder: string }[]>`
    select distinct folder from documents order by folder
  `;
  return rows.map((r) => r.folder);
}

// Returns null on ANY failure — caller decides the fallback. Never throws.
export async function routeQuestion(request: string, knownFolders: string[]): Promise<Route | null> {
  try {
    const result = await callDeepSeek(
      [
        { role: 'system', content: buildRouterPrompt(knownFolders) },
        { role: 'user', content: request },
      ],
      ROUTER_MODEL,
    );
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return null;
    // Require at least one of the keys to be present — a JSON object with
    // neither key means the model didn't understand the contract, which is a
    // failure, not "both false".
    if (!('needs_data' in parsed) && !('needs_system' in parsed)) return null;
    return {
      needs_data: coerceBool(parsed.needs_data),
      needs_system: coerceBool(parsed.needs_system),
      folder: coerceFolder(parsed.folder, knownFolders),
      source: 'router',
    };
  } catch (err) {
    console.error('[router] classify failed:', err);
    return null;
  }
}
