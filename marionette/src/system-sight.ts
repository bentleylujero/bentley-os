// system-sight.ts — the bridge between Mari's raw audit *sight* (audit-read.ts)
// and her *reasoning* (/think). Two jobs, both deliberately dumb and transparent:
//   1. isSystemStatusQuestion() — a keyword gate deciding whether a given /think
//      request is asking about the homelab's own activity ("what have you done
//      today?", "did that deploy finish?", "anything failing?"). Cheap, readable,
//      easy to widen. A miss just means Mari falls back to her honest "I can't
//      see that" reply — never a wrong answer, only a missed one.
//   2. formatAuditForPrompt() — turns auditSummary()'s structured output into a
//      COMPACT text block for injection. We do NOT dump raw rows: payload jsonb is
//      big and noisy (nested decision/usage/spec). We narrate counts + trimmed
//      one-liners so DeepSeek sees signal, not noise.
//
// No new state, no DB access here — this only shapes what audit-read.ts already
// read. Reasoning stays in /think; this is pure formatting + a gate.
import type { AuditSummary } from './audit-read.ts';

// Keyword gate. Lowercased substring match against a small, hand-picked set of
// phrases that reliably signal "the owner is asking about system activity."
// Intentionally conservative: better to miss and fall back to the honest reply
// than to fire on a coding request and pollute it with audit noise.
const STATUS_PATTERNS: string[] = [
  'what have you done',
  'what did you do',
  'what happened',
  'done today',
  'done lately',
  'done recently',
  'up to today',
  'system status',
  'status update',
  'health of the system',
  'anything fail',
  'anything failing',
  'any failures',
  'what failed',
  'did the deploy',
  'did that deploy',
  'deploy finish',
  'deploy succeed',
  'last deploy',
  'recent deploy',
  'recent activity',
  'recent actions',
  'what actions',
  'what have you been',
  'how are things',
  "what's going on",
  'whats going on',
];

export function isSystemStatusQuestion(request: string): boolean {
  const q = request.toLowerCase();
  return STATUS_PATTERNS.some((p) => q.includes(p));
}

// Compact, human-readable narration of the audit window. Kept small on purpose —
// this goes into the system prompt, so every line costs tokens and noise hurts.
export function formatAuditForPrompt(s: AuditSummary): string {
  const lines: string[] = [];
  lines.push(
    `SYSTEM ACTIVITY (last ${s.window_minutes} min, ${s.total} total audit event${s.total === 1 ? '' : 's'}):`,
  );

  if (s.total === 0) {
    lines.push('  (no activity recorded in this window)');
    return lines.join('\n');
  }

  lines.push('  Counts by action/outcome:');
  for (const b of s.by_action) {
    lines.push(`    - ${b.action} [${b.outcome ?? 'null'}]: ${b.count}`);
  }

  if (s.recent.length > 0) {
    lines.push(`  Most recent (newest first, up to ${s.recent.length}):`);
    for (const r of s.recent) {
      lines.push(`    - ${trimRow(r)}`);
    }
  }

  if (s.failures.length > 0) {
    lines.push(`  FAILURES (${s.failures.length}):`);
    for (const f of s.failures) {
      lines.push(`    - ${trimRow(f, true)}`);
    }
  } else {
    lines.push('  No failures in this window.');
  }

  return lines.join('\n');
}

// One audit row → one short line. Pulls a couple of useful crumbs out of payload
// (request text, job_id) without dumping the whole jsonb blob.
function trimRow(r: Record<string, unknown>, includeError = false): string {
  const at = shortTime(r.at);
  const actor = (r.actor as string) ?? '?';
  const action = (r.action as string) ?? '?';
  const outcome = (r.outcome as string | null) ?? 'null';
  const target = r.target != null ? ` target=${r.target}` : '';

  const payload = (r.payload ?? {}) as Record<string, unknown>;
  const crumbs: string[] = [];
  if (typeof payload.request === 'string') {
    crumbs.push(`req="${truncate(payload.request, 60)}"`);
  }
  if (typeof payload.job_id === 'string') {
    crumbs.push(`job=${payload.job_id}`);
  }
  if (includeError && typeof payload.error === 'string') {
    crumbs.push(`error="${truncate(payload.error, 80)}"`);
  }
  const crumbStr = crumbs.length ? ` (${crumbs.join(', ')})` : '';

  return `${at} ${actor}.${action} [${outcome}]${target}${crumbStr}`;
}

function shortTime(at: unknown): string {
  if (at == null) return '?';
  try {
    const d = new Date(at as string);
    return d.toISOString().slice(11, 16);
  } catch {
    return String(at);
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
