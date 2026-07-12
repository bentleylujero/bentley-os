// classify.ts — the Clair triage engine. Reads unclassified emails, judges
// CONSEQUENCE (what happens if this is ignored?), writes importance/category/
// reason/confidence + classified_at. Two-pass: Pass 1 judges from subject+
// snippet; Pass 2 re-judges against the full body when Pass 1 is low-confidence
// or flags high stakes. Uncertainty triggers MORE scrutiny, never silent demotion.
//
// Reasoning lives HERE (marionette), never in api's dashboard route. The
// dashboard only reads the columns this writes.

import postgres from 'postgres';
import { callDeepSeek, type ChatMessage } from './deepseek.ts';
import { audit } from './audit.ts';

const sql = postgres(process.env.DATABASE_URL || '', {
  max: 2,
  idle_timeout: 20,
});

// Pass 2 triggers: Pass 1 confidence below this, OR importance at/above the
// high-stakes cutoff (a "you're being evicted" first-glance judgement deserves
// a full-body second look before we commit it).
const LOW_CONFIDENCE = 60;
const HIGH_STAKES = 70;

const CATEGORIES = ['action', 'financial', 'personal', 'work', 'newsletter', 'receipt', 'other'] as const;
type Category = typeof CATEGORIES[number];

interface Classification {
  importance: number;   // 0..100, sort key — pure consequence
  category: Category;
  reason: string;       // the one-line "why this matters" — the whole game
  confidence: number;   // 0..100, self-assessed certainty; low => Pass 2
}

interface EmailRow {
  id: string;
  subject: string | null;
  snippet: string | null;
  body: string | null;
}

const SYSTEM = `You are Clair, a priority-triage engine for one person's inbox.
Your ONLY job: judge CONSEQUENCE. Ask "what happens to this person if they never see this email?"
That question — not the sender, not the topic, not human-vs-automated — sets importance.

An automated "your account is overdrawn" or "your lease is being terminated" outranks a
friend's "hey what's up". A newsletter, however interesting, is low consequence.

Rules:
- importance is 0..100, a pure consequence score. 80-100: real harm/cost/deadline if missed.
  40-79: matters but not urgent. 0-39: safe to ignore (newsletters, receipts, noise).
- category is EXACTLY one of: action, financial, personal, work, newsletter, receipt, other.
- reason is ONE plain-language sentence naming the concrete consequence of ignoring it.
  Not a summary — the stakes. "Miss this and your flight rebooking window closes tonight."
- confidence is 0..100: how sure you are given ONLY what you were shown. If subject+snippet
  are too thin to judge stakes, say so with LOW confidence — do not guess high.

Respond ONLY with a JSON object: {"importance": <int>, "category": "<cat>", "reason": "<sentence>", "confidence": <int>}`;

function passUserMsg(email: EmailRow, includeBody: boolean): string {
  const parts = [
    `Subject: ${email.subject ?? '(none)'}`,
    `Snippet: ${email.snippet ?? '(none)'}`,
  ];
  if (includeBody) {
    // Cap body — full marketing emails can be huge; the stakes live near the top.
    const body = (email.body ?? '').slice(0, 4000);
    parts.push(`Full body:\n${body || '(empty)'}`);
  }
  return parts.join('\n');
}

function coerce(raw: unknown): Classification {
  const o = (raw ?? {}) as Record<string, unknown>;
  let importance = Math.round(Number(o.importance));
  if (!Number.isFinite(importance)) importance = 0;
  importance = Math.max(0, Math.min(100, importance));

  let confidence = Math.round(Number(o.confidence));
  if (!Number.isFinite(confidence)) confidence = 0;
  confidence = Math.max(0, Math.min(100, confidence));

  let category = String(o.category ?? 'other') as Category;
  if (!CATEGORIES.includes(category)) category = 'other';

  const reason = typeof o.reason === 'string' ? o.reason.slice(0, 500) : '';

  return { importance, category, reason, confidence };
}

async function classifyOne(email: EmailRow): Promise<{ result: Classification; passes: number }> {
  // Pass 1 — subject + snippet only.
  const p1msgs: ChatMessage[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: passUserMsg(email, false) },
  ];
  const r1 = await callDeepSeek(p1msgs);
  const c1 = coerce(JSON.parse(r1.content));

  const needsPass2 =
    (c1.confidence < LOW_CONFIDENCE || c1.importance >= HIGH_STAKES) &&
    (email.body != null && email.body.trim() !== '');

  if (!needsPass2) {
    return { result: c1, passes: 1 };
  }

  // Pass 2 — re-judge against the full body. This is the authoritative answer.
  const p2msgs: ChatMessage[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: passUserMsg(email, true) },
  ];
  const r2 = await callDeepSeek(p2msgs);
  const c2 = coerce(JSON.parse(r2.content));
  return { result: c2, passes: 2 };
}

// Classify up to `limit` unclassified emails (newest first, via the partial
// index). Returns a per-email report. Each email audits independently — one
// bad email must not sink the batch.
export async function classifyBatch(limit: number): Promise<{
  processed: number;
  results: Array<{ id: string; ok: boolean; importance?: number; category?: string; passes?: number; error?: string }>;
}> {
  const emails = await sql<EmailRow[]>`
    select id, subject, snippet, body
    from emails
    where classified_at is null
    order by received_at desc nulls last
    limit ${limit}
  `;

  const results = [];
  for (const email of emails) {
    try {
      const { result, passes } = await classifyOne(email);
      await sql`
        update emails set
          importance    = ${result.importance},
          category      = ${result.category},
          reason        = ${result.reason},
          confidence    = ${result.confidence},
          classified_at = now()
        where id = ${email.id}
      `;
      await audit({
        action: 'marionette.classify',
        target: email.id,
        outcome: 'success',
        payload: {
          importance: result.importance,
          category: result.category,
          confidence: result.confidence,
          passes,
        },
      });
      results.push({ id: email.id, ok: true, importance: result.importance, category: result.category, passes });
    } catch (err: any) {
      const message = err?.message || String(err);
      await audit({
        action: 'marionette.classify',
        target: email.id,
        outcome: 'error',
        payload: { error: message },
      });
      results.push({ id: email.id, ok: false, error: message });
    }
  }

  return { processed: emails.length, results };
}
