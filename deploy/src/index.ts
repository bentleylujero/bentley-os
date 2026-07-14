import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { enqueue, getJob, listJobs } from './runner.ts';
import { pool } from './audit.ts';

const app = new Hono();

app.get('/health', async (c) => {
  try {
    await pool.query('SELECT 1');
    return c.json({ status: 'ok', db: 'connected', service: 'bentley-os-deploy' });
  } catch (err) {
    return c.json({ status: 'degraded', db: 'unreachable', error: String(err) }, 503);
  }
});

app.post('/deploy', async (c) => {
  let body: { service?: string; commit_message?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid json body; expected { "service": "api" }' }, 400);
  }
  if (!body.service) return c.json({ error: 'missing "service"' }, 400);

  const { job, error } = enqueue(body.service, body.commit_message);
  if (error) return c.json({ error }, 400);
  return c.json({ job_id: job!.id, status: job!.status, service: job!.service }, 202);
});

app.get('/deploy/:id', (c) => {
  const job = getJob(c.req.param('id'));
  if (!job) return c.json({ error: 'job not found' }, 404);
  return c.json(job);
});

app.get('/deploy', (c) => c.json({ jobs: listJobs() }));

const port = 4000;
serve({ fetch: app.fetch, port }, () => {
  console.log(`[deploy] listening on :${port}`);
});
