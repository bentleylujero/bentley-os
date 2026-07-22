import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { Agent, setGlobalDispatcher } from 'undici';
import { callDeepSeek } from './deepseek.ts';
import { normalizeDecision } from './schema.ts';
import { audit } from './audit.ts';
import { SYSTEM_PROMPT } from './prompt.ts';
import { createAction, listActions, getAction, approveAction, denyAction, validateActionIntent } from './actions.ts';
import { auditSummary } from './audit-read.ts';
import { classifyBatch } from './classify.ts';
import { embedBatch } from './embed.ts';
import { embedDocBatch } from './embed-doc.ts';
import { enrichBatch } from './enrich-task.ts';
import { isSystemStatusQuestion, formatAuditForPrompt } from './system-sight.ts';
import { isDataQuestion, formatRetrievalForPrompt } from './data-gate.ts';
import { retrieveContext } from './retrieve.ts';
import { readIngestState, formatIngestForPrompt } from './ingest-sight.ts';
import { routeQuestion, type Route } from './question-router.ts';
import { readHistory, writeTurn, formatHistoryForPrompt } from './memory.ts';

// contractor's /execute can run long (real OpenCode build tasks, multi-step
// tool use) — raise past undici's default 5-minute headers/body timeout so
// a legitimately slow build isn't mistaken for a dead connection.
setGlobalDispatcher(new Agent({
  headersTimeout: 600_000,
  bodyTimeout: 600_000,
}));

const app = new Hono();
app.get('/health', (c) => c.json({ status: 'ok' }));

// Mari's sight over her own ledger — read-only view of audit_log.
app.get('/audit/summary', async (c) => {
  const w = Number(c.req.query('window')) || 60;
  try {
    const summary = await auditSummary(w);
    return c.json(summary);
  } catch (err) {
    console.error('[audit/summary] failed:', err);
    return c.json({ error: 'audit read failed' }, 500);
  }
});
// POST /classify  { "limit": 20 }   (default 20)
// Runs the Clair two-pass triage over unclassified emails. Reasoning lives here;
// the dashboard only reads the columns this writes. Batch-bounded and manually
// triggered for now — cron wiring is a later slice once the output is trusted.
app.post('/classify', async (c) => {
  let body: any = {};
  try { body = await c.req.json(); } catch { /* empty body is fine */ }
  let limit = Number(body?.limit);
  if (!Number.isInteger(limit) || limit < 1) limit = 20;
  if (limit > 100) limit = 100;
  try {
    const report = await classifyBatch(limit);
    return c.json(report);
  } catch (err: any) {
    return c.json({ error: 'classify batch failed', detail: err?.message || String(err) }, 500);
  }
});


// POST /embed  { "limit": 20 }   (default 20)
// Embeds un-embedded emails (body present, embedded_at null) via OpenAI and
// upserts vectors into Qdrant. Mirrors /classify: batch-bounded, per-row audit,
// one bad row can't sink the batch. Reasoning/embedding lives here, not api.
app.post('/embed', async (c) => {
  let body: any = {};
  try { body = await c.req.json(); } catch { /* empty body is fine */ }
  let limit = Number(body?.limit);
  if (!Number.isInteger(limit) || limit < 1) limit = 20;
  if (limit > 200) limit = 200;
  try {
    const report = await embedBatch(limit);
    return c.json(report);
  } catch (err: any) {
    return c.json({ error: 'embed batch failed', detail: err?.message || String(err) }, 500);
  }
});
// POST /embed-doc  { "limit": 20 }   (default 20, cap 200)
// Chunks + embeds un-embedded documents (body present, embedded_at null) via
// Chonkie -> OpenAI, upserts chunk vectors into Qdrant's `documents` collection.
// Mirrors /embed: batch-bounded, per-DOCUMENT audit, one bad doc can't sink the
// batch. Chunking/embedding lives here, not api. First long-form source (§8).
app.post('/embed-doc', async (c) => {
  let body: any = {};
  try { body = await c.req.json(); } catch { /* empty body is fine */ }
  let limit = Number(body?.limit);
  if (!Number.isInteger(limit) || limit < 1) limit = 20;
  if (limit > 200) limit = 200;
  try {
    const report = await embedDocBatch(limit);
    return c.json(report);
  } catch (err: any) {
    return c.json({ error: 'embed-doc batch failed', detail: err?.message || String(err) }, 500);
  }
});



// POST /enrich-task  { "limit": 20 }   (default 20)
// Enriches unenriched tasks (priority/reason/category). Reasoning lives here;
// api writes the raw task row, this fills in the interpretation.
app.post('/enrich-task', async (c) => {
  let body: any = {};
  try { body = await c.req.json(); } catch { /* empty body is fine */ }
  let limit = Number(body?.limit);
  if (!Number.isInteger(limit) || limit < 1) limit = 20;
  if (limit > 100) limit = 100;
  try {
    const report = await enrichBatch(limit);
    return c.json(report);
  } catch (err: any) {
    return c.json({ error: "enrich batch failed", detail: err?.message || String(err) }, 500);
  }
});
// POST /think  { "request": "<what you want marionette to reason about>" }
// Calls DeepSeek, returns a structured Decision, audits the call either way.
// If the decision is "delegate", hands the spec to contractor and folds the
// result back into the response before returning.
app.post('/think', async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'body must be valid JSON' }, 400);
  }
  const request = body?.request;
  if (typeof request !== 'string' || request.trim() === '') {
    return c.json({ error: 'missing "request" string in body' }, 400);
  }
  // Conversation memory is OPTIONAL. Absent conversation_id = stateless,
  // byte-identical to pre-0009 behavior.
  const conversationId =
    typeof body?.conversation_id === 'string' && body.conversation_id.trim() !== ''
      ? body.conversation_id.trim()
      : null;
  let decision;
  try {
    // Mari's sight: if this reads as a system-activity question, fetch her own
    // audit ledger and inject a compact summary as a second system turn. The
    // prompt (prompt.ts) tells her to narrate from a SYSTEM ACTIVITY block when
    // present. Keyword-gated so coding/other requests are not polluted with it.
    const messages = [
      { role: 'system' as const, content: SYSTEM_PROMPT },
    ];
    // AMBIENT sight (unconditional): one short INGESTION line on EVERY /think
    // reporting when each source last synced. This is the tier that would have
    // caught the 3-day silent ingestion death — sync_state held the truth and
    // nothing read it. Not keyword-gated (unlike the two blocks below); injected
    // whether data is fresh OR stale so Mari can also affirm data IS current.
    // A degraded freshness read must never take down reasoning — same try/catch/
    // fall-through as the audit-sight read.
    try {
      const rows = await readIngestState();
      const ingestLine = formatIngestForPrompt(rows, new Date());
      if (ingestLine) {
        messages.push({ role: 'system' as const, content: ingestLine });
      }
    } catch (ingestErr) {
      console.error('[think] ingest-sight fetch failed:', ingestErr);
    }
    // ROUTING: one cheap flash classify decides which pre-fetch blocks this
    // request needs. Replaces the two hand-written keyword gates, which failed
    // silently on any phrasing not in their list (a document question that
    // never said "email" got no retrieval at all). If the router call fails we
    // fall back to those same gates — degraded is exactly today's behavior,
    // never worse. See THE_BIBLE.md §8.
    let route: Route = { needs_data: false, needs_system: false, source: 'fallback' };
    const routed = await routeQuestion(request);
    if (routed) {
      route = routed;
    } else {
      route = {
        needs_data: isDataQuestion(request),
        needs_system: isSystemStatusQuestion(request),
        source: 'fallback',
      };
    }

    if (route.needs_system) {
      try {
        const summary = await auditSummary(60);
        messages.push({ role: 'system' as const, content: formatAuditForPrompt(summary) });
      } catch (sightErr) {
        console.error('[think] audit-sight fetch failed:', sightErr);
      }
    }
    if (route.needs_data) {
      try {
        const hits = await retrieveContext(request);
        messages.push({ role: 'system' as const, content: formatRetrievalForPrompt(hits) });
      } catch (retrieveErr) {
        console.error('[think] retrieval fetch failed:', retrieveErr);
      }
    }
    // HISTORY tier: prior turns of THIS conversation, char+turn capped.
    // Pushed last (closest to the user turn) so recency reads naturally.
    // A history read failure degrades to stateless — never sinks /think.
    if (conversationId) {
      try {
        const turns = await readHistory(conversationId);
        for (const m of formatHistoryForPrompt(turns)) {
          messages.push({ role: m.role as any, content: m.content });
        }
      } catch (histErr) {
        console.error('[think] history read failed:', histErr);
      }
    }
    messages.push({ role: 'user' as const, content: request });
    const result = await callDeepSeek(messages);
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.content);
    } catch {
      parsed = { decision: 'reply', message: result.content, reasoning: '' };
    }
    decision = normalizeDecision(parsed);
    await audit({
      action: 'marionette.think',
      outcome: 'success',
      payload: {
        request,
        decision,
        model: result.model,
        usage: result.usage,
        finish_reason: result.finishReason,
        route,
        conversation_id: conversationId,
      },
    });
    // Persist the exchange. Her `message` only — never `reasoning` (scratchpad).
    // Best-effort: a memory write must not fail a successful /think.
    if (conversationId) {
      try {
        await writeTurn(conversationId, 'user', request);
        await writeTurn(conversationId, 'assistant', decision.message || '');
      } catch (memErr) {
        console.error('[think] memory write failed:', memErr);
      }
    }
  } catch (err: any) {
    const message = err?.message || String(err);
    // Failures are first-class audit events — an orchestrator whose failures are
    // invisible is worse than useless.
    await audit({
      action: 'marionette.think',
      outcome: 'error',
      payload: { request, error: message },
    });
    return c.json({ error: 'think failed', detail: message }, 502);
  }
  // PROPOSE branch: Mari reasoned that a side-effecting action is warranted.
  // This is /think's ONLY door into the action lifecycle. Before this existed,
  // a model that concluded "propose" had no legal decision value to say so --
  // normalizeDecision coerced it to 'reply' and the proposal was narrated into
  // message with NO actions row ever written (THE_BIBLE.md §8: the reply LOOKED
  // like success). The row is the truth; the prose is not.
  //
  // Still approval-gated: createAction writes status 'proposed'. Nothing here
  // executes anything -- autonomy is earned, and M5 is the tier above this.
  if (decision.decision === 'propose') {
    const kind = decision.action_kind as string;
    const intent = (decision.action_intent || {}) as Record<string, unknown>;
    const invalid = validateActionIntent(kind, intent);
    if (invalid) {
      // A model-authored intent that fails validation degrades to a reply and
      // is audited as such. We never 502 a request that reasoned correctly, and
      // we never write a malformed row.
      await audit({
        action: 'marionette.propose',
        outcome: 'error',
        payload: { request, kind, intent, error: invalid },
      });
      return c.json({
        decision: { decision: 'reply', message: decision.message, reasoning: decision.reasoning },
        propose_error: invalid,
      });
    }
    // createAction audits 'action.proposed' with target = the row id. That row
    // is the verification anchor -- never trust the reply text.
    const action = await createAction({ kind, intent });
    return c.json({ decision, action });
  }

  if (decision.decision !== 'delegate') {
    return c.json({ decision });
  }
  // Delegate branch: hand the spec to contractor, fold its result back in.
  // A failed delegation is still a successful /think — we return what we
  // know rather than 502ing a request that reasoned correctly.
  try {
    const res = await fetch('http://contractor:4100/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spec: decision.spec }),
    });
    const contractorResult = await res.json();
    await audit({
      action: 'marionette.delegate',
      outcome: res.ok ? 'success' : 'error',
      target: decision.target_service,
      payload: { spec: decision.spec, status: res.status, result: contractorResult },
    });
    return c.json({ decision, delegation: { status: res.status, result: contractorResult } });
  } catch (err: any) {
    const message = err?.message || String(err);
    const cause = err?.cause?.message || err?.cause || null;
    await audit({
      action: 'marionette.delegate',
      outcome: 'error',
      target: decision.target_service,
      payload: { spec: decision.spec, error: message, cause },
    });
    return c.json({ decision, delegation: { error: message, cause } });
  }
});

// ── Action lifecycle (Milestone 4, gate slice) ──────────────────────────────
// marionette owns the actions table's state transitions. api/Telegram relay to
// these endpoints; they do no reasoning of their own. Every transition audits
// with target = the action id.

// Propose an action. { "kind": "commit_deploy", "intent": { "service": "api" } }
app.post('/actions', async (c) => {
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'body must be valid JSON' }, 400); }
  const kind = body?.kind;
  if (typeof kind !== 'string' || kind.trim() === '') {
    return c.json({ error: 'missing "kind" string in body' }, 400);
  }
  const intent = (body?.intent && typeof body.intent === 'object') ? body.intent : {};

  // Validation lives in actions.ts so this door and /think's propose branch
  // enforce the identical rule. See validateActionIntent.
  const invalid = validateActionIntent(kind, intent);
  if (invalid) return c.json({ error: invalid }, 400);

  const row = await createAction({ kind, intent });
  return c.json({ action: row }, 201);
});

// List actions, optionally filtered: /actions?status=proposed
app.get('/actions', async (c) => {
  const status = c.req.query('status');
  const rows = await listActions(status);
  return c.json({ actions: rows });
});

// Get one action by id.
app.get('/actions/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ error: 'id must be an integer' }, 400);
  const row = await getAction(id);
  if (!row) return c.json({ error: 'not found' }, 404);
  return c.json({ action: row });
});

// Approve -> fires execute (fire-and-report; fast ack). Strict guard: only a
// 'proposed' row can be approved; a second call no-ops with 409.
app.post('/actions/:id/approve', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ error: 'id must be an integer' }, 400);
  const out = await approveAction(id);
  if (!out.ok) return c.json({ error: out.reason }, 409);
  return c.json({ ok: true, id, status: 'approved', note: 'executing — result reported when done' });
});

// Deny -> terminal. Strict guard: only a 'proposed' row can be denied.
app.post('/actions/:id/deny', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ error: 'id must be an integer' }, 400);
  const out = await denyAction(id);
  if (!out.ok) return c.json({ error: out.reason }, 409);
  return c.json({ ok: true, id, status: 'denied' });
});

const port = 4200;
serve({ fetch: app.fetch, port });
console.log(`marionette listening on :${port}`);
// task-b live test 2026-07-14T20:58:24Z
// task-b live test 2026-07-14T20:58:33Z
