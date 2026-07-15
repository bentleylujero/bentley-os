// enrich-task.ts — task insight engine. The OWNER sets priority on creation;
// marionette does NOT judge or overwrite priority. Its job is to ADD insight:
// a one-line `reason` (what's at stake / what this unblocks) and a `category`.
// Augments the owner's judgement, never overrides it.
//
// Reasoning lives HERE (marionette), never in api. api writes the raw task row
// (title/notes/priority); this fills in reason/category. Mirrors classify.ts.

import postgres from 'postgres';
import { callDeepSeek, type ChatMessage } from './deepseek.ts';
import { audit } from './audit.ts';

const sql = postgres(process.env.DATABASE_URL || '', {
  max: 2,
  idle_timeout: 20,
});

const CATEGORIES = ['errand', 'communication', 'admin', 'work', 'personal', 'other'] as const;
type Category = typeof CATEGORIES[number];

interface Enrichment {
  reason: string;     // one-line: what's at stake / what this unblocks
  category: Category;
}

interface TaskRow {
  id: string;
  title: string;
  notes: string | null;
  priority: string | null;   // owner-set; passed to the model as context only
}

const SYSTEM = `You are Clair, helping one person stay on top of what they owe action on.
You are given a TASK the person wrote for themselves. They have ALREADY decided how
important it is — that is their call, not yours. Do NOT judge or restate its priority.

Your job is to ADD INSIGHT:
- reason: ONE plain sentence naming the concrete stakes or what this unblocks — the
  "why it matters" the person might not have spelled out. Not a restatement of the title.
  "Advisor's approval window closes before registration opens."
- category: EXACTLY one of: errand, communication, admin, work, personal, other.

Respond ONLY with a JSON object: {"reason": "<sentence>", "category": "<cat>"}`;

function userMsg(task: TaskRow): string {
  const parts = [`Task: ${task.title}`];
  if (task.priority) parts.push(`Owner-set priority: ${task.priority}`);
  if (task.notes && task.notes.trim() !== '') {
    parts.push(`Notes: ${task.notes.slice(0, 2000)}`);
  }
  return parts.join('\n');
}

function coerce(raw: unknown): Enrichment {
  const o = (raw ?? {}) as Record<string, unknown>;
  let category = String(o.category ?? 'other').toLowerCase() as Category;
  if (!CATEGORIES.includes(category)) category = 'other';
  const reason = typeof o.reason === 'string' ? o.reason.slice(0, 500) : '';
  return { reason, category };
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
// Per-task independent audit — one bad task must not sink the batch. Priority is
// owner-owned and deliberately NOT written here.
export async function enrichBatch(limit: number): Promise<{
  processed: number;
  results: Array<{ id: string; ok: boolean; category?: string; error?: string }>;
}> {
  const tasks = await sql<TaskRow[]>`
    select id, title, notes, priority
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
        payload: { category: e.category },
      });
      results.push({ id: task.id, ok: true, category: e.category });
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
