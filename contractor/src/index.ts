import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createOpencodeClient } from '@opencode-ai/sdk';
import { audit } from './audit.ts';

const app = new Hono();

app.get('/health', (c) => {
  return c.json({ status: 'ok', service: 'contractor' });
});

const guardPassword = process.env.OPENCODE_SERVER_PASSWORD;
if (!guardPassword) {
  throw new Error('OPENCODE_SERVER_PASSWORD is not set — refusing to mount /execute unguarded.');
}

// Reaches the systemd OpenCode server via the LAN IP — 127.0.0.1 inside this
// container means the container itself, not the host. See THE_BIBLE.md §7.
const opencode = createOpencodeClient({
  baseUrl: 'http://172.16.30.4:4096',
  headers: {
    Authorization: 'Basic ' + Buffer.from(`opencode:${guardPassword}`).toString('base64'),
  },
});

// POST /execute  { "spec": "<what to build/fix>" }
// Sandbox zone: no approval gate. Creates a fresh OpenCode session per call,
// sends the spec as a prompt, returns the result. Audited either way.
app.post('/execute', async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'body must be valid JSON' }, 400);
  }

  const spec = body?.spec;
  if (typeof spec !== 'string' || spec.trim() === '') {
    return c.json({ error: 'missing "spec" string in body' }, 400);
  }

  try {
    const session = await opencode.session.create();
    if (session.error) {
      await audit({ action: 'contractor.execute', outcome: 'error', payload: { spec, error: session.error } });
      return c.json({ error: 'session create failed', detail: session.error }, 502);
    }

    const sessionId = session.data.id;

    const result = await opencode.session.prompt({
      path: { id: sessionId },
      body: { parts: [{ type: 'text', text: spec }] },
    });

    if (result.error) {
      await audit({ action: 'contractor.execute', outcome: 'error', target: sessionId, payload: { spec, error: result.error } });
      return c.json({ error: 'prompt failed', detail: result.error }, 502);
    }

    await audit({ action: 'contractor.execute', outcome: 'success', target: sessionId, payload: { spec, result: result.data } });

    return c.json({ sessionId, result: result.data });
  } catch (err: any) {
    const message = err?.message || String(err);
    await audit({ action: 'contractor.execute', outcome: 'error', payload: { spec, error: message } });
    return c.json({ error: 'execute failed', detail: message }, 502);
  }
});

const port = 4100;
console.log(`contractor listening on port ${port}`);
serve({ fetch: app.fetch, port });
