// question-router.ts — decides, per /think request, WHICH pre-fetch blocks the
// reasoning turn needs. Replaces the two hand-written keyword gates
// (isDataQuestion in data-gate.ts, isSystemStatusQuestion in system-sight.ts).
//
// WHY THIS EXISTS: the keyword gates were substring matches over a hand-picked
// phrase list. They failed silently and often — "what's the key promise in the
// chickens creative brief?" matched nothing, so retrieval never ran and Mari
// answered "I can't see that" while holding the document in Qdrant. Every fix
// was another guess at phrasing. See THE_BIBLE.md §8 (question-router).
//
// DESIGN: one cheap classify pass on deepseek-v4-flash, forced JSON, two
// booleans out. This is a ROUTING decision, not a reasoning one — it never sees
// the retrieved content and never writes anything.
//
// FAILURE MODE IS THE WHOLE POINT: if the router call fails, times out, or
// returns junk, we fall back to the keyword gates. Degraded = today's behavior,
// never worse than today. The gates stay in the tree for exactly this reason.
import { callDeepSeek } from './deepseek.ts';

const ROUTER_MODEL = process.env.MARIONETTE_ROUTER_MODEL || 'deepseek-v4-flash';

export interface Route {
  needs_data: boolean;
  needs_system: boolean;
  // 'router' when the model decided; 'fallback' when we degraded to keywords.
  // Surfaced in the audit payload so a silently-degrading router is visible.
  source: 'router' | 'fallback';
}

const ROUTER_PROMPT = `You are a routing classifier inside a personal homelab assistant. You do NOT answer the user's question. You decide only which data sources must be fetched before another model answers it.

Two sources exist:

1. OWNER DATA — the owner's ingested email and their uploaded documents (briefs, memos, specs, reports, plans, notes, PDFs, Word files, markdown). Set needs_data true if answering would require looking at the actual CONTENT of any email or document the owner has. This includes questions that name or allude to a specific document or message ("the chickens creative brief", "that thing I uploaded", "what does the plan say"), questions asking to find/recall/summarize/quote owner material, and questions about a topic the owner would plausibly have written down. When in doubt, set it TRUE — a wasted lookup is cheap, a missed one makes the assistant claim blindness while holding the answer.

2. SYSTEM ACTIVITY — the homelab's own audit ledger: deploys, service restarts, reasoning calls, delegations, failures, action approvals. Set needs_system true if the question is about what the SYSTEM has been doing, its health, recent work, or whether something failed or deployed.

Both can be true. Both can be false (greetings, general knowledge, math, coding requests, chit-chat).

Respond with a single JSON object and nothing else:
{"needs_data": <boolean>, "needs_system": <boolean>}`;

// Coerce whatever came back into strict booleans. A model returning "true",
// 1, or null must never become a truthy object.
function coerceBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.trim().toLowerCase() === 'true';
  if (typeof v === 'number') return v === 1;
  return false;
}

// Returns null on ANY failure — caller decides the fallback. Never throws.
export async function routeQuestion(request: string): Promise<Route | null> {
  try {
    const result = await callDeepSeek(
      [
        { role: 'system', content: ROUTER_PROMPT },
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
      source: 'router',
    };
  } catch (err) {
    console.error('[router] classify failed:', err);
    return null;
  }
}
