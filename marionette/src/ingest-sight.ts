// ingest-sight.ts — Mari's AMBIENT sight over how fresh her ingested data is.
//
// Why this exists: ingestion once died silently for 3d 8h — every 5-min tick
// failed with invalid_grant while /health stayed green and the classify/embed/
// enrich drains all reported healthy (they were draining an empty queue).
// Nothing anywhere surfaced that no new data had entered the system. sync_state.
// updated_at held the truth the whole time and nothing read it. This closes that
// gap: one short line, injected on EVERY /think, telling Mari when each source
// last synced — so she can never again answer confidently over silently-stale data.
//
// Split mirrors audit-read.ts (DB access) / system-sight.ts (pure formatting):
//   - readIngestState()      — the ONLY DB touch; read-only, never writes.
//   - formatIngestForPrompt() — PURE (no DB, no clock): `now` is passed in, which
//     is the only reason the stale path is testable without mutating production.
//
// No new table, no migration: sync_state already owns this fact (store-each-
// fact-once, THE_BIBLE §9). marionette is a strip-types service — internal
// imports use the `.ts` extension.
import postgres from 'postgres';

// Three missed 5-min ingestion ticks. Tuned high enough that a single slow tick
// never false-alarms, low enough that a genuine stall is caught within minutes.
export const STALE_AFTER_MIN = 15;

// The sources sync_state is expected to carry. Drives display order and lets the
// formatter flag a source whose row is missing entirely (never synced), which a
// row-only view could not detect. Widen this when a new ingestion source lands.
const EXPECTED_SOURCES = ['gmail', 'gcal'];

export type IngestRow = { source: string; updated_at: Date | null };

// Same connection pattern as audit-read.ts. Read-only by construction.
const sql = postgres(process.env.DATABASE_URL || '', {
  max: 2,
  idle_timeout: 20,
});

// The one DB touch. A single indexed SELECT over a handful of rows (sync_state's
// PK is `source`), in-process — deliberately cheap because this runs on every
// /think. No HTTP hop, no cross-service dependency on the reasoning path.
export async function readIngestState(): Promise<IngestRow[]> {
  const rows = await sql`
    select source, updated_at
    from sync_state
    order by source
  `;
  return rows.map((r) => ({
    source: r.source as string,
    updated_at: r.updated_at != null ? new Date(r.updated_at as string) : null,
  }));
}

// PURE: turns the rows into one compact line, or null (inject nothing). No DB,
// no Date.now() — `now` is injected so the stale path is testable with synthetic
// rows and a fixed clock. Reports per source so Mari can name WHICH source is dead.
export function formatIngestForPrompt(rows: IngestRow[], now: Date): string | null {
  // Zero rows total → we have no ambient info to offer; inject nothing rather
  // than an empty or all-dead line. (A source missing from a NON-empty set is
  // different — that one gets flagged below.)
  if (!rows || rows.length === 0) return null;

  const bySource = new Map<string, IngestRow>();
  for (const r of rows) bySource.set(r.source, r);

  // Known sources first, in a stable order, then any unexpected extras so a new
  // source is never silently dropped from the report.
  const order: string[] = [...EXPECTED_SOURCES];
  for (const r of rows) if (!order.includes(r.source)) order.push(r.source);

  const parts: string[] = [];
  for (const source of order) {
    const row = bySource.get(source);
    // Missing row or null timestamp → never synced. Both are STALE by definition.
    if (!row || row.updated_at == null) {
      parts.push(`${source} never synced (STALE)`);
      continue;
    }
    const ageMin = (now.getTime() - row.updated_at.getTime()) / 60_000;
    const stale = ageMin >= STALE_AFTER_MIN ? ' (STALE)' : '';
    parts.push(`${source} ${formatAge(ageMin)} ago${stale}`);
  }

  return `INGESTION: ${parts.join(', ')}`;
}

// Whole-minute age; sub-minute reads as "<1m" so a fresh source isn't shown as
// "0m ago". Minute-granular is enough — the threshold is minutes.
function formatAge(ageMin: number): string {
  if (ageMin < 1) return '<1m';
  return `${Math.floor(ageMin)}m`;
}
