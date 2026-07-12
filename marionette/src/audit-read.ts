// audit-read.ts — marionette's *sight* over her own ledger. The read side of
// audit.ts: audit.ts writes rows, this reads them back so /think can answer
// "what have you done?", "did that deploy finish?", "what failed today?".
//
// No new state, no shadow table — this only SELECTs from the one authoritative
// ledger (THE_BIBLE §2/§9: audit_log is the single ledger). Matches audit.ts's
// exact connection pattern.
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL || '', {
  max: 2,
  idle_timeout: 20,
});

// postgres serializes bigint id as a STRING — coerce on the way out so callers
// (and DeepSeek) get real numbers. (Handoff lesson: never assume numeric id.)
function coerceRow(r: Record<string, unknown>) {
  return { ...r, id: r.id != null ? Number(r.id) : r.id };
}

export interface AuditSummary {
  window_minutes: number;
  total: number;
  by_action: { action: string; outcome: string | null; count: number }[];
  recent: Record<string, unknown>[];
  failures: Record<string, unknown>[];
}

// One call that gives DeepSeek everything it needs to narrate system activity.
export async function auditSummary(windowMinutes = 60, recentLimit = 15): Promise<AuditSummary> {
  const since = `${windowMinutes} minutes`;

  const [byAction, recent, failures, totalRow] = await Promise.all([
    sql`
      select action, outcome, count(*)::int as count
      from audit_log
      where at > now() - ${since}::interval
      group by action, outcome
      order by count desc
    `,
    sql`
      select id, at, actor, action, target, outcome, payload
      from audit_log
      where at > now() - ${since}::interval
      order by at desc
      limit ${recentLimit}
    `,
    sql`
      select id, at, actor, action, target, outcome, payload
      from audit_log
      where at > now() - ${since}::interval
        and outcome = 'error'
      order by at desc
      limit ${recentLimit}
    `,
    sql`
      select count(*)::int as total
      from audit_log
      where at > now() - ${since}::interval
    `,
  ]);

  return {
    window_minutes: windowMinutes,
    total: totalRow[0]?.total ?? 0,
    by_action: byAction.map((r) => ({
      action: r.action as string,
      outcome: (r.outcome as string | null) ?? null,
      count: r.count as number,
    })),
    recent: recent.map(coerceRow),
    failures: failures.map(coerceRow),
  };
}
