import { Hono } from 'hono';
import { pool } from '../db/pool.js';

export const tasksRoute = new Hono();

// POST /tasks — create a raw task. api writes the row only; marionette enriches
// it later (priority/reason) via the enrich work-queue. No interpretation here.
tasksRoute.post('/tasks', async (c) => {
  let body: { title?: unknown; notes?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid json' }, 400);
  }
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const notes = typeof body.notes === 'string' ? body.notes.trim() : null;
  if (!title) return c.json({ error: 'title required' }, 400);

  try {
    const { rows } = await pool.query(
      `insert into tasks (title, notes, source)
       values ($1, $2, 'manual')
       returning id, title, notes, status, priority, reason, category,
                 enriched_at, created_at`,
      [title, notes],
    );
    return c.json({ task: rows[0] }, 201);
  } catch (err) {
    console.error('POST /tasks failed:', err);
    return c.json({ error: 'insert failed' }, 500);
  }
});

// GET /tasks — read tasks for the panel. Optional ?status= filter
// (defaults to open). Enriched fields come back as-is (null until enriched).
tasksRoute.get('/tasks', async (c) => {
  const status = c.req.query('status') ?? 'open';
  try {
    const { rows } = await pool.query(
      `select id, title, notes, source, source_id, status, priority, reason,
              category, enriched_at, created_at
       from tasks
       where status = $1
       order by created_at desc`,
      [status],
    );
    return c.json({ tasks: rows });
  } catch (err) {
    console.error('GET /tasks failed:', err);
    return c.json({ error: 'query failed' }, 500);
  }
});

// POST /tasks/:id/done — mark a task complete. Idempotent-ish: only flips an
// 'open' row; a second call updates zero rows and reports not-actionable (409).
tasksRoute.post('/tasks/:id/done', async (c) => {
  const id = c.req.param('id');
  try {
    const { rows } = await pool.query(
      `update tasks
       set status = 'done', updated_at = now()
       where id = $1 and status = 'open'
       returning id, status`,
      [id],
    );
    if (rows.length === 0) {
      return c.json({ error: 'not actionable (missing or already done)' }, 409);
    }
    return c.json({ task: rows[0] });
  } catch (err) {
    console.error('POST /tasks/:id/done failed:', err);
    return c.json({ error: 'update failed' }, 500);
  }
});
