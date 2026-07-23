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

// Validates a proposed action's kind+intent BEFORE any row is written.
// Single source of truth: called by POST /actions AND by /think's propose
// branch, so a malformed intent can never become a proposed row awaiting a tap
// no matter which door it came in. Returns null when valid, else an error
// string suitable for a 400.
export function validateActionIntent(
  kind: string,
  intent: Record<string, unknown>,
): string | null {
  // service-restart is target-constrained at PROPOSE time (not only at deploy):
  // the service must be one deploy can health-check + restart. Mirrors deploy's
  // SERVICE_HEALTH allow-list -- never postgres/qdrant/cloudflared.
  if (kind === 'service-restart') {
    const RESTARTABLE = ['api', 'contractor', 'marionette'];
    const svc = (intent as any)?.service;
    if (typeof svc !== 'string' || !RESTARTABLE.includes(svc)) {
      return `service-restart requires intent.service in {${RESTARTABLE.join(', ')}}`;
    }
    return null;
  }

  // update_docs is shape-constrained at PROPOSE time. Deploy re-validates and
  // enforces the line-conservation guard. Sections mirror deploy's
  // DOC_SENTINELS -- the only anchors that exist in the two doc files.
  if (kind === 'update_docs') {
    const SECTIONS = ['\u00a74', '\u00a77', '\u00a78', 'NEXT'];
    const blocks = (intent as any)?.blocks;
    if (!Array.isArray(blocks) || blocks.length === 0) {
      return 'update_docs requires a non-empty intent.blocks array';
    }
    for (const b of blocks) {
      if (!b || typeof b.section !== 'string' || !SECTIONS.includes(b.section)) {
        return `each block needs section in {${SECTIONS.join(', ')}}`;
      }
      if (typeof b.markdown !== 'string' || b.markdown.trim() === '') {
        return `block for ${b.section} needs non-empty markdown`;
      }
      if (b.markdown.includes('MARI:APPEND')) {
        return 'blocks may not contain a sentinel marker';
      }
    }
    return null;
  }

  return null;
}

// ── M5: auto-execute low-risk tier ──────────────────────────────────────────
// Risk is a property of the CODE PATH, not of a row — no risk column, no
// scoring, no shadow ontology. Adding a pair here is a commit + isolation-test
// + deploy + audit row. That IS the earned-autonomy ratchet (BIBLE §2).
// Exact match only: no globs, no wildcards, no prefix matching.
const AUTO_EXECUTE: ReadonlyArray<readonly [kind: string, target: string]> = [
  ['service-restart', 'contractor'],
];

// Kill switch. Read ONCE at module load, not per-call — flipping it requires a
// container recreate, which is the point: the revert path is an ops action, not
// a git operation. Ships OFF; turned on as a separate deliberate act.
const AUTO_EXECUTE_ENABLED = process.env.AUTO_EXECUTE_ENABLED === 'true';

// ── M5.1: auto-execute rate limiting ────────────────────────────────────────
// The allow-list says WHICH pairs may self-approve. This says WHEN they may
// not. Nothing here is new state: the counters are derived from audit_log at
// decision time, because an in-memory counter is self-defeating — a
// service-restart on marionette would clear its own breaker.
//
// Two independent trips, either one is sufficient:
//   BREAKER — the last N terminal outcomes for this pair are ALL failures.
//             Responds to the actual signal (things are broken).
//   WINDOW  — more than M auto-executes for this pair in the last hour.
//             Catches the loop the breaker is blind to: a restart that keeps
//             SUCCEEDING while never fixing the underlying problem.
//
// A trip does not remove the capability, it removes the AUTONOMY: we fall back
// to the pre-existing human-gated path (propose + Telegram buttons). Fails
// closed into the gate that already exists — no new path, no silent hole.
//
// Reset is implicit, not a mechanism: a human-approved execution that succeeds
// becomes the most recent terminal outcome and breaks the consecutive-failure
// run. The Approve tap IS the manual reset.
const BREAKER_CONSECUTIVE_FAILURES = 2;
const WINDOW_MAX = 5;
const WINDOW_MS = 3_600_000;

// Terminal classification, derived from the real ledger (verified 2026-07-23):
// an unhealthy deploy that ROLLED BACK is still a failure from the proposer's
// view — "I asked for a restart and the service ended up not healthy" — even
// though deploy successfully recovered the old container.
const TERM_SUCCESS = ['deploy.succeeded'];
const TERM_FAILURE = ['deploy.failed', 'deploy.rolled_back', 'deploy.rollback.failed'];

// Returns a reason string when the pair is rate-limited, else null.
// Any query error returns a reason (fail closed): if we cannot read the ledger
// we cannot prove the pair is safe, so we hand the decision to the human.
async function rateLimitReason(kind: string, target: string): Promise<string | null> {
  try {
    // One terminal outcome per action (the LAST audit row for its job_id —
    // rollback.started shares a job_id with its terminal row and must not win).
    const rows = await sql<{ id: number; created_at: string; term: string }[]>`
      with terminal as (
        select distinct on (a.id)
               a.id, a.created_at, al.action as term
        from actions a
        join audit_log al
          on al.payload->>'job_id' = a.result->>'job_id'
        where a.kind = ${kind}
          and coalesce(a.intent->>'service', '') = ${target}
          and al.action in ${sql([...TERM_SUCCESS, ...TERM_FAILURE])}
        order by a.id, al.at desc
      )
      select id, created_at, term from terminal order by id desc limit ${BREAKER_CONSECUTIVE_FAILURES}
    `;

    // BREAKER: need a full run of failures. Fewer rows than the threshold means
    // insufficient history to trip — a brand-new pair is not presumed broken.
    if (
      rows.length >= BREAKER_CONSECUTIVE_FAILURES &&
      rows.every((r) => TERM_FAILURE.includes(r.term))
    ) {
      return `breaker: last ${BREAKER_CONSECUTIVE_FAILURES} deploys for ${kind}/${target} failed`;
    }

    // WINDOW: count auto-approved actions for this pair in the last hour.
    // Counts APPROVALS, not outcomes — an in-flight loop must be caught while
    // it is still in flight, before any terminal row exists.
    const since = new Date(Date.now() - WINDOW_MS).toISOString();
    const [{ n }] = await sql<{ n: string }[]>`
      select count(*) as n
      from actions a
      join audit_log al
        on al.target = a.id::text
       and al.action = 'action.approved'
       and al.payload->>'by' = 'marionette'
      where a.kind = ${kind}
        and coalesce(a.intent->>'service', '') = ${target}
        and al.at > ${since}
    `;
    if (Number(n) >= WINDOW_MAX) {
      return `window: ${n} auto-executes for ${kind}/${target} in the last hour (max ${WINDOW_MAX})`;
    }

    return null;
  } catch (e: any) {
    return `rate-limit check failed: ${e?.message ?? e}`;
  }
}

// When disabled the allow-list is not consulted at all — behavior is bit-for-bit
// identical to pre-M5. Target is intent.service for every kind currently listed.
async function isAutoExecutable(
  kind: string,
  intent: Record<string, unknown>,
): Promise<{ ok: boolean; reason?: string }> {
  if (!AUTO_EXECUTE_ENABLED) return { ok: false };
  const target = (intent as any)?.service;
  if (typeof target !== 'string') return { ok: false };
  if (!AUTO_EXECUTE.some(([k, t]) => k === kind && t === target)) return { ok: false };

  const limited = await rateLimitReason(kind, target);
  if (limited) return { ok: false, reason: limited };
  return { ok: true };
}

const API_SURFACE_URL = 'http://api:3000/telegram/surface';

// Push a freshly-proposed action to Telegram. Fire-and-forget: the row is the
// ledger fact, the push is a side effect -- a Telegram failure must never
// unwind a valid proposal. Retry mirrors deploy/src/runner.ts notifyTelegram:
// if the deployed service IS api, the relay is mid-restart when we fire.
// api is the only outbound Telegram client (BIBLE S9); marionette never talks
// to Telegram directly.
async function surfaceToTelegram(id: number): Promise<void> {
  const ATTEMPTS = 8;
  const SPACING_MS = 5_000;
  const PER_ATTEMPT_TIMEOUT_MS = 4_000;

  for (let i = 1; i <= ATTEMPTS; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), PER_ATTEMPT_TIMEOUT_MS);
    try {
      const res = await fetch(`${API_SURFACE_URL}/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (res.ok) return;
      // 409 = no longer 'proposed' (handled before the push landed).
      // Terminal, not transient -- stop retrying.
      if (res.status === 409) {
        console.error(`[marionette] surface ${id}: already handled (409) -- not retrying`);
        return;
      }
      console.error(`[marionette] surface attempt ${i}/${ATTEMPTS} non-ok: HTTP ${res.status}`);
    } catch (e: any) {
      clearTimeout(t);
      console.error(`[marionette] surface attempt ${i}/${ATTEMPTS} failed:`, e?.message ?? e);
    }
    if (i < ATTEMPTS) await new Promise((r) => setTimeout(r, SPACING_MS));
  }
  console.error(`[marionette] surface GAVE UP for action ${id} -- row stands, push lost`);
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
  // Auto-tier: the gate is PASSED, never bypassed. The 'proposed' row above is
  // already committed; we now record an approval decision against it with
  // by='marionette'. Identical lifecycle, identical state machine, one extra
  // UPDATE. No Approve/Deny push — a button on an already-approved action is a
  // dead control (409 on tap). deploy owns the terminal ✅/❌ notify either way.
  const auto = await isAutoExecutable(row.kind, row.intent);
  if (auto.ok) {
    void approveAction(Number(row.id), 'marionette');
    return row;
  }
  // A rate-limit trip is a ledger fact, not a log line. The row then continues
  // down the ORIGINAL human-gated path below — unchanged, not a new branch.
  if (auto.reason) {
    await audit({
      action: 'action.autoexec_blocked',
      target: String(row.id),
      outcome: 'blocked',
      payload: { kind: row.kind, intent: row.intent, reason: auto.reason },
    });
  }

  void surfaceToTelegram(Number(row.id));
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
export async function approveAction(id: number, by: string = 'human'): Promise<{ ok: boolean; reason?: string }> {
  const rows = await sql<ActionRow[]>`
    update actions set status = 'approved', updated_at = now()
    where id = ${id} and status = 'proposed'
    returning *
  `;
  if (rows.length === 0) {
    return { ok: false, reason: 'action not found or not in proposed state' };
  }
  // WHO approved is a ledger fact, not current state — it lives in audit_log
  // payload, never as a column on actions (BIBLE §2: store each fact once).
  await audit({ action: 'action.approved', target: String(id), outcome: 'success', payload: { by } });

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

    // update_docs targets no real service — it edits markdown in the repo.
    // 'docs' is a pseudo-service that exists only to satisfy deploy's
    // allow-list gate; nothing is built, restarted, or health-polled.
    const isDocs = action.kind === 'update_docs';
    const isRestart = action.kind === 'service-restart';
    const service = isDocs ? 'docs' : (action.intent?.service as string) || 'api';

    // update_docs   -> deploy's append-only docs path (no build, no restart).
    // service-restart -> deploy's restart path (no rebuild, no commit).
    // commit_deploy (and any other kind) -> the normal build/commit path.
    const deployBody: Record<string, unknown> = { service, action_id: action.id };
    if (isDocs) {
      deployBody.kind = 'docs';
      deployBody.docs_blocks = action.intent?.blocks ?? [];
      deployBody.commit_message = action.intent?.commit_message ?? undefined;
    } else if (isRestart) {
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
