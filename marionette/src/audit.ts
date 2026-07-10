// audit.ts — marionette's own diary. Writes rows to audit_log, matching the
// pattern the deploy service already uses. (Open question logged in 02_DECISIONS:
// unify all services' audit writes into one shared module later.)
//
// Fails SOFT but LOUD: a broken audit write must not 500 a request, but it must
// never be silent — a silent audit failure is worse than a noisy one.

import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL || '', {
  max: 2,
  idle_timeout: 20,
});

export interface AuditRow {
  action: string;
  target?: string | null;
  outcome?: string | null;
  payload?: unknown;
}

export async function audit(row: AuditRow): Promise<void> {
  try {
    await sql`
      insert into audit_log (actor, action, target, outcome, payload)
      values (
        'marionette',
        ${row.action},
        ${row.target ?? null},
        ${row.outcome ?? null},
        ${sql.json((row.payload ?? {}) as object)}
      )
    `;
  } catch (err) {
    console.error('[audit] FAILED to write audit_log row:', err);
  }
}
