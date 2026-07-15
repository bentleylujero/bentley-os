// enrich-task.ts — the task enrichment engine. Reads unenriched tasks (whatever
// the owner typed, or a self-email Slice B turns into a task), judges what's at
// stake, and writes priority/reason/category + enriched_at. Single-pass: a task
// is short (title + notes), so there's no subject/snippet/body split like emails.
//
// Reasoning lives HERE (marionette), never in api. api writes the raw task row;
// this fills in the interpretation. Same shape as classify.ts by design.

import postgres from 'postgres';
import { callDeepSeek, type ChatMessage } from './deepseek.ts';
import { audit } from './audit.ts';

const sql = postgres(process.env.DATABASE_URL || '', {
  max: 2,
  idle_timeout: 20,
});

// Task priority is its OWN scale — deliberately NOT the emails 0..100 importance
// score. A task is something the owner owes action on; an email is something that
// arrived. They rank within their own groups in the panel.
const PRIORITIES = ['high', 'medium', 'low'] as const;
type Priority = typeof PRIORITIES[number];

const CATEGORIES = ['errand', 'communication', 'admin', 'work', 'personal', 'other'] as const;
type Category = typeof CATEGORIES[number];

interface Enrichment {
  priority: Priority;
  reason: string;     // one-line: what's at stake / why this matters now
  category: Category;
}

interface TaskRow {
  id: string;
  title: string;
  notes: string | null;
}

const SYSTEM = `You are Clair, helping one person stay on top of what they owe action on.
You are given a TASK the person wrote for themselves (or that was pulled from a note to self).
Your job: judge how much this should be on their mind, and name what's at stake.

Rules:
- priority is EXACTLY one of: high, medium, low.
  high: real cost/deadline/consequence if it slips, or blocks something else.
  medium: matters, should get done soon, but nothing breaks if it waits a little.
  low: nice to do, no real consequence to delay.
- reason is ONE plain sentence naming the concrete stakes or the point of the task.
  Not a restatement of the title — the "why it matters" or the thing it unblocks.
  "Advisor's approval window for study-abroad closes before registration opens."
- category is EXACTLY one of: errand, communication, admin, work, personal, other.

Respond ONLY with a JSON object: {"priority": "<pri>", "reason": "<sentence>", "category": "<cat>"}`;

function userMsg(task: TaskRow): string {
  const parts = [`Task: ${task.title}`];
  if (task.notes && task.notes.trim() !== '') {
    parts.push(`Notes: ${task.notes.slice(0, 2000)}`);
  }
  return parts.join('\n');
}

function coerce(raw: unknown): Enrichment {
  const o = (raw ?? {}) as Record<string, unknown>;

  let priority = String(o.priority ?? 'medium').toLowerCase() as Priority;
  if (!PRIORITIES.includes(priority)) priority = 'medium';

  let category = String(o.category ?? 'other').toLowerCase() as Category;
  if (!CATEGORIES.includes(category)) category = 'other';

  const reason = typeof o.reason === 'string' ? o.reason.slice(0, 500) : '';

  return { priority, reason, category };
}

async function enrichOne(task: TaskRow): Promise<Enrichment> {
  const msgs: ChatMessage[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: userMsg(task) },
  ];
  const r = await callDeepSeek(msgs);
  return coerce(JSON.parse(r.content));
}

// Enrich up to `limit` unenriched tasks (newest first, via idx_tasks_unenriched).
// Per-task independent audit — one bad task must not sink the batch.
export async function enrichBatch(limit: number): Promise<{
  processed: number;
  results: Array<{ id: string; ok: boolean; priority?: string; category?: string; error?: string }>;
}> {
  const tasks = await sql<TaskRow[]>`
    select id, title, notes
    from tasks
    where enriched_at is null
    order by created_at desc
    limit ${limit}
  `;

  const results = [];
  for (const task of tasks) {
    try {
      const e = await enrichOne(task);
      await sql`
        update tasks set
          priority    = ${e.priority},
          reason      = ${e.reason},
          category    = ${e.category},
          enriched_at = now(),
          updated_at  = now()
        where id = ${task.id}
      `;
      await audit({
        action: 'marionette.enrich_task',
        target: task.id,
        outcome: 'success',
        payload: { priority: e.priority, category: e.category },
      });
      results.push({ id: task.id, ok: true, priority: e.priority, category: e.category });
    } catch (err: any) {
      const message = err?.message || String(err);
      await audit({
        action: 'marionette.enrich_task',
        target: task.id,
        outcome: 'error',
        payload: { error: message },
      });
      results.push({ id: task.id, ok: false, error: message });
    }
  }

  return { processed: tasks.length, results };
}
