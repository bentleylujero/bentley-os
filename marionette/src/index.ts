import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { Agent, setGlobalDispatcher } from 'undici';
import { callDeepSeek } from './deepseek.ts';
import { normalizeDecision } from './schema.ts';
import { audit } from './audit.ts';
import { SYSTEM_PROMPT } from './prompt.ts';

// contractor's /execute can run long (real OpenCode build tasks, multi-step
// tool use) — raise past undici's default 5-minute headers/body timeout so
// a legitimately slow build isn't mistaken for a dead connection.
setGlobalDispatcher(new Agent({
  headersTimeout: 600_000,
  bodyTimeout: 600_000,
}));

const app = new Hono();
app.get('/health', (c) => c.json({ status: 'ok' }));
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
    const result = await callDeepSeek([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: request },
    ]);
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
const port = 4200;
serve({ fetch: app.fetch, port });
console.log(`marionette listening on :${port}`);
