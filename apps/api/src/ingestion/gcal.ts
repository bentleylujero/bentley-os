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

interface Attendee {
  email: string;
  name: string | null;
  response: string | null;
}

async function upsertPerson(client: any, email: string, name: string | null): Promise<string> {
  const res = await client.query(
    `INSERT INTO people (email, display_name)
     VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET
       display_name = COALESCE(people.display_name, EXCLUDED.display_name),
       updated_at = now()
     RETURNING id`,
    [email.toLowerCase(), name],
  );
  return res.rows[0].id;
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

  const rawAttendees: Attendee[] = (ev.attendees ?? [])
    .filter((a: any) => a.email)
    .map((a: any) => ({
      email: a.email.toLowerCase(),
      name: a.displayName ?? null,
      response: a.responseStatus ?? null,
    }));

  const organizerEmail: string | null = ev.organizer?.email ?? null;
  const organizerName: string | null = ev.organizer?.displayName ?? null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const organizerId = organizerEmail
      ? await upsertPerson(client, organizerEmail, organizerName)
      : null;

    const eventRes = await client.query(
      `INSERT INTO calendar_events (source, source_id, title, description, location, starts_at, ends_at, organizer_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (source, source_id) DO UPDATE SET
         title = EXCLUDED.title,
         description = EXCLUDED.description,
         location = EXCLUDED.location,
         starts_at = EXCLUDED.starts_at,
         ends_at = EXCLUDED.ends_at,
         organizer_id = EXCLUDED.organizer_id,
         status = EXCLUDED.status,
         updated_at = now()
       RETURNING id, (xmax = 0) AS inserted`,
      [
        'gcal',
        ev.id,
        ev.summary ?? null,
        ev.description ?? null,
        ev.location ?? null,
        startsAt,
        endsAt,
        organizerId,
        ev.status ?? null,
      ],
    );
    const eventId: string = eventRes.rows[0].id;
    const inserted: boolean = eventRes.rows[0].inserted;

    // Rebuild attendees for this event (idempotent on re-sync).
    await client.query(`DELETE FROM event_attendees WHERE event_id = $1`, [eventId]);

    const seen = new Set<string>();
    for (const a of rawAttendees) {
      if (seen.has(a.email)) continue;
      seen.add(a.email);
      const personId = await upsertPerson(client, a.email, a.name);
      await client.query(
        `INSERT INTO event_attendees (event_id, person_id, response)
         VALUES ($1, $2, $3)
         ON CONFLICT (event_id, person_id) DO UPDATE SET response = EXCLUDED.response`,
        [eventId, personId, a.response],
      );
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
