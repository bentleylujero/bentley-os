import { Hono } from 'hono';
import { pool } from '../db/pool.js';

export const healthRoute = new Hono();

healthRoute.get('/health', async (c) => {
  try {
    await pool.query('SELECT 1');
    return c.json({ status: 'ok', db: 'connected', service: 'bentley-os-api' });
  } catch (err) {
    return c.json({ status: 'degraded', db: 'unreachable', error: String(err) }, 503);
  }
});
