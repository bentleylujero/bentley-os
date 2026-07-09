import { Hono } from 'hono';
import { basicAuth } from 'hono/basic-auth';
import { createOpencodeClient } from '@opencode-ai/sdk';

export const opencodeRoute = new Hono();

// Defense-in-depth: this route has its own Basic Auth gate, independent of
// Cloudflare Access on the dashboard hostname. Reuses OPENCODE_SERVER_PASSWORD
// as a shared secret — same value the OpenCode server itself checks.
const guardPassword = process.env.OPENCODE_SERVER_PASSWORD;
if (!guardPassword) {
  throw new Error('OPENCODE_SERVER_PASSWORD is not set — refusing to mount /opencode routes unguarded.');
}

opencodeRoute.use(
  '/opencode/*',
  basicAuth({
    username: 'bentley',
    password: guardPassword,
  })
);

// Client talking to the actual OpenCode server (systemd-managed, 127.0.0.1:4096).
// That server's own Basic Auth username defaults to "opencode" (confirmed via
// live test — do not assume blank username).
const opencode = createOpencodeClient({
  baseUrl: 'http://127.0.0.1:4096',
  headers: {
    Authorization: 'Basic ' + Buffer.from(`opencode:${guardPassword}`).toString('base64'),
  },
});

// Create a new OpenCode session.
opencodeRoute.post('/opencode/session', async (c) => {
  const { data, error } = await opencode.session.create();
  if (error) {
    return c.json({ error }, 502);
  }
  return c.json(data);
});

// Send a prompt to an existing session.
opencodeRoute.post('/opencode/session/:id/prompt', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ text: string; providerID?: string; modelID?: string }>();

  if (!body?.text) {
    return c.json({ error: 'body.text is required' }, 400);
  }

  const { data, error } = await opencode.session.prompt({
    path: { id },
    body: {
      model: body.providerID && body.modelID
        ? { providerID: body.providerID, modelID: body.modelID }
        : undefined,
      parts: [{ type: 'text', text: body.text }],
    },
  });

  if (error) {
    return c.json({ error }, 502);
  }
  return c.json(data);
});

// Proxy the OpenCode event stream as SSE, so the future dashboard can consume
// it directly without needing its own OpenCode credentials.
opencodeRoute.get('/opencode/events', async (c) => {
  const result = await opencode.event.subscribe();

  return new Response(
    new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        try {
          for await (const event of result.stream) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          }
        } catch (err) {
          controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify(String(err))}\n\n`));
        } finally {
          controller.close();
        }
      },
    }),
    {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    }
  );
});
