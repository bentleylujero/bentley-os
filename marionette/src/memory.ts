import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!, { max: 2, idle_timeout: 20 });

export const MAX_CHARS = 6000;
export const MAX_TURNS = 12;

export type Turn = { role: 'user' | 'assistant'; content: string };

/** DB read. Newest-first, then reversed to chronological. Caps by turns AND chars. */
export async function readHistory(conversationId: string): Promise<Turn[]> {
  const rows = await sql<Turn[]>`
    select role, content
    from messages
    where conversation_id = ${conversationId}
    order by created_at desc
    limit ${MAX_TURNS}
  `;
  const out: Turn[] = [];
  let chars = 0;
  for (const r of rows) {
    chars += r.content.length;
    if (chars > MAX_CHARS) break;
    out.push({ role: r.role, content: r.content });
  }
  return out.reverse();
}

export async function writeTurn(
  conversationId: string,
  role: 'user' | 'assistant',
  content: string
): Promise<void> {
  if (!content) return;
  await sql`
    insert into messages (conversation_id, role, content)
    values (${conversationId}, ${role}, ${content})
  `;
}

/** PURE. Turns history into DeepSeek message objects. */
export function formatHistoryForPrompt(turns: Turn[]): { role: string; content: string }[] {
  return turns.map((t) => ({ role: t.role, content: t.content }));
}
