// audit.ts — api's own diary. Mirrors marionette/src/audit.ts exactly (same
// audit_log shape, same fail-soft-but-loud contract) but reuses api's existing
// `pool` (pg) instead of standing up a second postgres client — api already
// has one connection pool, no need for a duplicate.
import { pool } from './pool.js';

export interface AuditRow {
  action: string;
  target?: string | null;
  outcome?: string | null;
  payload?: unknown;
}

export async function audit(row: AuditRow): Promise<void> {
  try {
    await pool.query(
      `insert into audit_log (actor, action, target, outcome, payload)
       values ('api', $1, $2, $3, $4)`,
      [row.action, row.target ?? null, row.outcome ?? null, JSON.stringify(row.payload ?? {})],
    );
  } catch (err) {
    console.error('[audit] FAILED to write audit_log row:', err);
  }
}
