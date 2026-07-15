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

// Strip zero-width / BOM padding that Gmail marketing injects into snippets
// and subjects (U+200B..U+200D, U+FEFF). Third-party text only; run before esc().
function clean(s: unknown): string {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[\u200B-\u200D\uFEFF]/g, '');
}

// Escape + strip, for third-party display fields (subjects, snippets).
function escT(s: unknown): string {
  return esc(clean(s));
}

function fmtTime(d: Date | null): string {
  if (!d) return '';
  return d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: TZ,
  });
}

// Compact "Jul 12, 3:04 PM" for cross-day deltas in the What-changed feed.
function fmtStamp(d: Date | null): string {
  if (!d) return '';
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: TZ,
  });
}

// Priority triage tiers — read-only projection of Clair's importance score.
// The classifier (marionette) owns the judgement; this only buckets + renders.
// Cutoffs match Clair's own SYSTEM bands (80-100 harm / 40-79 matters / 0-39 noise),
// with the top tier opened to 70 to catch high-stakes-but-not-maximal items.
function tierOf(importance: number): 'high' | 'mid' | 'low' {
  if (importance >= 70) return 'high';
  if (importance >= 40) return 'mid';
  return 'low';
}

dashboardRoute.get('/', async (c) => {
  let events: any[] = [];
  let emails: any[] = [];
  let newEmails: any[] = [];
  let newEvents: any[] = [];
  let triage: any[] = [];
  let lastSeen: Date | null = null;
  let dbError = '';

  // Read the singleton last-seen marker first. Its own guard: if this fails,
  // the What-changed section simply shows nothing new — the rest still renders.
  try {
    const seenR = await pool.query(
      `SELECT last_seen_at FROM dashboard_state WHERE id = 1`
    );
    lastSeen = seenR.rows[0]?.last_seen_at ?? null;
  } catch {
    lastSeen = null;
  }

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
    // Priority triage — Clair-classified mail, ranked by consequence. reason
    // leads (the whole point of the classifier); subject is context.
    const triageQ = pool.query(
      `SELECT subject, reason, category, importance, received_at, is_unread
         FROM emails
        WHERE classified_at IS NOT NULL
        ORDER BY importance DESC, received_at DESC NULLS LAST`
    );
    // "What changed" = rows ingested (created_at) since the owner last looked.
    // created_at, not received_at: an old email newly synced still counts as new to us.
    const newEmailsQ = lastSeen
      ? pool.query(
          `SELECT subject, snippet, received_at, created_at, is_unread
             FROM emails
            WHERE created_at > $1
            ORDER BY created_at DESC
            LIMIT 20`,
          [lastSeen]
        )
      : Promise.resolve({ rows: [] as any[] });
    const newEventsQ = lastSeen
      ? pool.query(
          `SELECT title, starts_at, location, created_at
             FROM calendar_events
            WHERE created_at > $1
            ORDER BY created_at DESC
            LIMIT 20`,
          [lastSeen]
        )
      : Promise.resolve({ rows: [] as any[] });

    const [eventsR, emailsR, triageR, newEmailsR, newEventsR] = await Promise.all([
      eventsQ,
      emailsQ,
      triageQ,
      newEmailsQ,
      newEventsQ,
    ]);
    events = eventsR.rows;
    emails = emailsR.rows;
    triage = triageR.rows;
    newEmails = newEmailsR.rows;
    newEvents = newEventsR.rows;
  } catch (err: any) {
    dbError = err?.message ?? 'query failed';
  }

  // Advance the marker to now — fire-and-forget, after the deltas above are
  // already captured, so THIS view still shows what was new and the NEXT resets.
  // Own guard: a failed update must never break the response.
  void pool
    .query(`UPDATE dashboard_state SET last_seen_at = now() WHERE id = 1`)
    .catch(() => {});

  const changedCount = newEmails.length + newEvents.length;
  const changedHtml = dbError
    ? ''
    : !lastSeen
    ? `<p class="muted">First look — nothing to compare against yet.</p>`
    : changedCount === 0
    ? `<p class="muted">Nothing new since you last looked.</p>`
    : [
        ...newEvents.map(
          (e) => `<div class="row">
        <span class="time">${esc(fmtStamp(e.created_at))}</span>
        <span class="body"><span class="tag">event</span> <b>${
            esc(e.title) || '(untitled)'
          }</b>${
            e.location ? `<span class="sub"> · ${esc(e.location)}</span>` : ''
          }</span>
      </div>`
        ),
        ...newEmails.map(
          (m) => `<div class="row">
        <span class="time">${esc(fmtStamp(m.created_at))}</span>
        <span class="body"><span class="tag">email</span> ${
            m.is_unread ? '<span class="unread">●</span> ' : ''
          }<b>${escT(m.subject) || '(no subject)'}</b>${
            m.snippet ? `<span class="sub"> — ${escT(m.snippet)}</span>` : ''
          }</span>
      </div>`
        ),
      ].join('');

  // --- Priority triage render ---------------------------------------------
  // One row per classified email: score chip + reason (headline) + subject (sub).
  function triageRow(m: any): string {
    const t = tierOf(Number(m.importance));
    return `<div class="row">
        <span class="score score-${t}">${esc(m.importance)}</span>
        <span class="body"><b>${esc(m.reason) || '(no reason given)'}</b>${
      m.is_unread ? ' <span class="unread">●</span>' : ''
    }<span class="sub"> — <span class="tag">${esc(m.category) || 'other'}</span> ${
      escT(m.subject) || '(no subject)'
    }</span></span>
      </div>`;
  }
  const tierHigh = triage.filter((m) => tierOf(Number(m.importance)) === 'high');
  const tierMid = triage.filter((m) => tierOf(Number(m.importance)) === 'mid');
  const tierLow = triage.filter((m) => tierOf(Number(m.importance)) === 'low');
  function tierBlock(label: string, cls: string, rows: any[]): string {
    if (rows.length === 0) return '';
    return `<div class="tier-label ${cls}">${label} <span class="count">${rows.length}</span></div>${rows
      .map(triageRow)
      .join('')}`;
  }
  const triageHtml = dbError
    ? `<p class="muted">couldn't load triage: ${esc(dbError)}</p>`
    : triage.length === 0
    ? `<p class="muted">Nothing classified yet.</p>`
    : tierBlock('Think about first', 'th-high', tierHigh) +
      tierBlock('Peripheral', 'th-mid', tierMid) +
      tierBlock('Noise', 'th-low', tierLow);

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
            escT(m.subject) || '(no subject)'
          }</b>${m.snippet ? `<span class="sub"> — ${escT(m.snippet)}</span>` : ''}</span>
      </div>`
        )
        .join('');

  const changedHeading =
    !dbError && lastSeen && changedCount > 0
      ? `What changed <span class="count">${changedCount}</span>`
      : `What changed`;

  const triageHeading =
    !dbError && tierHigh.length > 0
      ? `Priority triage <span class="count">${tierHigh.length} to act on</span>`
      : `Priority triage`;

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
  .time{color:#8b949e;font-size:.85rem;min-width:88px;white-space:nowrap;}
  .body{flex:1;overflow:hidden;}
  .sub{color:#8b949e;font-weight:normal;}
  .unread{color:#58a6ff;}
  .tag{display:inline-block;font-size:.7rem;text-transform:uppercase;letter-spacing:.06em;color:#8b949e;border:1px solid #2a3441;border-radius:4px;padding:0 5px;margin-right:4px;}
  .count{display:inline-block;background:#238636;color:#fff;font-size:.7rem;border-radius:9px;padding:0 7px;margin-left:6px;vertical-align:middle;}
  .score{min-width:34px;text-align:center;font-size:.8rem;font-weight:bold;border-radius:6px;padding:2px 0;height:fit-content;}
  .score-high{background:#3d1418;color:#ff7b72;border:1px solid #6e2329;}
  .score-mid{background:#3a2d10;color:#e3b341;border:1px solid #6b531a;}
  .score-low{background:#1c2431;color:#8b949e;border:1px solid #2a3441;}
  .tier-label{font-size:.78rem;text-transform:uppercase;letter-spacing:.06em;margin:.9rem 0 .35rem;font-weight:bold;}
  .tier-label:first-child{margin-top:0;}
  .th-high{color:#ff7b72;} .th-mid{color:#e3b341;} .th-low{color:#8b949e;}
  a{color:#58a6ff;text-decoration:none;} a:hover{text-decoration:underline;}
  .muted{color:#8b949e;font-size:.85rem;}
</style></head>
<body><div class="wrap">
  <h1><span class="dot"></span>Bentley OS</h1>
  <h2>${changedHeading}</h2>
  <div class="card">${changedHtml}</div>
  <h2>${triageHeading}</h2>
  <div class="card">${triageHtml}</div>
  <h2>Today</h2>
  <div class="card">${eventsHtml}</div>
  <h2>Recent email</h2>
  <div class="card">${emailsHtml}</div>
  <p class="muted"><a href="/health">/health</a> · <span id="time"></span></p>
</div>
<script>document.getElementById('time').textContent = new Date().toLocaleString();</script>
</body></html>`);
});
