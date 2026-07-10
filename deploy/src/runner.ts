import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { audit, pool } from './audit.ts';

// --- config ---------------------------------------------------------------
const REPO_DIR = '/home/spaghettios/bentley-os'; // the bind-mounted ~/bentley-os
const HEALTH_RETRIES = 12; // ~12 * 5s = 60s max wait for a service to come healthy
const HEALTH_INTERVAL_MS = 5000;

// Services this deploy service is allowed to build/restart, mapped to their in-network
// health URL. If a service has no HTTP health endpoint, set url to null -> we fall back
// to `docker compose ps` state instead of an HTTP probe.
const SERVICE_HEALTH: Record<string, string | null> = {
  api: 'http://api:3000/health',
  opencode: 'http://opencode:4100/health',
  // add more as they gain HTTP health endpoints; unknown services are rejected.
};

// --- types ----------------------------------------------------------------
export type JobStatus = 'queued' | 'running' | 'success' | 'rolled_back' | 'failed';

export interface Job {
  id: string;
  service: string;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  fromCommit?: string; // rollback target captured before build
  deployedCommit?: string; // the actual commit that was built/deployed this run
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

export function enqueue(service: string): { job?: Job; error?: string } {
  if (!(service in SERVICE_HEALTH)) {
    return { error: `unknown service '${service}'. allowed: ${Object.keys(SERVICE_HEALTH).join(', ')}` };
  }
  const job: Job = {
    id: randomUUID(),
    service,
    status: 'queued',
    createdAt: new Date().toISOString(),
    log: [],
  };
  jobs.set(job.id, job);
  queue.push(job.id);
  void audit('deploy.enqueued', { target: service, outcome: 'queued', payload: { job_id: job.id } });
  void pump();
  return { job };
}

// --- serialized worker: exactly one deploy runs at a time -----------------
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

// run a command in REPO_DIR, streaming output into the job log. resolves with exit code.
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

async function currentCommit(): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('git', ['rev-parse', 'HEAD'], { cwd: REPO_DIR });
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.on('close', () => resolve(out.trim()));
    child.on('error', () => resolve(''));
  });
}

// The rollback target must be the last commit that was actually verified healthy for
// THIS service — never "whatever HEAD is right now," since HEAD may already be the
// broken commit we're deploying. Source of truth: audit_log, not git alone.
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

  job.deployedCommit = (await currentCommit()) || undefined;
  line(job, `deploying commit = ${job.deployedCommit || '(unknown)'}`);
  await audit('deploy.started', {
    target: job.service,
    outcome: 'running',
    payload: { job_id: job.id, from_commit: job.fromCommit },
  });

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
    return;
  }

  await run(job, 'git', ['checkout', job.fromCommit, '--', '.']);
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
  } else {
    job.status = 'failed';
    line(job, 'ROLLBACK FAILED — service still unhealthy, MANUAL INTERVENTION NEEDED');
    await audit('deploy.rollback.failed', {
      target: job.service,
      outcome: 'still_unhealthy',
      payload: { job_id: job.id, commit: job.fromCommit },
    });
  }
}
