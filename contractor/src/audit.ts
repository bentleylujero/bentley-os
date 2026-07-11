// audit.ts — contractor's diary. Same pattern as marionette/src/audit.ts.
// Fails SOFT but LOUD: a broken audit write must not 500 a request, but it
// must never be silent.

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
        'contractor',
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
