// deploy-poll.ts — poll audit_log for a deploy job's TRUE terminal outcome.
//
// Why this exists: executeAction fires POST deploy:4000/deploy and gets a 202
// ACCEPT with a job_id — NOT a completion. The real finish lands later as a
// terminal audit_log row written by the deploy service's runner. This module
// watches for that row and reports the real outcome.
//
// Terminal rows (all carry payload.job_id — confirmed in deploy/src/runner.ts):
//   deploy.succeeded       -> the deploy took, service healthy      => 'succeeded'
//   deploy.rolled_back     -> deploy unhealthy, auto-recovered      => 'failed'
//   deploy.rollback.failed -> unhealthy AND rollback failed         => 'failed'
//
// Matching is on payload->>'job_id' only (a uuid — unique, no actor filter
// needed). No writes here: pure read, same pattern as audit-read.ts.
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL || '', {
  max: 2,
  idle_timeout: 20,
});

const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 20 * 60 * 1_000; // 20 min — headroom over observed ~800s builds

export type DeployOutcome =
  | { state: 'succeeded'; action: string; commit?: string }
  | { state: 'failed'; action: string; reason: string }
  | { state: 'timeout'; reason: 'poll_timeout' };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Look for a terminal audit row for this job_id. Returns null until one exists.
async function findTerminalRow(jobId: string): Promise<DeployOutcome | null> {
  const rows = await sql<{ action: string; outcome: string | null; payload: any }[]>`
    select action, outcome, payload
    from audit_log
    where action in ('deploy.succeeded', 'deploy.rolled_back', 'deploy.rollback.failed')
      and payload->>'job_id' = ${jobId}
    order by at desc
    limit 1
  `;
  const row = rows[0];
  if (!row) return null;

  if (row.action === 'deploy.succeeded') {
    return { state: 'succeeded', action: row.action, commit: row.payload?.commit };
  }
  // rolled_back or rollback.failed — the deploy did not stick.
  return {
    state: 'failed',
    action: row.action,
    reason: row.outcome || row.action,
  };
}

// Poll until a terminal row appears or the timeout cap is hit. Always resolves
// (never rejects) — the caller must always be able to write a terminal action row.
export async function pollDeployCompletion(jobId: string): Promise<DeployOutcome> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const outcome = await findTerminalRow(jobId);
      if (outcome) return outcome;
    } catch (err) {
      // Transient DB hiccup — log and keep polling; don't abort the watch.
      console.error('[deploy-poll] query error (continuing):', err);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return { state: 'timeout', reason: 'poll_timeout' };
}
