import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { Agent, setGlobalDispatcher } from 'undici';
import { callDeepSeek } from './deepseek.ts';
import { normalizeDecision } from './schema.ts';
import { audit } from './audit.ts';
import { SYSTEM_PROMPT } from './prompt.ts';
import { createAction, listActions, getAction, approveAction, denyAction } from './actions.ts';
import { auditSummary } from './audit-read.ts';
import { classifyBatch } from './classify.ts';
import { embedBatch } from './embed.ts';
import { isSystemStatusQuestion, formatAuditForPrompt } from './system-sight.ts';
import { isDataQuestion, formatRetrievalForPrompt } from './data-gate.ts';
import { retrieveContext } from './retrieve.ts';

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
  let decision;
  try {
    // Mari's sight: if this reads as a system-activity question, fetch her own
    // audit ledger and inject a compact summary as a second system turn. The
    // prompt (prompt.ts) tells her to narrate from a SYSTEM ACTIVITY block when
    // present. Keyword-gated so coding/other requests are not polluted with it.
    const messages = [
      { role: 'system' as const, content: SYSTEM_PROMPT },
    ];
    if (isSystemStatusQuestion(request)) {
      try {
        const summary = await auditSummary(60);
        messages.push({ role: 'system' as const, content: formatAuditForPrompt(summary) });
      } catch (sightErr) {
        console.error('[think] audit-sight fetch failed:', sightErr);
      }
    }
    if (isDataQuestion(request)) {
      try {
        const hits = await retrieveContext(request);
        messages.push({ role: 'system' as const, content: formatRetrievalForPrompt(hits) });
      } catch (retrieveErr) {
        console.error('[think] retrieval fetch failed:', retrieveErr);
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
      },
    });
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
// gap2-fix-verification: 2026-07-14T23:18:50Z
// gap2-fix-verification: 2026-07-14T23:19:03Z
