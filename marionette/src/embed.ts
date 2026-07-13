// embed.ts — the embedding pipeline. Reads emails that have a body but no
// embedding yet, embeds each via OpenAI text-embedding-3-small (1536-dim,
// API-only per §2.4 — no local inference), upserts the vector into Qdrant's
// `emails` collection keyed on the email id, and stamps embedded_at on success.
//
// Mirrors classify.ts exactly: same postgres client, per-row independent audit
// (marionette.embed), one bad row cannot sink the batch. The vector lives in
// Qdrant (derived index); the FACT of being embedded lives on the email row.
//
// ONE email = ONE vector. No chunking — email bodies are short (< the model's
// input limit). retrieve.ts leaves a chunk-ready seam; a chunker is deferred to
// the first long-form source (PDFs/web pages). See §8.

import postgres from 'postgres';
import { audit } from './audit.ts';

const sql = postgres(process.env.DATABASE_URL || '', {
  max: 2,
  idle_timeout: 20,
});

const OPENAI_URL = 'https://api.openai.com/v1/embeddings';
const EMBED_MODEL = 'text-embedding-3-small';
const EMBED_DIM = 1536;
const QDRANT_URL = process.env.QDRANT_URL || 'http://qdrant:6333';
const QDRANT_COLLECTION = 'emails';
// Cap input — 3-small's context is 8191 tokens; bodies are short but marketing
// mail can be huge. ~24k chars is a safe ceiling well under the token limit.
const MAX_INPUT_CHARS = 24_000;
const TIMEOUT_MS = 60_000;

interface EmailRow {
  id: string;              // uuid
  subject: string | null;
  body: string | null;
  received_at: string | null;
  sender_id: string | null;
}

// Embeds one string via OpenAI. Throws on network failure, non-2xx, or a
// malformed response (mirrors deepseek.ts's defensive shape-checking).
async function embedText(text: string): Promise<number[]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY not set in environment');

  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + key,
    },
    body: JSON.stringify({ model: EMBED_MODEL, input: text.slice(0, MAX_INPUT_CHARS) }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(`OpenAI HTTP ${res.status}: ${body.slice(0, 500)}`);
  }

  const data = await res.json();
  const vec = data?.data?.[0]?.embedding;
  if (!Array.isArray(vec) || vec.length !== EMBED_DIM) {
    throw new Error(`OpenAI returned malformed embedding (len ${Array.isArray(vec) ? vec.length : 'n/a'})`);
  }
  return vec;
}

// Upserts one vector into Qdrant, keyed on the email id, with a light payload
// for display/filtering at retrieval time (the body itself is NOT stored in
// Qdrant — it stays in Postgres, the one source of truth; retrieve.ts SELECTs
// it back by id).
async function upsertVector(email: EmailRow, vector: number[]): Promise<void> {
  const res = await fetch(`${QDRANT_URL}/collections/${QDRANT_COLLECTION}/points`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      points: [
        {
          id: email.id, // qdrant accepts a uuid string as a point id
          vector,
          payload: {
            subject: email.subject ?? '',
            received_at: email.received_at ?? null,
            sender_id: email.sender_id ?? null,
          },
        },
      ],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(`Qdrant upsert HTTP ${res.status}: ${body.slice(0, 500)}`);
  }
}

// What we actually embed: subject + body together, so a query about a subject
// line still retrieves even when the body is thin.
function embedInput(email: EmailRow): string {
  const subject = email.subject ?? '';
  const body = email.body ?? '';
  return `Subject: ${subject}\n\n${body}`.trim();
}

// Embed up to `limit` un-embedded emails (newest first, via idx_emails_unembedded).
// Each email audits independently — one bad email must not sink the batch.
export async function embedBatch(limit: number): Promise<{
  processed: number;
  results: Array<{ id: string; ok: boolean; error?: string }>;
}> {
  const emails = await sql<EmailRow[]>`
    select id, subject, body, received_at, sender_id
    from emails
    where body is not null and embedded_at is null
    order by received_at desc nulls last
    limit ${limit}
  `;

  const results = [];
  for (const email of emails) {
    try {
      const vector = await embedText(embedInput(email));
      await upsertVector(email, vector);
      await sql`
        update emails set embedded_at = now() where id = ${email.id}
      `;
      await audit({
        action: 'marionette.embed',
        target: email.id,
        outcome: 'success',
        payload: { model: EMBED_MODEL, dim: EMBED_DIM },
      });
      results.push({ id: email.id, ok: true });
    } catch (err: any) {
      const message = err?.message || String(err);
      await audit({
        action: 'marionette.embed',
        target: email.id,
        outcome: 'error',
        payload: { error: message },
      });
      results.push({ id: email.id, ok: false, error: message });
    }
  }

  return { processed: emails.length, results };
}
