import { google } from 'googleapis';
import { readFileSync } from 'node:fs';
import { pool } from '../db/pool.js';

const SECRET_PATH = process.env.GOOGLE_CLIENT_SECRET_PATH || '/secrets/client_secret.json';
const TOKEN_PATH = process.env.GOOGLE_TOKEN_PATH || '/secrets/token.json';

function makeGmailClient() {
  const { installed } = JSON.parse(readFileSync(SECRET_PATH, 'utf8'));
  const token = JSON.parse(readFileSync(TOKEN_PATH, 'utf8'));
  const oauth2 = new google.auth.OAuth2(
    installed.client_id,
    installed.client_secret,
    installed.redirect_uris[0],
  );
  oauth2.setCredentials(token);
  return google.gmail({ version: 'v1', auth: oauth2 });
}

export interface GmailSyncResult {
  fetched: number;
  upserted: number;
  nextHistoryId: string | null;
  fullResync: boolean;
}

interface Addr {
  email: string;
  name: string | null;
}

// Parse a raw header value like: "Foo Bar <foo@x.com>, baz@y.com"
function parseAddresses(raw: string | undefined): Addr[] {
  if (!raw) return [];
  const out: Addr[] = [];
  for (const part of raw.split(',')) {
    const s = part.trim();
    if (!s) continue;
    const m = s.match(/^(.*?)<([^>]+)>$/);
    if (m) {
      const name = m[1].trim().replace(/^"|"$/g, '') || null;
      const email = m[2].trim().toLowerCase();
      if (email) out.push({ email, name });
    } else {
      const email = s.toLowerCase();
      if (email.includes('@')) out.push({ email, name: null });
    }
  }
  return out;
}

function header(headers: any[], name: string): string | undefined {
  const h = headers.find((x) => x.name?.toLowerCase() === name.toLowerCase());
  return h?.value ?? undefined;
}

// --- Body extraction ---------------------------------------------------------
// Gmail bodies are a nested MIME tree; parts are base64url-encoded.
// Prefer text/plain; fall back to stripped text/html. Never throws — a body
// extraction failure must not break ingestion (which is /health-adjacent).

function decodeB64Url(data: string): string {
  try {
    return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractBody(payload: any): string | null {
  if (!payload) return null;

  let plain: string | null = null as string | null;
  let html: string | null = null as string | null;

  function walk(part: any) {
    if (!part) return;
    const mime = part.mimeType ?? '';
    const data = part.body?.data;
    if (data) {
      if (mime === 'text/plain' && plain === null) plain = decodeB64Url(data);
      else if (mime === 'text/html' && html === null) html = decodeB64Url(data);
    }
    for (const child of part.parts ?? []) walk(child);
  }
  walk(payload);

  if (plain && plain.trim()) return plain.trim();
  if (html && html.trim()) return stripHtml(html);
  return null;
}

const RECIPIENT_LINK_TYPES: Record<string, string> = {
  to: 'email_has_to_recipient',
  cc: 'email_has_cc_recipient',
};

async function upsertPerson(client: any, addr: Addr): Promise<string> {
  const res = await client.query(
    `INSERT INTO people (email, display_name)
     VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET
       display_name = COALESCE(people.display_name, EXCLUDED.display_name),
       updated_at = now()
     RETURNING id`,
    [addr.email, addr.name],
  );
  return res.rows[0].id;
}

// Returns 1 if a new email row was inserted, 0 if it already existed.
async function upsertMessage(msg: Record<string, any>): Promise<number> {
  const payload = msg.payload ?? {};
  const headers = payload.headers ?? [];

  const fromAddrs = parseAddresses(header(headers, 'From'));
  const toAddrs = parseAddresses(header(headers, 'To'));
  const ccAddrs = parseAddresses(header(headers, 'Cc'));

  const subject = header(headers, 'Subject') ?? null;
  const snippet = msg.snippet ?? null;
  const body = extractBody(payload);
  const threadId = msg.threadId ?? null;
  const internalMs = msg.internalDate ? Number(msg.internalDate) : null;
  const receivedAt = internalMs ? new Date(internalMs).toISOString() : null;
  const labels: string[] = msg.labelIds ?? [];
  const isUnread = labels.includes('UNREAD');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const senderId = fromAddrs[0] ? await upsertPerson(client, fromAddrs[0]) : null;

    const emailRes = await client.query(
      `INSERT INTO emails (source, source_id, thread_id, sender_id, subject, snippet, body, received_at, is_unread)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (source, source_id) DO UPDATE SET
         thread_id = EXCLUDED.thread_id,
         sender_id = EXCLUDED.sender_id,
         subject = EXCLUDED.subject,
         snippet = EXCLUDED.snippet,
         body = EXCLUDED.body,
         received_at = EXCLUDED.received_at,
         is_unread = EXCLUDED.is_unread
       RETURNING id, (xmax = 0) AS inserted`,
      ['gmail', msg.id, threadId, senderId, subject, snippet, body, receivedAt, isUnread],
    );
    const emailId: string = emailRes.rows[0].id;
    const inserted: boolean = emailRes.rows[0].inserted;

    // Recipient edges live in links; the 5-tuple unique constraint makes re-sync a no-op.
    const seen = new Set<string>();
    for (const [kind, addrs] of [['to', toAddrs], ['cc', ccAddrs]] as const) {
      const linkType = RECIPIENT_LINK_TYPES[kind];
      if (!linkType) throw new Error(`gmail: unknown recipient kind "${kind}"`);
      for (const addr of addrs) {
        const dedupeKey = `${kind}:${addr.email}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        const personId = await upsertPerson(client, addr);
        await client.query(
          `INSERT INTO links (from_type, from_id, link_type, to_type, to_id)
           VALUES ('emails', $1::text, $2, 'people', $3::text)
           ON CONFLICT (from_type, from_id, link_type, to_type, to_id) DO NOTHING`,
          [emailId, linkType, personId],
        );
      }
    }

    await client.query('COMMIT');
    return inserted ? 1 : 0;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function fetchMessage(gmail: any, id: string): Promise<Record<string, any>> {
  const res = await gmail.users.messages.get({
    userId: 'me',
    id,
    format: 'full',
  });
  return res.data;
}

// Full backfill: last 30 days of messages.
async function fullSync(gmail: any): Promise<GmailSyncResult> {
  let pageToken: string | undefined;
  let fetched = 0;
  let upserted = 0;
  let maxHistoryId = 0n;

  do {
    const list = await gmail.users.messages.list({
      userId: 'me',
      q: 'newer_than:30d',
      maxResults: 100,
      pageToken,
    });
    const ids = (list.data.messages ?? []).map((m: any) => m.id);
    for (const id of ids) {
      const msg = await fetchMessage(gmail, id);
      fetched += 1;
      upserted += await upsertMessage(msg);
      if (msg.historyId) {
        const h = BigInt(msg.historyId);
        if (h > maxHistoryId) maxHistoryId = h;
      }
    }
    pageToken = list.data.nextPageToken ?? undefined;
  } while (pageToken);

  return {
    fetched,
    upserted,
    nextHistoryId: maxHistoryId > 0n ? maxHistoryId.toString() : null,
    fullResync: true,
  };
}

// Incremental: history since startHistoryId. Throws {code:404} if too old.
async function incrementalSync(gmail: any, startHistoryId: string): Promise<GmailSyncResult> {
  let pageToken: string | undefined;
  let fetched = 0;
  let upserted = 0;
  let maxHistoryId = BigInt(startHistoryId);
  const changedIds = new Set<string>();

  do {
    const res = await gmail.users.history.list({
      userId: 'me',
      startHistoryId,
      historyTypes: ['messageAdded'],
      maxResults: 500,
      pageToken,
    });
    for (const h of res.data.history ?? []) {
      if (h.id) {
        const hid = BigInt(h.id);
        if (hid > maxHistoryId) maxHistoryId = hid;
      }
      for (const added of h.messagesAdded ?? []) {
        if (added.message?.id) changedIds.add(added.message.id);
      }
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  for (const id of changedIds) {
    try {
      const msg = await fetchMessage(gmail, id);
      fetched += 1;
      upserted += await upsertMessage(msg);
    } catch (e: any) {
      if (e?.code === 404) continue; // message deleted between history read and fetch
      throw e;
    }
  }

  return {
    fetched,
    upserted,
    nextHistoryId: maxHistoryId.toString(),
    fullResync: false,
  };
}

export async function runGmailSync(): Promise<GmailSyncResult> {
  const gmail = makeGmailClient();

  const stateRes = await pool.query(
    `SELECT sync_token FROM sync_state WHERE source = $1`,
    ['gmail'],
  );
  const startHistoryId: string | undefined = stateRes.rows[0]?.sync_token ?? undefined;

  let result: GmailSyncResult;
  if (startHistoryId) {
    try {
      result = await incrementalSync(gmail, startHistoryId);
    } catch (e: any) {
      if (e?.code === 404) {
        result = await fullSync(gmail); // cursor expired — self-heal
      } else {
        throw e;
      }
    }
  } else {
    result = await fullSync(gmail);
  }

  if (result.nextHistoryId) {
    await pool.query(
      `INSERT INTO sync_state (source, sync_token, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (source) DO UPDATE SET
         sync_token = EXCLUDED.sync_token,
         updated_at = now()`,
      ['gmail', result.nextHistoryId],
    );
  }

  return result;
}
