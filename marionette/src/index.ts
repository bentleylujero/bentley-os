import { Hono } from 'hono';
import { serve } from '@hono/node-server';

const app = new Hono();

app.get('/health', (c) => c.json({ status: 'ok' }));

const port = 4200;
serve({ fetch: app.fetch, port });
console.log(`marionette listening on :${port}`);
