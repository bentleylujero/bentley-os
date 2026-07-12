// actions.ts — the approval-gated action lifecycle (Milestone 4, gate slice).
//
// An `action` is a first-class object: a proposed side-effecting operation
// awaiting human approval. This module owns its state transitions. audit_log
// stays the append-only ledger (target = the action's id); this table holds
// current state only.
//
// Lifecycle: proposed -> approved -> executing -> succeeded/failed
//            proposed -> denied
//
// 'executing' now means what it says: the deploy has been ACCEPTED (202) but
// has NOT finished. The real terminal state (succeeded/failed) is written by
// watchDeploy, which polls audit_log for the deploy service's own terminal row
// (deploy.succeeded / deploy.rolled_back / deploy.rollback.failed) keyed on the
// job_id from the 202 accept. This closes the "action.succeeded = 202 accept,
// not real completion" gap (Bible §4, M4 Task A).
//
// Guards are strict: only a 'proposed' row can be approved or denied. A double
// tap / retry / race on the second call must no-op, never double-execute.
//
// Execute is FIRE-AND-REPORT: approve flips the row to executing, kicks the
// deploy WITHOUT awaiting it, and returns a fast ack. The detached execute +
// watchDeploy own their own terminal transition — a silent stuck 'executing'
// row is the failure mode we must never allow.
import postgres from 'postgres';
import { audit } from './audit.ts';
import { pollDeployCompletion } from './deploy-poll.ts';

const sql = postgres(process.env.DATABASE_URL || '', {
  max: 2,
  idle_timeout: 20,
});

// Where the ✅/❌ completion push goes. Marionette cannot message out itself
// (Bible §9) — it POSTs the outcome to api's internal notify relay, which owns
// the single Telegram sendMessage capability.
const API_NOTIFY_URL = 'http://api:3000/telegram/notify';

export interface ActionRow {
  id: number;
  kind: string;
  status: string;
  proposed_by: string;
  intent: Record<string, unknown>;
  briefing: string | null;
  result: Record<string, unknown>;
  supersedes_id: number | null;
  created_at: string;
  updated_at: string;
}

// Create a proposed action. Returns the new row.
export async function createAction(input: {
  kind: string;
  intent: Record<string, unknown>;
}): Promise<ActionRow> {
  const [row] = await sql<ActionRow[]>`
    insert into actions (kind, status, proposed_by, intent)
    values (${input.kind}, 'proposed', 'marionette', ${sql.json(input.intent)})
    returning *
  `;
  await audit({
    action: 'action.proposed',
    target: String(row.id),
    outcome: 'success',
    payload: { kind: row.kind, intent: row.intent },
  });
  return row;
}

export async function listActions(status?: string): Promise<ActionRow[]> {
  if (status) {
    return sql<ActionRow[]>`
      select * from actions where status = ${status} order by created_at desc
    `;
  }
  return sql<ActionRow[]>`select * from actions order by created_at desc`;
}

export async function getAction(id: number): Promise<ActionRow | null> {
  const [row] = await sql<ActionRow[]>`select * from actions where id = ${id}`;
  return row ?? null;
}

// Deny: proposed -> denied. Strict guard via WHERE status='proposed', so a
// second call affects zero rows and reports "not actionable".
export async function denyAction(id: number): Promise<{ ok: boolean; reason?: string }> {
  const rows = await sql<ActionRow[]>`
    update actions set status = 'denied', updated_at = now()
    where id = ${id} and status = 'proposed'
    returning *
  `;
  if (rows.length === 0) {
    return { ok: false, reason: 'action not found or not in proposed state' };
  }
  await audit({ action: 'action.denied', target: String(id), outcome: 'success', payload: {} });
  return { ok: true };
}

// Approve: proposed -> approved, atomically. If that transition wins (one row
// updated), kick execute WITHOUT awaiting. Returns a fast ack. The guard is the
// WHERE clause — only one caller can flip a given proposed row to approved.
export async function approveAction(id: number): Promise<{ ok: boolean; reason?: string }> {
  const rows = await sql<ActionRow[]>`
    update actions set status = 'approved', updated_at = now()
    where id = ${id} and status = 'proposed'
    returning *
  `;
  if (rows.length === 0) {
    return { ok: false, reason: 'action not found or not in proposed state' };
  }
  await audit({ action: 'action.approved', target: String(id), outcome: 'success', payload: {} });

  // Fire-and-report: do NOT await. The detached promise owns its terminal
  // transition + audit in every path (see executeAction / watchDeploy).
  void executeAction(rows[0]);

  return { ok: true };
}

// Execute an approved action. Detached (not awaited by approve). Kicks off the
// deploy, records the 202 accept, and hands off to watchDeploy for the real
// terminal transition. The row stays 'executing' until watchDeploy resolves it.
export async function executeAction(action: ActionRow): Promise<void> {
  try {
    await sql`update actions set status = 'executing', updated_at = now() where id = ${action.id}`;
    await audit({ action: 'action.executing', target: String(action.id), outcome: 'success', payload: {} });

    // First slice: kind='commit_deploy' but the git-commit half is not wired
    // yet — deploy builds from current repo state. This proves approve->deploy.
    // TODO(steering/commit): have contractor commit first, then deploy.
    const service = (action.intent?.service as string) || 'api';

    const res = await fetch('http://deploy:4000/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service }),
    });

    // Deploy returns 202 ACCEPT with a job_id — NOT completion. Parse the raw
    // response (we do not assume its shape, §1); the real terminal state lands
    // later as a deploy audit row that watchDeploy polls for.
    const deployResult: any = await res.json().catch(() => ({ unparseable: true }));

    if (!res.ok) {
      // Deploy REFUSED the job outright — immediate real failure, nothing to poll.
      await sql`
        update actions set status = 'failed', result = ${sql.json({ status: res.status, deploy: deployResult })}, updated_at = now()
        where id = ${action.id}
      `;
      await audit({
        action: 'action.failed',
        target: String(action.id),
        outcome: 'error',
        payload: { service, status: res.status, deploy: deployResult },
      });
      return;
    }

    // Accepted (202). Stay 'executing' — do NOT claim success on the accept.
    const jobId: string | undefined = deployResult?.job_id;
    await sql`
      update actions set result = ${sql.json({ accepted: res.status, job_id: jobId ?? null, deploy: deployResult })}, updated_at = now()
      where id = ${action.id}
    `;
    await audit({
      action: 'action.deploy_accepted',
      target: String(action.id),
      outcome: 'success',
      payload: { service, status: res.status, job_id: jobId ?? null },
    });

    if (!jobId) {
      // No job_id to poll — cannot confirm true completion. Fail loudly rather
      // than leave the row stuck 'executing' forever.
      await sql`update actions set status = 'failed', result = ${sql.json({ error: 'deploy accepted but returned no job_id', deploy: deployResult })}, updated_at = now() where id = ${action.id}`;
      await audit({
        action: 'action.failed',
        target: String(action.id),
        outcome: 'error',
        payload: { service, error: 'no job_id in deploy accept' },
      });
      return;
    }

    // Fire-and-report continues: detached poll owns the terminal transition.
    void watchDeploy(action.id, jobId, service);
  } catch (err: any) {
    const message = err?.message || String(err);
    const cause = err?.cause?.message || err?.cause || null;
    // Terminal-failure path: the row must NEVER be left stuck in 'executing'.
    await sql`
      update actions set status = 'failed', result = ${sql.json({ error: message, cause })}, updated_at = now()
      where id = ${action.id}
    `.catch((e) => console.error('[actions] FAILED to mark failed:', e));
    await audit({
      action: 'action.failed',
      target: String(action.id),
      outcome: 'error',
      payload: { error: message, cause },
    });
  }
}

// watchDeploy — detached. Polls audit_log (via deploy-poll) for the deploy's
// TRUE terminal outcome, writes the real terminal action state, and pushes a
// ✅/❌ to Telegram through api's notify relay. Owns its own terminal guarantee:
// even on a poll timeout it writes 'failed', never leaving the row 'executing'.
// notifyTelegram — POST the completion to api's notify relay, WITH RETRY.
// Why retry: when the deployed service IS api, the deploy tears down and
// recreates the api container — the notifier — at exactly the moment we want
// to push. A single fetch fired into that restart window drops silently
// (the connection resets before the promise cleanly rejects, so it never even
// hits a .catch). api's own health check means it's back within seconds, so we
// retry across ~40s. Each attempt has an AbortController timeout so a hung
// socket during the swap counts as a failed attempt, not an indefinite stall.
async function notifyTelegram(payload: {
  action_id: number;
  state: string;
  detail: string;
}): Promise<void> {
  const ATTEMPTS = 8;
  const SPACING_MS = 5_000;
  const PER_ATTEMPT_TIMEOUT_MS = 4_000;

  for (let i = 1; i <= ATTEMPTS; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), PER_ATTEMPT_TIMEOUT_MS);
    try {
      const res = await fetch(API_NOTIFY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, action_id: Number(payload.action_id) }),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (res.ok) return; // delivered
      console.error(`[actions] notify attempt ${i}/${ATTEMPTS} non-ok: HTTP ${res.status}`);
    } catch (e: any) {
      clearTimeout(t);
      console.error(`[actions] notify attempt ${i}/${ATTEMPTS} failed:`, e?.message ?? e);
    }
    if (i < ATTEMPTS) await new Promise((r) => setTimeout(r, SPACING_MS));
  }
  console.error('[actions] notify GAVE UP after all attempts — action terminal state stands, push lost');
}

// watchDeploy — detached. Polls audit_log (via deploy-poll) for the deploy's
// TRUE terminal outcome, writes the real terminal action state, and pushes a
// ✅/❌ to Telegram through api's notify relay (with retry — see notifyTelegram).
// Owns its own terminal guarantee: even on a poll timeout it writes 'failed',
// never leaving the row 'executing'.
async function watchDeploy(actionId: number, jobId: string, service: string): Promise<void> {
  try {
    const outcome = await pollDeployCompletion(jobId);

    const terminal = outcome.state === 'succeeded' ? 'succeeded' : 'failed';
    await sql`
      update actions set status = ${terminal}, result = ${sql.json({ job_id: jobId, outcome })}, updated_at = now()
      where id = ${actionId} and status = 'executing'
    `;
    await audit({
      action: `action.${terminal}`,
      target: String(actionId),
      outcome: terminal === 'succeeded' ? 'success' : 'error',
      payload: { service, job_id: jobId, outcome },
    });

    const detail =
      outcome.state === 'succeeded'
        ? service
        : outcome.state === 'timeout'
          ? `${service} (poll timeout)`
          : `${service} (${outcome.reason})`;
    await notifyTelegram({ action_id: actionId, state: outcome.state, detail });
  } catch (err: any) {
    const message = err?.message || String(err);
    // Never leave 'executing'. Force a terminal failed even if polling threw.
    await sql`
      update actions set status = 'failed', result = ${sql.json({ error: message, job_id: jobId })}, updated_at = now()
      where id = ${actionId} and status = 'executing'
    `.catch((e) => console.error('[actions] FAILED to mark failed (watchDeploy):', e));
    await audit({
      action: 'action.failed',
      target: String(actionId),
      outcome: 'error',
      payload: { service, job_id: jobId, error: message },
    });
    await notifyTelegram({ action_id: actionId, state: 'failed', detail: `${service} (watch error)` });
  }
}
