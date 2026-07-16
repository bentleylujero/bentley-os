import { Hono } from 'hono';
import { readFile } from 'node:fs/promises';
import { statfs } from 'node:fs/promises';
import http from 'node:http';
import { pool } from '../db/pool.js';

export const metricsRoute = new Hono();

// ---- HOST READER (Tier 3 / "THE SITUATION") -----------------------------
// Reads host vitals via the read-only mounts: /host/proc, /host/root, docker.sock.
// SEAM: swap these guts for a node-exporter scrape later; the shape stays the same.

async function readProcStatCpu() {
  // /proc/stat first line: cpu user nice system idle iowait irq softirq steal ...
  const txt = await readFile('/host/proc/stat', 'utf8');
  const line = txt.split('\n').find((l) => l.startsWith('cpu '));
  if (!line) return null;
  const parts = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = parts[3] + (parts[4] || 0); // idle + iowait
  const total = parts.reduce((a, b) => a + b, 0);
  return { idle, total };
}

async function cpuPercent() {
  const a = await readProcStatCpu();
  if (!a) return null;
  await new Promise((r) => setTimeout(r, 250));
  const b = await readProcStatCpu();
  if (!b) return null;
  const dTotal = b.total - a.total;
  const dIdle = b.idle - a.idle;
  if (dTotal <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((1 - dIdle / dTotal) * 100)));
}

async function memInfo() {
  const txt = await readFile('/host/proc/meminfo', 'utf8');
  const get = (k: string) => {
    const m = txt.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm'));
    return m ? Number(m[1]) : null; // kB
  };
  const total = get('MemTotal');
  const avail = get('MemAvailable');
  if (total == null || avail == null) return null;
  const usedPct = Math.round(((total - avail) / total) * 100);
  return { total_kb: total, avail_kb: avail, used_pct: usedPct };
}

async function loadAvg() {
  const txt = await readFile('/host/proc/loadavg', 'utf8');
  const p = txt.trim().split(/\s+/);
  return { one: Number(p[0]), five: Number(p[1]), fifteen: Number(p[2]) };
}

async function uptimeSeconds() {
  const txt = await readFile('/host/proc/uptime', 'utf8');
  return Math.round(Number(txt.trim().split(/\s+/)[0]));
}

async function diskInfo() {
  const s = await statfs('/host/root');
  const total = s.blocks * s.bsize;
  const free = s.bavail * s.bsize;
  const used = total - free;
  return {
    total_bytes: total,
    used_bytes: used,
    used_pct: total > 0 ? Math.round((used / total) * 100) : null,
  };
}

// Small generic GET against the docker socket, JSON-parsed. Read-only usage only.
function dockerGet(path: string, timeoutMs = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: '/var/run/docker.sock', path, method: 'GET', timeout: timeoutMs },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('docker.sock timeout')));
    req.end();
  });
}

// Per-container CPU% + mem from a single non-streamed stats snapshot.
// Docker returns pre/precpu samples in the same payload, so one call is enough.
async function containerStats(id: string): Promise<{ cpu_pct: number | null; mem: { used_bytes: number; limit_bytes: number; used_pct: number } | null }> {
  try {
    const s = await dockerGet(`/containers/${id}/stats?stream=false`, 3000);
    // CPU: delta(container) / delta(system) * onlineCPUs * 100
    let cpu_pct: number | null = null;
    const cpu = s.cpu_stats;
    const pre = s.precpu_stats;
    if (cpu && pre && cpu.cpu_usage && pre.cpu_usage) {
      const cpuDelta = cpu.cpu_usage.total_usage - pre.cpu_usage.total_usage;
      const sysDelta = (cpu.system_cpu_usage || 0) - (pre.system_cpu_usage || 0);
      const cores =
        cpu.online_cpus ||
        (cpu.cpu_usage.percpu_usage ? cpu.cpu_usage.percpu_usage.length : 1) ||
        1;
      if (sysDelta > 0 && cpuDelta >= 0) {
        cpu_pct = Math.max(0, Math.min(100, Math.round((cpuDelta / sysDelta) * cores * 100)));
      }
    }
    // MEM: usage minus cache, over limit
    let mem: { used_bytes: number; limit_bytes: number; used_pct: number } | null = null;
    const m = s.memory_stats;
    if (m && typeof m.usage === 'number' && typeof m.limit === 'number' && m.limit > 0) {
      const cache = (m.stats && (m.stats.inactive_file ?? m.stats.cache)) || 0;
      const used = Math.max(0, m.usage - cache);
      mem = {
        used_bytes: used,
        limit_bytes: m.limit,
        used_pct: Math.round((used / m.limit) * 100),
      };
    }
    return { cpu_pct, mem };
  } catch {
    return { cpu_pct: null, mem: null };
  }
}

// Docker read-only: list containers, then enrich RUNNING ones with live stats.
// No write path exists anywhere in this module.
async function listContainers(): Promise<
  Array<{
    name: string;
    state: string;
    status: string;
    cpu_pct: number | null;
    mem: { used_bytes: number; limit_bytes: number; used_pct: number } | null;
  }>
> {
  const arr = await dockerGet('/containers/json?all=true', 3000);
  const base = arr.map((c: any) => ({
    id: c.Id as string,
    name: (c.Names?.[0] || '').replace(/^\//, ''),
    state: c.State as string, // running | exited | ...
    status: c.Status as string,
  }));
  // Only running containers have meaningful stats; fetch all in parallel, each self-guarded.
  const enriched = await Promise.all(
    base.map(async (c: any) => {
      if (c.state !== 'running') {
        return { name: c.name, state: c.state, status: c.status, cpu_pct: null, mem: null };
      }
      const st = await containerStats(c.id);
      return { name: c.name, state: c.state, status: c.status, cpu_pct: st.cpu_pct, mem: st.mem };
    })
  );
  return enriched;
}

async function getHostMetrics() {
  const [cpu, mem, load, uptime, disk, containers] = await Promise.all([
    cpuPercent().catch(() => null),
    memInfo().catch(() => null),
    loadAvg().catch(() => null),
    uptimeSeconds().catch(() => null),
    diskInfo().catch(() => null),
    listContainers().catch(() => null),
  ]);
  return { cpu_pct: cpu, mem, load, uptime_sec: uptime, disk, containers };
}

metricsRoute.get('/metrics/host', async (c) => {
  try {
    const host = await getHostMetrics();
    return c.json({ ok: true, generated_at: new Date().toISOString(), host });
  } catch (e) {
    return c.json({ ok: false, host: null, error: String((e as Error).message) });
  }
});

// ---- APP READER (Tier 1+2 / "THE MONITOR") ------------------------------

metricsRoute.get('/metrics/app', async (c) => {
  try {
    const [byAction, recent, errors, counts, sync] = await Promise.all([
      pool.query(
        `SELECT action, outcome, count(*)::int AS n
           FROM audit_log GROUP BY action, outcome ORDER BY n DESC LIMIT 30`
      ),
      pool.query(
        `SELECT id, at, actor, action, outcome, target
           FROM audit_log ORDER BY at DESC LIMIT 10`
      ),
      pool.query(
        `SELECT id, at, actor, action, target, payload
           FROM audit_log WHERE outcome = 'error' ORDER BY at DESC LIMIT 8`
      ),
      pool.query(
        `SELECT
           (SELECT count(*)::int FROM emails)                                   AS emails,
           (SELECT count(*)::int FROM emails WHERE classified_at IS NULL)       AS unclassified,
           (SELECT count(*)::int FROM emails WHERE body IS NOT NULL AND embedded_at IS NULL) AS unembedded,
           (SELECT count(*)::int FROM emails WHERE embedded_at IS NOT NULL)     AS embedded,
           (SELECT count(*)::int FROM calendar_events)                          AS events,
           (SELECT count(*)::int FROM tasks WHERE status = 'open')              AS open_tasks,
           (SELECT count(*)::int FROM actions WHERE status = 'proposed')        AS pending_actions`
      ),
      pool.query(`SELECT source, updated_at FROM sync_state ORDER BY updated_at DESC`),
    ]);

    return c.json({
      ok: true,
      generated_at: new Date().toISOString(),
      by_action: byAction.rows,
      recent: recent.rows.map((r) => ({
        id: Number(r.id), at: r.at, actor: r.actor,
        action: r.action, outcome: r.outcome, target: r.target,
      })),
      errors: errors.rows.map((r) => ({
        id: Number(r.id), at: r.at, actor: r.actor, action: r.action, target: r.target,
        detail: (r.payload && (r.payload.error || r.payload.cause || r.payload.reason)) || null,
      })),
      counts: counts.rows[0],
      sync: sync.rows,
    });
  } catch (e) {
    return c.json({ ok: false, error: String((e as Error).message) });
  }
});
