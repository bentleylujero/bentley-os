import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { callDeepSeek } from './deepseek.ts';
import { normalizeDecision } from './schema.ts';
import { audit } from './audit.ts';
import { SYSTEM_PROMPT } from './prompt.ts';

const app = new Hono();

app.get('/health', (c) => c.json({ status: 'ok' }));

// POST /think  { "request": "<what you want marionette to reason about>" }
// Calls DeepSeek, returns a structured Decision, audits the call either way.
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

    const decision = normalizeDecision(parsed);

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

    return c.json({ decision, model: result.model, usage: result.usage });
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
});

const port = 4200;
serve({ fetch: app.fetch, port });
console.log(`marionette listening on :${port}`);
