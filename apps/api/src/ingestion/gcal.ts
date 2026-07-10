import { google } from 'googleapis';
import { readFileSync } from 'node:fs';
import { pool } from '../db/pool.js';

const SECRET_PATH = process.env.GOOGLE_CLIENT_SECRET_PATH || '/secrets/client_secret.json';
const TOKEN_PATH = process.env.GOOGLE_TOKEN_PATH || '/secrets/token.json';

function makeCalendarClient() {
  const { installed } = JSON.parse(readFileSync(SECRET_PATH, 'utf8'));
  const token = JSON.parse(readFileSync(TOKEN_PATH, 'utf8'));

  const oauth2 = new google.auth.OAuth2(
    installed.client_id,
    installed.client_secret,
    installed.redirect_uris[0],
  );
  oauth2.setCredentials(token);
  return google.calendar({ version: 'v3', auth: oauth2 });
}

export interface GcalSyncResult {
  fetched: number;
  upserted: number;
  nextSyncToken: string | null;
}

export async function syncCalendar(syncToken?: string): Promise<GcalSyncResult> {
  const calendar = makeCalendarClient();
  let pageToken: string | undefined;
  let newSyncToken: string | null = null;
  let fetched = 0;
  let upserted = 0;

  do {
    const params: Record<string, unknown> = {
      calendarId: 'primary',
      singleEvents: true,
      maxResults: 250,
      pageToken,
    };
    if (syncToken) {
      params.syncToken = syncToken;
    } else {
      params.timeMin = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    }

    const res = await calendar.events.list(params);
    const items = res.data.items ?? [];
    fetched += items.length;

    for (const ev of items) {
      if (ev.status === 'cancelled') continue;
      upserted += await upsertEvent(ev);
    }

    pageToken = res.data.nextPageToken ?? undefined;
    if (res.data.nextSyncToken) newSyncToken = res.data.nextSyncToken;
  } while (pageToken);

  return { fetched, upserted, nextSyncToken: newSyncToken };
}

async function upsertEvent(ev: Record<string, any>): Promise<number> {
  const startsAt = ev.start?.dateTime ?? ev.start?.date ?? null;
  const endsAt = ev.end?.dateTime ?? ev.end?.date ?? null;

  const result = await pool.query(
    `INSERT INTO calendar_events (source, source_id, title, description, location, starts_at, ends_at, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (source, source_id) DO UPDATE SET
       title = EXCLUDED.title,
       description = EXCLUDED.description,
       location = EXCLUDED.location,
       starts_at = EXCLUDED.starts_at,
       ends_at = EXCLUDED.ends_at,
       status = EXCLUDED.status,
       updated_at = now()`,
    [
      'gcal',
      ev.id,
      ev.summary ?? null,
      ev.description ?? null,
      ev.location ?? null,
      startsAt,
      endsAt,
      ev.status ?? null,
    ],
  );
  return result.rowCount ?? 0;
}

export async function runGcalSync(): Promise<GcalSyncResult> {
  const stateRes = await pool.query(
    `SELECT sync_token FROM sync_state WHERE source = $1`,
    ['gcal'],
  );
  const existingToken: string | undefined = stateRes.rows[0]?.sync_token ?? undefined;

  const result = await syncCalendar(existingToken);

  if (result.nextSyncToken) {
    await pool.query(
      `INSERT INTO sync_state (source, sync_token, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (source) DO UPDATE SET
         sync_token = EXCLUDED.sync_token,
         updated_at = now()`,
      ['gcal', result.nextSyncToken],
    );
  }

  return result;
}
