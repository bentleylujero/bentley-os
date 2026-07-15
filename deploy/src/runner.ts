import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { audit, pool } from './audit.ts';

const REPO_DIR = '/home/spaghettios/bentley-os';
const HEALTH_RETRIES = 12;
const HEALTH_INTERVAL_MS = 5000;

// Where the ✅/❌ completion push goes. deploy cannot message out itself
// (Bible §9) — it POSTs the outcome to api's internal notify relay, which owns
// the single Telegram sendMessage capability. Moved here from marionette:
// deploy is the one service that can't be torn down by a job it runs, so it is
// the correct place to write an action's TRUE terminal state + push.
const API_NOTIFY_URL = 'http://api:3000/telegram/notify';

const SERVICE_HEALTH: Record<string, string | null> = {
  api: 'http://api:3000/health',
  contractor: 'http://contractor:4100/health',
  marionette: 'http://marionette:4200/health',
};

const SERVICE_PATH: Record<string, string> = {
  api: 'apps/api',
  contractor: 'contractor',
  marionette: 'marionette',
};

const GIT_IDENTITY = ['-c', 'user.name=Bentley OS', '-c', 'user.email=bentley.lujero@gmail.com'];

export type JobStatus = 'queued' | 'running' | 'success' | 'rolled_back' | 'failed';

export interface Job {
  id: string;
  service: string;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  fromCommit?: string;
  deployedCommit?: string;
  commitMessage?: string;
  actionId?: number;
  log: string[];
}

const jobs = new Map<string, Job>();
const queue: string[] = [];
let working = false;

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function listJobs(): Job[] {
  return [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function enqueue(
  service: string,
  commitMessage?: string,
  actionId?: number,
): { job?: Job; error?: string } {
  if (!(service in SERVICE_HEALTH)) {
    return { error: `unknown service '${service}'. allowed: ${Object.keys(SERVICE_HEALTH).join(', ')}` };
  }
  const job: Job = {
    id: randomUUID(),
    service,
    status: 'queued',
    createdAt: new Date().toISOString(),
    commitMessage,
    actionId,
    log: [],
  };
  jobs.set(job.id, job);
  queue.push(job.id);
  void audit('deploy.enqueued', {
    target: service,
    outcome: 'queued',
    payload: { job_id: job.id, commit_message: commitMessage ?? null, action_id: actionId ?? null },
  });
  void pump();
  return { job };
}

async function pump(): Promise<void> {
  if (working) return;
  working = true;
  try {
    while (queue.length) {
      const id = queue.shift()!;
      const job = jobs.get(id);
      if (!job) continue;
      await runJob(job);
    }
  } finally {
    working = false;
  }
}

function line(job: Job, s: string): void {
  const stamped = `[${new Date().toISOString()}] ${s}`;
  job.log.push(stamped);
  console.log(`(${job.id.slice(0, 8)}) ${s}`);
}

function run(job: Job, cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    line(job, `$ ${cmd} ${args.join(' ')}`);
    const child = spawn(cmd, args, { cwd: REPO_DIR });
    const onData = (d: Buffer) => {
      for (const l of d.toString().split('\n')) if (l.trim()) line(job, l);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', (code) => resolve(code ?? -1));
    child.on('error', (e) => {
      line(job, `spawn error: ${String(e)}`);
      resolve(-1);
    });
  });
}

function capture(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: REPO_DIR });
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.on('close', () => resolve(out.trim()));
    child.on('error', () => resolve(''));
  });
}

async function currentCommit(): Promise<string> {
  return capture('git', ['rev-parse', 'HEAD']);
}

async function lastGoodCommit(job: Job, service: string): Promise<string | null> {
  try {
    const res = await pool.query<{ payload: { commit?: string } }>(
      `SELECT payload FROM audit_log
       WHERE actor = 'deploy-service' AND action = 'deploy.succeeded' AND target = $1
       ORDER BY at DESC LIMIT 1`,
      [service],
    );
    const commit = res.rows[0]?.payload?.commit;
    if (!commit) {
      line(job, `no prior successful deploy found for '${service}' in audit_log — no rollback baseline exists`);
      return null;
    }
    return commit;
  } catch (e) {
    line(job, `failed to query last-good commit from audit_log: ${String(e)}`);
    return null;
  }
}

// resolveAction — write an action-originated job's TRUE terminal state, then
// push the ✅/❌ to Telegram. Called at EVERY terminal branch of runJob.
//
// - Gated on job.actionId: a raw POST /deploy (no action_id) touches nothing.
// - Strict guard `WHERE id=$1 AND status='executing'`: a row already resolved
//   (manual fix, retry, race) updates zero rows — idempotent, never double-writes.
// - UPDATE fires once (Postgres survives every service deploy — no retry needed).
// - Notify is detached best-effort WITH retry (api may be mid-restart if the job
//   IS api) — a lost push never stalls the queue; the action row is already
//   correctly terminal by the time notify runs.
// - Called AFTER the branch's audit() write: audit_log is the authoritative
//   ledger (§4), the actions table is derived current-state. Ledger first.
async function resolveAction(
  job: Job,
  terminal: 'succeeded' | 'failed',
  detail: string,
): Promise<void> {
  if (!job.actionId) return;
  try {
    const res = await pool.query(
      `UPDATE actions SET status = $1, updated_at = now()
       WHERE id = $2 AND status = 'executing' RETURNING id`,
      [terminal, job.actionId],
    );
    if (res.rowCount === 0) {
      line(job, `action ${job.actionId} not in 'executing' — no terminal write (already resolved?)`);
    } else {
      line(job, `action ${job.actionId} -> ${terminal}`);
    }
  } catch (e) {
    line(job, `FAILED to write terminal action state for action ${job.actionId}: ${String(e)}`);
  }
  void notifyTelegram({ action_id: job.actionId, state: terminal, detail });
}

// notifyTelegram — POST the completion to api's notify relay, WITH RETRY.
// Ported from marionette's old watchDeploy notifier. Why retry: when the
// deployed service IS api, the deploy tears down and recreates the api
// container — the notifier — at exactly the moment we push. A single fetch
// fired into that restart window drops silently. api is back within seconds
// (health-gated), so we retry across ~40s. Each attempt has an AbortController
// timeout so a hung socket during the swap is a failed attempt, not a stall.
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
      console.error(`[deploy] notify attempt ${i}/${ATTEMPTS} non-ok: HTTP ${res.status}`);
    } catch (e: any) {
      clearTimeout(t);
      console.error(`[deploy] notify attempt ${i}/${ATTEMPTS} failed:`, e?.message ?? e);
    }
    if (i < ATTEMPTS) await new Promise((r) => setTimeout(r, SPACING_MS));
  }
  console.error('[deploy] notify GAVE UP after all attempts — action terminal state stands, push lost');
}

async function commitAndPush(
  job: Job,
  scopePath: string,
  message: string,
): Promise<'ok' | 'diverged' | 'nothing' | 'push_failed' | 'commit_failed'> {
  const fetchCode = await run(job, 'git', ['fetch', 'origin', 'main']);
  if (fetchCode !== 0) {
    line(job, 'git fetch failed — refusing to commit/push without fresh origin state');
    return 'push_failed';
  }

  const behindCount = await capture('git', ['rev-list', 'HEAD..origin/main', '--count']);
  if (behindCount !== '0') {
    line(job, `origin/main has ${behindCount} commit(s) not in local HEAD — refusing to commit/push, manual intervention needed (pull/rebase first)`);
    return 'diverged';
  }

  await run(job, 'git', ['add', scopePath]);
  const status = await capture('git', ['status', '--porcelain', '--', scopePath]);
  if (!status) {
    line(job, 'nothing to commit in scope path — skipping commit, proceeding to build');
    return 'nothing';
  }

  const commitCode = await run(job, 'git', [...GIT_IDENTITY, 'commit', '-m', message, '--', scopePath]);
  if (commitCode !== 0) return 'commit_failed';

  const pushCode = await run(job, 'git', ['push', 'origin', 'main']);
  if (pushCode !== 0) return 'push_failed';
  return 'ok';
}

async function pollHealth(job: Job, url: string | null): Promise<boolean> {
  if (url === null) {
    const code = await run(job, 'docker', ['compose', 'ps', '--status=running', job.service]);
    return code === 0;
  }
  for (let i = 1; i <= HEALTH_RETRIES; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (res.ok) {
        line(job, `health ok (${res.status}) on attempt ${i}`);
        return true;
      }
      line(job, `health ${res.status} on attempt ${i}/${HEALTH_RETRIES}`);
    } catch (e) {
      line(job, `health unreachable attempt ${i}/${HEALTH_RETRIES}: ${String(e)}`);
    }
    if (i < HEALTH_RETRIES) await new Promise((r) => setTimeout(r, HEALTH_INTERVAL_MS));
  }
  return false;
}

async function buildAndUp(job: Job): Promise<boolean> {
  const b = await run(job, 'docker', ['compose', 'build', job.service]);
  if (b !== 0) {
    line(job, `build failed (exit ${b})`);
    return false;
  }
  const u = await run(job, 'docker', ['compose', 'up', '-d', job.service]);
  if (u !== 0) {
    line(job, `up failed (exit ${u})`);
    return false;
  }
  return true;
}

async function runJob(job: Job): Promise<void> {
  job.status = 'running';
  job.startedAt = new Date().toISOString();
  const healthUrl = SERVICE_HEALTH[job.service];

  job.fromCommit = (await lastGoodCommit(job, job.service)) ?? undefined;
  if (job.fromCommit) {
    line(job, `rollback target (last known-good) = ${job.fromCommit}`);
  } else {
    line(job, 'rollback target = none — this deploy has no safety net if it fails');
  }

  await audit('deploy.started', {
    target: job.service,
    outcome: 'running',
    payload: { job_id: job.id, from_commit: job.fromCommit, action_id: job.actionId ?? null },
  });

  if (job.commitMessage) {
    const scopePath = SERVICE_PATH[job.service];
    const result = await commitAndPush(job, scopePath, job.commitMessage);
    await audit(`deploy.commit.${result}`, {
      target: job.service,
      outcome: result === 'ok' || result === 'nothing' ? 'success' : 'error',
      payload: { job_id: job.id },
    });
    if (result === 'diverged' || result === 'commit_failed' || result === 'push_failed') {
      job.status = 'failed';
      job.finishedAt = new Date().toISOString();
      line(job, `commit/push step failed (${result}) — aborting before build, nothing deployed`);
      await resolveAction(job, 'failed', `${job.service} (commit ${result})`);
      return;
    }
  }

  job.deployedCommit = (await currentCommit()) || undefined;
  line(job, `deploying commit = ${job.deployedCommit || '(unknown)'}`);

  const upOk = await buildAndUp(job);
  const healthy = upOk && (await pollHealth(job, healthUrl));

  if (healthy) {
    job.status = 'success';
    job.finishedAt = new Date().toISOString();
    line(job, 'deploy healthy — success');
    await audit('deploy.succeeded', {
      target: job.service,
      outcome: 'success',
      payload: { job_id: job.id, commit: job.deployedCommit },
    });
    await resolveAction(job, 'succeeded', job.service);
    return;
  }

  line(job, 'deploy unhealthy — rolling back');
  await audit('deploy.rollback.started', {
    target: job.service,
    outcome: 'unhealthy',
    payload: { job_id: job.id, from_commit: job.fromCommit },
  });

  if (!job.fromCommit) {
    job.status = 'failed';
    job.finishedAt = new Date().toISOString();
    line(job, 'no rollback commit captured — cannot auto-recover, MANUAL INTERVENTION NEEDED');
    await audit('deploy.rollback.failed', {
      target: job.service,
      outcome: 'no_rollback_point',
      payload: { job_id: job.id },
    });
    await resolveAction(job, 'failed', `${job.service} (unhealthy, no rollback point)`);
    return;
  }

  const scopePath = SERVICE_PATH[job.service];
  if (!scopePath) {
    job.status = 'failed';
    job.finishedAt = new Date().toISOString();
    line(job, `no SERVICE_PATH entry for '${job.service}' — refusing repo-wide rollback, MANUAL INTERVENTION NEEDED`);
    await audit('deploy.rollback.failed', {
      target: job.service,
      outcome: 'no_scope_path',
      payload: { job_id: job.id, from_commit: job.fromCommit },
    });
    await resolveAction(job, 'failed', `${job.service} (unhealthy, no scope path)`);
    return;
  }
  if (process.env.DRY_RUN === '1') {
    line(job, `[dry-run] would: git checkout ${job.fromCommit} -- ${scopePath}`);
  } else {
    await run(job, 'git', ['checkout', job.fromCommit, '--', scopePath]);
  }
  const recovered = (await buildAndUp(job)) && (await pollHealth(job, healthUrl));

  job.finishedAt = new Date().toISOString();
  if (recovered) {
    job.status = 'rolled_back';
    line(job, 'rolled back to last-good commit — service healthy again');
    await audit('deploy.rolled_back', {
      target: job.service,
      outcome: 'recovered',
      payload: { job_id: job.id, commit: job.fromCommit },
    });
    // rolled_back => the deploy the action asked for did NOT stick => action failed.
    await resolveAction(job, 'failed', `${job.service} (rolled back to last-good)`);
  } else {
    job.status = 'failed';
    line(job, 'ROLLBACK FAILED — service still unhealthy, MANUAL INTERVENTION NEEDED');
    await audit('deploy.rollback.failed', {
      target: job.service,
      outcome: 'still_unhealthy',
      payload: { job_id: job.id, commit: job.fromCommit },
    });
    await resolveAction(job, 'failed', `${job.service} (rollback FAILED, still unhealthy)`);
  }
}
