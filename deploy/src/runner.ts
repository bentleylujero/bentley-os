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
  contractor: 'http://contractor:4100/health',
  marionette: 'http://marionette:4200/health',
  // add more as they gain HTTP health endpoints; unknown services are rejected.
};

// Repo-relative path each service's build context lives under. (Retained for
// provenance/audit only — see below. Rollback no longer touches the working
// tree at all; it swaps the preserved image instead.)
const SERVICE_PATH: Record<string, string> = {
  api: 'apps/api',
  contractor: 'contractor',
  marionette: 'marionette',
};

// The docker image name each service builds to. Derived from
// COMPOSE_PROJECT_NAME=bentley-os + the service name (confirmed via
// `docker images`: bentley-os-api, bentley-os-contractor, bentley-os-marionette).
// Rollback preservation tags <image>:latest -> <image>:rollback BEFORE building
// over :latest, so a failed build can be reverted by swapping the tag back —
// no rebuild, and critically NO `git checkout` of the working tree.
const IMAGE: Record<string, string> = {
  api: 'bentley-os-api',
  contractor: 'bentley-os-contractor',
  marionette: 'bentley-os-marionette',
};
const ROLLBACK_TAG = 'rollback';

// --- types ----------------------------------------------------------------
export type JobStatus = 'queued' | 'running' | 'success' | 'rolled_back' | 'failed';

export interface Job {
  id: string;
  service: string;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  fromCommit?: string; // last known-good commit (provenance/audit only now)
  deployedCommit?: string; // the actual commit that was built/deployed this run
  rollbackImage?: string; // the preserved <image>:rollback ref, if tagging succeeded
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
// NOTE: as of the image-swap rollback change this is used for audit/provenance
// only — the actual recovery mechanism is the preserved image, not this commit.
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

// Preserve the current :latest image as :rollback BEFORE we build over :latest.
// Returns the :rollback ref on success, or null if there's no image to preserve
// (e.g. first-ever deploy) — in which case this deploy has no image safety net,
// logged with the same honesty as a missing rollback commit.
async function preserveImage(job: Job): Promise<string | null> {
  const image = IMAGE[job.service];
  if (!image) {
    line(job, `no IMAGE entry for '${job.service}' — cannot preserve a rollback image`);
    return null;
  }
  const latest = `${image}:latest`;
  const rollback = `${image}:${ROLLBACK_TAG}`;
  const code = await run(job, 'docker', ['tag', latest, rollback]);
  if (code !== 0) {
    line(job, `could not tag ${latest} -> ${rollback} (exit ${code}) — no image rollback point for this deploy`);
    return null;
  }
  line(job, `preserved rollback image ${rollback}`);
  return rollback;
}

// Roll the RUNNING SERVICE back by swapping the preserved image tag back to
// :latest and restarting — NO rebuild, and NO working-tree git checkout. This
// is the key property: rollback recovers the artifact without ever touching the
// repo, so a freshly-committed HEAD is never clobbered by a failed build.
async function rollbackToImage(job: Job): Promise<boolean> {
  const image = IMAGE[job.service];
  const rollback = job.rollbackImage;
  if (!image || !rollback) return false;
  const latest = `${image}:latest`;
  const tagCode = await run(job, 'docker', ['tag', rollback, latest]);
  if (tagCode !== 0) {
    line(job, `rollback tag ${rollback} -> ${latest} failed (exit ${tagCode})`);
    return false;
  }
  const upCode = await run(job, 'docker', ['compose', 'up', '-d', '--no-build', job.service]);
  if (upCode !== 0) {
    line(job, `rollback up failed (exit ${upCode})`);
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
    line(job, `last known-good commit (provenance) = ${job.fromCommit}`);
  } else {
    line(job, 'last known-good commit = none');
  }

  // Preserve the current image BEFORE building over :latest. This is the
  // rollback safety net now — not a git checkout.
  job.rollbackImage = (await preserveImage(job)) ?? undefined;
  if (!job.rollbackImage) {
    line(job, 'rollback image = none — this deploy has no safety net if it fails');
  }

  job.deployedCommit = (await currentCommit()) || undefined;
  line(job, `deploying commit = ${job.deployedCommit || '(unknown)'}`);
  await audit('deploy.started', {
    target: job.service,
    outcome: 'running',
    payload: { job_id: job.id, from_commit: job.fromCommit, rollback_image: job.rollbackImage ?? null },
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

  line(job, 'deploy unhealthy — rolling back (image swap)');
  await audit('deploy.rollback.started', {
    target: job.service,
    outcome: 'unhealthy',
    payload: { job_id: job.id, from_commit: job.fromCommit, rollback_image: job.rollbackImage ?? null },
  });

  if (!job.rollbackImage) {
    job.status = 'failed';
    job.finishedAt = new Date().toISOString();
    line(job, 'no rollback image preserved — cannot auto-recover, MANUAL INTERVENTION NEEDED');
    await audit('deploy.rollback.failed', {
      target: job.service,
      outcome: 'no_rollback_image',
      payload: { job_id: job.id },
    });
    return;
  }

  const recovered = await rollbackToImage(job) && (await pollHealth(job, healthUrl));

  job.finishedAt = new Date().toISOString();
  if (recovered) {
    job.status = 'rolled_back';
    line(job, 'rolled back to preserved image — service healthy again (working tree untouched)');
    await audit('deploy.rolled_back', {
      target: job.service,
      outcome: 'recovered',
      payload: {
        job_id: job.id,
        commit: job.fromCommit,
        rollback_image: job.rollbackImage,
        deployed_commit: job.deployedCommit,
        note: 'image-swap rollback; working tree/HEAD left at deployed commit',
      },
    });
  } else {
    job.status = 'failed';
    line(job, 'ROLLBACK FAILED — service still unhealthy, MANUAL INTERVENTION NEEDED');
    await audit('deploy.rollback.failed', {
      target: job.service,
      outcome: 'still_unhealthy',
      payload: { job_id: job.id, rollback_image: job.rollbackImage },
    });
  }
}
