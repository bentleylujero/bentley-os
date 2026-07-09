import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import 'dotenv/config';
import { routes } from './routes/index.js';

const app = new Hono();

app.route('/', routes);

const port = Number(process.env.PORT) || 3000;

serve({
  fetch: app.fetch,
  port,
}, (info) => {
  console.log(`Bentley OS API listening on port ${info.port}`);
});
