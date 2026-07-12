import { Hono } from 'hono';
import { pool } from '../db/pool.js';

export const dashboardRoute = new Hono();

const TZ = 'America/Chicago';

function esc(s: unknown): string {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtTime(d: Date | null): string {
  if (!d) return '';
  return d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: TZ,
  });
}

dashboardRoute.get('/', async (c) => {
  let events: any[] = [];
  let emails: any[] = [];
  let dbError = '';

  try {
    const eventsQ = pool.query(
      `SELECT title, starts_at, ends_at, location, status
         FROM calendar_events
        WHERE starts_at AT TIME ZONE $1 >= (now() AT TIME ZONE $1)::date
          AND starts_at AT TIME ZONE $1 <  ((now() AT TIME ZONE $1)::date + interval '1 day')
        ORDER BY starts_at ASC`,
      [TZ]
    );
    const emailsQ = pool.query(
      `SELECT subject, snippet, received_at, is_unread
         FROM emails
        ORDER BY received_at DESC NULLS LAST
        LIMIT 15`
    );
    const [eventsR, emailsR] = await Promise.all([eventsQ, emailsQ]);
    events = eventsR.rows;
    emails = emailsR.rows;
  } catch (err: any) {
    dbError = err?.message ?? 'query failed';
  }

  const eventsHtml = dbError
    ? `<p class="muted">couldn't load events: ${esc(dbError)}</p>`
    : events.length === 0
    ? `<p class="muted">Nothing on the calendar today.</p>`
    : events
        .map(
          (e) => `<div class="row">
        <span class="time">${esc(fmtTime(e.starts_at))}</span>
        <span class="body"><b>${esc(e.title) || '(untitled)'}</b>${
            e.location ? `<span class="sub"> · ${esc(e.location)}</span>` : ''
          }</span>
      </div>`
        )
        .join('');

  const emailsHtml = dbError
    ? ''
    : emails.length === 0
    ? `<p class="muted">No emails yet.</p>`
    : emails
        .map(
          (m) => `<div class="row">
        <span class="time">${esc(fmtTime(m.received_at))}</span>
        <span class="body">${m.is_unread ? '<span class="unread">●</span> ' : ''}<b>${
            esc(m.subject) || '(no subject)'
          }</b>${m.snippet ? `<span class="sub"> — ${esc(m.snippet)}</span>` : ''}</span>
      </div>`
        )
        .join('');

  return c.html(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bentley OS</title>
<style>
  body{background:#0b0e14;color:#e6e6e6;font-family:ui-monospace,Menlo,monospace;margin:0;padding:2rem;}
  .wrap{max-width:680px;margin:0 auto;}
  h1{font-size:1.4rem;letter-spacing:.02em;}
  h2{font-size:.95rem;color:#8b949e;text-transform:uppercase;letter-spacing:.08em;margin:1.5rem 0 .5rem;}
  .dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:#3fb950;margin-right:8px;}
  .card{background:#151a23;border:1px solid #222b38;border-radius:10px;padding:1rem 1.25rem;margin:.5rem 0;}
  .row{display:flex;gap:.9rem;padding:.45rem 0;border-bottom:1px solid #1c2431;}
  .row:last-child{border-bottom:none;}
  .time{color:#8b949e;font-size:.85rem;min-width:64px;white-space:nowrap;}
  .body{flex:1;overflow:hidden;}
  .sub{color:#8b949e;font-weight:normal;}
  .unread{color:#58a6ff;}
  a{color:#58a6ff;text-decoration:none;} a:hover{text-decoration:underline;}
  .muted{color:#8b949e;font-size:.85rem;}
</style></head>
<body><div class="wrap">
  <h1><span class="dot"></span>Bentley OS</h1>

  <h2>Today</h2>
  <div class="card">${eventsHtml}</div>

  <h2>Recent email</h2>
  <div class="card">${emailsHtml}</div>

  <p class="muted"><a href="/health">/health</a> · <span id="time"></span></p>
</div>
<script>document.getElementById('time').textContent = new Date().toLocaleString();</script>
</body></html>`);
});
