import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 4,
});

// Matches public.audit_log exactly: actor, action, target, outcome (text), payload (jsonb).
// id and at are auto-generated. Never throws into the caller — a failed audit write must
// not crash a deploy; we log to stderr and move on.
export async function audit(
  action: string,
  opts: {
    target?: string;
    outcome?: string;
    payload?: Record<string, unknown>;
  } = {},
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO audit_log (actor, action, target, outcome, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [
        'deploy-service',
        action,
        opts.target ?? null,
        opts.outcome ?? null,
        JSON.stringify(opts.payload ?? {}),
      ],
    );
  } catch (err) {
    console.error('[audit] write failed:', String(err));
  }
}
