// actions.ts — the approval-gated action lifecycle (Milestone 4, gate slice).
//
// An `action` is a first-class object: a proposed side-effecting operation
// awaiting human approval. This module owns its state transitions. audit_log
// stays the append-only ledger (target = the action's id); this table holds
// current state only.
//
// Lifecycle (gate slice): proposed -> approved -> executing -> succeeded/failed
//                         proposed -> denied
// (superseded, for steering, lands later — the supersedes_id column is dormant.)
//
// Guards are strict: only a 'proposed' row can be approved or denied. A double
// tap / retry / race on the second call must no-op, never double-execute.
//
// Execute is FIRE-AND-REPORT: approve flips the row to executing, kicks the
// deploy WITHOUT awaiting it, and returns a fast ack. The detached execute
// owns its own try/catch and ALWAYS writes a terminal transition — a silent
// stuck 'executing' row is the failure mode we must never allow.
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

  // Fire-and-report: do NOT await. The detached promise owns its terminal
  // transition + audit in every path (see executeAction).
  void executeAction(rows[0]);

  return { ok: true };
}

// Execute an approved action. Detached (not awaited by approve). MUST always
// reach a terminal state — succeeded or failed — and audit it, no matter what
// throws. This is the load-bearing guarantee of fire-and-report.
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
    // Log deploy's RAW response — we do not assume its shape (see §1). The
    // first real run shows us the true JSON to build on.
    const deployResult = await res.json().catch(() => ({ unparseable: true }));

    const terminal = res.ok ? 'succeeded' : 'failed';
    await sql`
      update actions set status = ${terminal}, result = ${sql.json({ status: res.status, deploy: deployResult })}, updated_at = now()
      where id = ${action.id}
    `;
    await audit({
      action: `action.${terminal}`,
      target: String(action.id),
      outcome: res.ok ? 'success' : 'error',
      payload: { service, status: res.status, deploy: deployResult },
    });
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
