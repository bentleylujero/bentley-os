// actions.ts — the approval-gated action lifecycle (Milestone 4).
//
// An `action` is a first-class object: a proposed side-effecting operation
// awaiting human approval. This module owns its state transitions UP TO the
// point the work is handed to deploy. audit_log stays the append-only ledger
// (target = the action's id); this table holds current state only.
//
// Lifecycle: proposed -> approved -> executing -> succeeded/failed
//            proposed -> denied
//
// TERMINAL-WRITE OWNERSHIP (M4 Gap 1 fix): once the deploy is ACCEPTED (202),
// this module's job is DONE. The row stays 'executing'; the TRUE terminal state
// (succeeded/failed) + the ✅/❌ Telegram push are written by the DEPLOY service
// itself, in its own runner, at the exact moment it knows the real outcome.
//
// Why deploy and not here: a commit_deploy targeting service:"marionette" tears
// down THIS container mid-work — a watcher polling from here dies with it and
// the row is stranded 'executing' forever (the bug this fix closes). deploy is
// structurally immune: nothing can target service:"deploy" for a job, so it can
// never be killed by a job it runs. It also holds the outcome firsthand, so
// there is no polling and no race window at all.
//
// Guards are strict: only a 'proposed' row can be approved or denied. A double
// tap / retry / race on the second call must no-op, never double-execute.
//
// Execute is FIRE-AND-REPORT: approve flips the row to executing, kicks the
// deploy WITHOUT awaiting it, and returns a fast ack.
import postgres from 'postgres';
import { audit } from './audit.ts';

const sql = postgres(process.env.DATABASE_URL || '', {
  max: 2,
  idle_timeout: 20,
});

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

  // Fire-and-report: do NOT await. The detached promise flips the row to
  // 'executing' and hands off to deploy, which owns the terminal transition.
  void executeAction(rows[0]);

  return { ok: true };
}

// Execute an approved action. Detached (not awaited by approve). Flips the row
// to 'executing', kicks off the deploy (passing action_id so deploy can write
// the terminal state itself), records the 202 accept, and RETURNS. The row
// stays 'executing' until deploy resolves it in its own runner.
//
// The only terminal writes THIS function still makes are for failures that
// happen BEFORE deploy accepts the job (deploy refuses / unreachable / no
// job_id) — cases deploy never sees, so it can't resolve them. Once deploy
// has accepted (202), deploy owns every remaining outcome.
export async function executeAction(action: ActionRow): Promise<void> {
  try {
    await sql`update actions set status = 'executing', updated_at = now() where id = ${action.id}`;
    await audit({ action: 'action.executing', target: String(action.id), outcome: 'success', payload: {} });

    const service = (action.intent?.service as string) || 'api';

    // service-restart -> deploy's restart path (no rebuild, no commit).
    // commit_deploy (and any other kind) -> the normal build/commit path.
    const isRestart = action.kind === 'service-restart';
    const deployBody: Record<string, unknown> = { service, action_id: action.id };
    if (isRestart) {
      deployBody.kind = 'restart';
    } else {
      deployBody.commit_message = action.intent?.commit_message ?? undefined;
    }

    const res = await fetch('http://deploy:4000/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(deployBody),
    });

    // Deploy returns 202 ACCEPT with a job_id — NOT completion. Parse the raw
    // response (we do not assume its shape, §1). On accept, deploy now owns the
    // terminal write; this function's work is done.
    const deployResult: any = await res.json().catch(() => ({ unparseable: true }));

    if (!res.ok) {
      // Deploy REFUSED the job outright — immediate real failure. deploy never
      // took ownership, so we write the terminal state here.
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

    // Accepted (202). Record the job_id and STAY 'executing' — deploy will
    // write the real terminal state (succeeded/failed) + push to Telegram.
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
      // No job_id means deploy can't be correlated to this action — deploy's
      // resolveAction is gated on action_id, not job_id, so it WILL still
      // resolve; but a missing job_id signals something malformed. Fail loudly
      // here rather than trust an unverifiable accept.
      await sql`update actions set status = 'failed', result = ${sql.json({ error: 'deploy accepted but returned no job_id', deploy: deployResult })}, updated_at = now() where id = ${action.id} and status = 'executing'`;
      await audit({
        action: 'action.failed',
        target: String(action.id),
        outcome: 'error',
        payload: { service, error: 'no job_id in deploy accept' },
      });
      return;
    }

    // Accepted with a job_id. Done — deploy owns the terminal transition.
  } catch (err: any) {
    const message = err?.message || String(err);
    const cause = err?.cause?.message || err?.cause || null;
    // Pre-accept failure (deploy unreachable, etc.) — deploy never took
    // ownership, so the row must NEVER be left stuck 'executing'. Guard on
    // status so we don't stomp a terminal state deploy may have already written.
    await sql`
      update actions set status = 'failed', result = ${sql.json({ error: message, cause })}, updated_at = now()
      where id = ${action.id} and status = 'executing'
    `.catch((e) => console.error('[actions] FAILED to mark failed:', e));
    await audit({
      action: 'action.failed',
      target: String(action.id),
      outcome: 'error',
      payload: { error: message, cause },
    });
  }
}
