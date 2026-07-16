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
  let tasks: any[] = [];
  let attnEmails: any[] = [];
  let periphEmails: any[] = [];
  let upcomingEvents: any[] = [];
  let pastEvents: any[] = [];
  let newEmails: any[] = [];
  let newEvents: any[] = [];
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
    // Open tasks — ranked on their OWN scale (owner-set high/med/low), NOT the
    // email importance score. Explicit CASE ordinal — string sort would put
    // high < low < medium alphabetically, which is wrong.
    const tasksQ = pool.query(
      `SELECT id, title, notes, priority, reason, category, status
         FROM tasks
        WHERE status = 'open'
        ORDER BY CASE priority
                   WHEN 'high' THEN 0
                   WHEN 'medium' THEN 1
                   ELSE 2
                 END,
                 created_at DESC`
    );
    // Needs attention — think-first mail (>=70). Kept visually separate from
    // tasks (numeric score chips vs high/med/low bands).
    const attnQ = pool.query(
      `SELECT subject, reason, category, importance, received_at, is_unread
         FROM emails
        WHERE classified_at IS NOT NULL AND importance >= 70
        ORDER BY importance DESC, received_at DESC NULLS LAST`
    );
    // Peripheral — matters-but-not-urgent (40-69). Noise (<40) is dropped
    // entirely, not even collapsed.
    const periphQ = pool.query(
      `SELECT subject, reason, category, importance, received_at, is_unread
         FROM emails
        WHERE classified_at IS NOT NULL AND importance >= 40 AND importance < 70
        ORDER BY importance DESC, received_at DESC NULLS LAST`
    );
    // Next up — today's events still ahead of now.
    const upcomingQ = pool.query(
      `SELECT title, starts_at, ends_at, location, status
         FROM calendar_events
        WHERE starts_at >= now()
          AND starts_at AT TIME ZONE $1 < ((now() AT TIME ZONE $1)::date + interval '1 day')
        ORDER BY starts_at ASC`,
      [TZ]
    );
    // Past events — earlier today, for the collapsed section.
    const pastQ = pool.query(
      `SELECT title, starts_at, ends_at, location, status
         FROM calendar_events
        WHERE starts_at AT TIME ZONE $1 >= (now() AT TIME ZONE $1)::date
          AND starts_at < now()
        ORDER BY starts_at DESC`,
      [TZ]
    );
    // "What changed" = rows ingested (created_at) since the owner last looked.
    // created_at, not received_at: an old email newly synced still counts as new.
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

    const [tasksR, attnR, periphR, upcomingR, pastR, newEmailsR, newEventsR] =
      await Promise.all([
        tasksQ,
        attnQ,
        periphQ,
        upcomingQ,
        pastQ,
        newEmailsQ,
        newEventsQ,
      ]);
    tasks = tasksR.rows;
    attnEmails = attnR.rows;
    periphEmails = periphR.rows;
    upcomingEvents = upcomingR.rows;
    pastEvents = pastR.rows;
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

  // --- Tasks render -------------------------------------------------------
  // Owner-set priority band + reason (AI insight) as sub-line. Click to complete.
  function taskRow(t: any): string {
    const p = t.priority === 'high' || t.priority === 'low' ? t.priority : 'medium';
    return `<div class="row task" data-id="${esc(t.id)}">
        <span class="pri pri-${p}">${p}</span>
        <span class="body"><b>${escT(t.title) || '(untitled)'}</b>${
      t.category ? ` <span class="tag">${esc(t.category)}</span>` : ''
    }${
      t.reason ? `<span class="sub"> — ${escT(t.reason)}</span>` : ''
    }</span>
        <span class="done" onclick="markDone('${esc(t.id)}')" title="mark done">✓</span>
      </div>`;
  }
  const tasksHtml = dbError
    ? `<p class="muted">couldn't load tasks: ${esc(dbError)}</p>`
    : tasks.length === 0
    ? `<p class="muted">No open tasks.</p>`
    : tasks.map(taskRow).join('');

  // --- Needs attention (think-first email) --------------------------------
  function attnRow(m: any): string {
    return `<div class="row">
        <span class="score score-high">${esc(m.importance)}</span>
        <span class="body"><b>${esc(m.reason) || '(no reason given)'}</b>${
      m.is_unread ? ' <span class="unread">●</span>' : ''
    }<span class="sub"> — <span class="tag">${esc(m.category) || 'other'}</span> ${
      escT(m.subject) || '(no subject)'
    }</span></span>
      </div>`;
  }
  const attnHtml = dbError
    ? ''
    : attnEmails.length === 0
    ? `<p class="muted">Nothing needs your attention.</p>`
    : attnEmails.map(attnRow).join('');

  // --- Next up (upcoming events) ------------------------------------------
  const upcomingHtml = dbError
    ? ''
    : upcomingEvents.length === 0
    ? `<p class="muted">Nothing left on the calendar today.</p>`
    : upcomingEvents
        .map(
          (e) => `<div class="row">
        <span class="time">${esc(fmtTime(e.starts_at))}</span>
        <span class="body"><b>${esc(e.title) || '(untitled)'}</b>${
            e.location ? `<span class="sub"> · ${esc(e.location)}</span>` : ''
          }</span>
      </div>`
        )
        .join('');

  // --- Everything else: peripheral email ----------------------------------
  function periphRow(m: any): string {
    return `<div class="row">
        <span class="score score-mid">${esc(m.importance)}</span>
        <span class="body"><b>${esc(m.reason) || '(no reason given)'}</b>${
      m.is_unread ? ' <span class="unread">●</span>' : ''
    }<span class="sub"> — <span class="tag">${esc(m.category) || 'other'}</span> ${
      escT(m.subject) || '(no subject)'
    }</span></span>
      </div>`;
  }
  const periphHtml = dbError
    ? `<p class="muted">couldn't load: ${esc(dbError)}</p>`
    : periphEmails.length === 0
    ? `<p class="muted">Nothing peripheral.</p>`
    : periphEmails.map(periphRow).join('');

  // --- Everything else: past events ---------------------------------------
  const pastHtml = dbError
    ? ''
    : pastEvents.length === 0
    ? `<p class="muted">Nothing earlier today.</p>`
    : pastEvents
        .map(
          (e) => `<div class="row">
        <span class="time">${esc(fmtTime(e.starts_at))}</span>
        <span class="body"><b>${esc(e.title) || '(untitled)'}</b>${
            e.location ? `<span class="sub"> · ${esc(e.location)}</span>` : ''
          }</span>
      </div>`
        )
        .join('');

  // --- Everything else: what changed --------------------------------------
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

  const changedBadge =
    !dbError && lastSeen && changedCount > 0
      ? ` <span class="count">${changedCount}</span>`
      : '';
  const attnBadge =
    !dbError && attnEmails.length > 0
      ? ` <span class="count">${attnEmails.length}</span>`
      : '';

  return c.html(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bentley OS</title>
<style>
  body{background:#0b0e14;color:#e6e6e6;font-family:ui-monospace,Menlo,monospace;margin:0;padding:2rem;}
  .wrap{max-width:680px;margin:0 auto;}
  h1{font-size:1.4rem;letter-spacing:.02em;}
  h2{font-size:.95rem;color:#8b949e;text-transform:uppercase;letter-spacing:.08em;margin:1.5rem 0 .5rem;}
  h3{font-size:.75rem;color:#6e7681;text-transform:uppercase;letter-spacing:.1em;margin:1rem 0 .3rem;font-weight:bold;}
  .dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:#3fb950;margin-right:8px;}
  .card{background:#151a23;border:1px solid #222b38;border-radius:10px;padding:1rem 1.25rem;margin:.5rem 0;}
  .now{border-color:#2d3f2f;box-shadow:0 0 0 1px #1d2a1e inset;}
  .row{display:flex;gap:.9rem;padding:.45rem 0;border-bottom:1px solid #1c2431;align-items:baseline;}
  .row:last-child{border-bottom:none;}
  .row.task{transition:opacity .35s ease;}
  .row.fading{opacity:0;}
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
  .pri{min-width:58px;text-align:center;font-size:.68rem;font-weight:bold;text-transform:uppercase;letter-spacing:.05em;border-radius:6px;padding:3px 0;height:fit-content;}
  .pri-high{background:#3d1418;color:#ff7b72;border:1px solid #6e2329;}
  .pri-medium{background:#3a2d10;color:#e3b341;border:1px solid #6b531a;}
  .pri-low{background:#1c2431;color:#8b949e;border:1px solid #2a3441;}
  .done{color:#3fb950;cursor:pointer;font-weight:bold;padding:0 4px;opacity:.55;user-select:none;}
  .done:hover{opacity:1;}
  .tier-label{font-size:.78rem;text-transform:uppercase;letter-spacing:.06em;margin:.9rem 0 .35rem;font-weight:bold;}
  .tier-label:first-child{margin-top:0;}
  .th-high{color:#ff7b72;} .th-mid{color:#e3b341;} .th-low{color:#8b949e;}
  .addtask{display:flex;gap:.5rem;margin-top:.75rem;flex-wrap:wrap;align-items:center;}
  .addtask input{flex:1;min-width:180px;background:#0b0e14;border:1px solid #2a3441;border-radius:6px;color:#e6e6e6;padding:.4rem .6rem;font-family:inherit;font-size:.85rem;}
  .addtask input:focus{outline:none;border-color:#3fb950;}
  .pbtn{background:#1c2431;border:1px solid #2a3441;border-radius:6px;color:#8b949e;padding:.4rem .7rem;font-family:inherit;font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;cursor:pointer;}
  .pbtn[data-p="high"]:hover{border-color:#6e2329;color:#ff7b72;}
  .pbtn[data-p="medium"]:hover{border-color:#6b531a;color:#e3b341;}
  .pbtn[data-p="low"]:hover{border-color:#2a3441;color:#e6e6e6;}
  details{margin-top:1.5rem;}
  summary{font-size:.95rem;color:#8b949e;text-transform:uppercase;letter-spacing:.08em;cursor:pointer;padding:.4rem 0;}
  summary:hover{color:#e6e6e6;}
  a{color:#58a6ff;text-decoration:none;} a:hover{text-decoration:underline;}
  .muted{color:#8b949e;font-size:.85rem;}
  /* ===== THE MONITOR ===== */
  .mon{background:#150d24;border:1px solid #3a2a5c;border-radius:8px;padding:.9rem 1rem;margin:0 0 1.2rem;font-family:'SF Mono',Menlo,Consolas,monospace;cursor:pointer;transition:border-color .15s;}
  .mon:hover{border-color:#7CFC00;}
  .mon-hd{display:flex;justify-content:space-between;align-items:center;margin-bottom:.7rem;}
  .mon-ttl{color:#7CFC00;font-size:.8rem;letter-spacing:.15em;text-transform:uppercase;text-shadow:0 0 6px rgba(124,252,0,.35);}
  .mon-hint{color:#5a8a3a;font-size:.65rem;letter-spacing:.05em;}
  .mon-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:.55rem .9rem;}
  .mon-row{display:flex;align-items:center;gap:.5rem;font-size:.72rem;}
  .mon-lbl{color:#9ad46a;min-width:52px;letter-spacing:.05em;}
  .mon-bar{flex:1;height:9px;background:#0a0714;border:1px solid #2f2350;border-radius:2px;overflow:hidden;}
  .mon-fill{display:block;height:100%;background:#7CFC00;box-shadow:0 0 8px rgba(124,252,0,.5);transition:width .4s ease;}
  .mon-fill.warn{background:#e3b341;box-shadow:0 0 8px rgba(227,179,65,.5);}
  .mon-fill.crit{background:#ff6b6b;box-shadow:0 0 8px rgba(255,107,107,.5);}
  .mon-val{color:#c8f0a0;min-width:38px;text-align:right;font-variant-numeric:tabular-nums;}
  .mon-led{width:9px;height:9px;border-radius:50%;flex-shrink:0;}
  .led-ok{background:#7CFC00;box-shadow:0 0 7px #7CFC00;}
  .led-warn{background:#e3b341;box-shadow:0 0 7px #e3b341;}
  .led-crit{background:#ff6b6b;box-shadow:0 0 7px #ff6b6b;animation:blink 1s infinite;}
  .led-off{background:#3a3a3a;}
  @keyframes blink{50%{opacity:.3;}}
  /* modal */
  .mon-back{position:fixed;inset:0;background:rgba(5,3,12,.4);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);display:none;align-items:center;justify-content:center;z-index:50;}
  .mon-back.open{display:flex;}
  .mon-modal{width:44%;min-width:520px;max-width:760px;max-height:80vh;overflow-y:auto;background:#150d24;border:1px solid #7CFC00;border-radius:10px;padding:1.3rem 1.5rem;font-family:'SF Mono',Menlo,Consolas,monospace;box-shadow:0 0 40px rgba(124,252,0,.15);}
  .mon-modal h2{color:#7CFC00;font-size:.85rem;letter-spacing:.2em;text-transform:uppercase;margin:0 0 1rem;text-shadow:0 0 8px rgba(124,252,0,.4);}
  .mon-sect{margin:0 0 1.3rem;}
  .mon-sect h3{color:#9ad46a;font-size:.68rem;letter-spacing:.12em;text-transform:uppercase;margin:0 0 .55rem;border-bottom:1px solid #2f2350;padding-bottom:.3rem;}
  .mon-feed{font-size:.68rem;line-height:1.5;}
  .mon-feed .ev{display:flex;gap:.6rem;color:#9ad46a;padding:.12rem 0;}
  .mon-feed .ev .t{color:#5a8a3a;min-width:58px;}
  .mon-feed .ev.err{color:#ff9b9b;}
  .mon-err{font-size:.66rem;color:#ff9b9b;background:#1a0d0d;border:1px solid #4a2020;border-radius:4px;padding:.4rem .6rem;margin:.3rem 0;white-space:pre-wrap;word-break:break-word;max-height:70px;overflow:hidden;}
  .ring-wrap{display:flex;justify-content:center;padding:.3rem 0 .1rem;}
  .ring-wrap svg{width:100%;max-width:700px;height:auto;}
  .ring-legend{display:flex;gap:.8rem;flex-wrap:wrap;justify-content:center;font-size:.58rem;color:#7a9a5a;margin-top:.2rem;letter-spacing:.05em;}
  .ring-legend span span{display:inline-block;width:8px;height:8px;border-radius:2px;vertical-align:-1px;margin-right:3px;}
  .dock-tip{position:fixed;display:none;z-index:60;pointer-events:none;max-width:240px;background:#0d0820;border:1px solid #7CFC00;border-radius:6px;padding:.45rem .6rem;font-size:.6rem;line-height:1.45;color:#9dff3c;box-shadow:0 0 16px rgba(124,252,0,.28);font-family:'SF Mono',Menlo,Consolas,monospace;}
  .dock-tip b{color:#7CFC00;letter-spacing:.06em;text-transform:uppercase;}
  .dock-tip .blurb{color:#9ad46a;margin:.22rem 0 .35rem;}
  .dock-tip .st{display:flex;justify-content:space-between;gap:1rem;color:#7a9a5a;}
  .dock-tip .st b{color:#9dff3c;text-transform:none;letter-spacing:0;font-weight:normal;}
  @media(max-width:640px){.mon-modal{width:92%;min-width:0;}}
</style></head>
<body><div class="wrap">
  <div class="mon" id="mon" title="click to expand">
    <div class="mon-hd"><span class="mon-ttl">▓ THE MONITOR</span><span class="mon-hint" id="mon-hint">click to expand ▸</span></div>
    <div class="mon-grid" id="mon-compact">
      <div class="mon-row"><span class="mon-lbl">CPU</span><span class="mon-bar"><span class="mon-fill" id="b-cpu" style="width:0%"></span></span><span class="mon-val" id="v-cpu">--</span></div>
      <div class="mon-row"><span class="mon-lbl">MEM</span><span class="mon-bar"><span class="mon-fill" id="b-mem" style="width:0%"></span></span><span class="mon-val" id="v-mem">--</span></div>
      <div class="mon-row"><span class="mon-lbl">DISK</span><span class="mon-bar"><span class="mon-fill" id="b-disk" style="width:0%"></span></span><span class="mon-val" id="v-disk">--</span></div>
      <div class="mon-row"><span class="mon-lbl">EMBED</span><span class="mon-bar"><span class="mon-fill" id="b-embed" style="width:0%"></span></span><span class="mon-val" id="v-embed">--</span></div>
      <div class="mon-row"><span class="mon-led led-off" id="l-mail"></span><span class="mon-lbl">MAIL</span><span class="mon-val" id="v-mail" style="text-align:left;color:#9ad46a">--</span></div>
      <div class="mon-row"><span class="mon-led led-off" id="l-cal"></span><span class="mon-lbl">CAL</span><span class="mon-val" id="v-cal" style="text-align:left;color:#9ad46a">--</span></div>
      <div class="mon-row"><span class="mon-led led-off" id="l-svc"></span><span class="mon-lbl">SVCS</span><span class="mon-val" id="v-svc" style="text-align:left;color:#9ad46a">--</span></div>
      <div class="mon-row"><span class="mon-led led-off" id="l-err"></span><span class="mon-lbl">ERRORS</span><span class="mon-val" id="v-err" style="text-align:left;color:#9ad46a">--</span></div>
    </div>
  </div>
  <div class="mon-back" id="mon-back">
    <div class="mon-modal" id="mon-modal">
      <h2>▓ SYSTEM MONITOR — GRANULAR</h2>
      <div class="mon-sect"><h3>Host / The Situation</h3><div id="mx-host" class="mon-feed"></div></div>
      <div class="mon-sect"><h3>THE DOCK</h3><div class="ring-wrap"><svg id="mx-ring" viewBox="0 0 720 130" xmlns="http://www.w3.org/2000/svg"></svg></div><div id="dock-tip" class="dock-tip"></div><div class="ring-legend"><span><span style="background:#7CFC00"></span>docked</span><span><span style="background:#e3b341"></span>busy</span><span><span style="background:#2a2440"></span>empty berth</span></div></div>
      <div class="mon-sect"><h3>Pipeline & Data</h3><div id="mx-data" class="mon-feed"></div></div>
      <div class="mon-sect"><h3>Recent Activity</h3><div id="mx-feed" class="mon-feed"></div></div>
      <div class="mon-sect"><h3>Errors</h3><div id="mx-err"></div></div>
    </div>
  </div>

  <h1><span class="dot"></span>Bentley OS</h1>

  <h2>Right now</h2>
  <div class="card now">
    <h3>Tasks</h3>
    <div id="tasklist">${tasksHtml}</div>
    <div class="addtask">
      <input id="tasktitle" type="text" placeholder="Add a task…" onkeydown="if(event.key==='Enter')addTask('medium')">
      <button class="pbtn" data-p="high" onclick="addTask('high')">High</button>
      <button class="pbtn" data-p="medium" onclick="addTask('medium')">Med</button>
      <button class="pbtn" data-p="low" onclick="addTask('low')">Low</button>
    </div>

    <h3>Needs attention${attnBadge}</h3>
    ${attnHtml}

    <h3>Next up</h3>
    ${upcomingHtml}
  </div>

  <details>
    <summary>Everything else</summary>
    <h2>Peripheral</h2>
    <div class="card">${periphHtml}</div>
    <h2>What changed${changedBadge}</h2>
    <div class="card">${changedHtml}</div>
    <h2>Earlier today</h2>
    <div class="card">${pastHtml}</div>
  </details>

  <p class="muted"><a href="/health">/health</a> · <span id="time"></span></p>
</div>
<script>
  document.getElementById('time').textContent = new Date().toLocaleString();
  function esc(s){var d=document.createElement('div');d.textContent=s==null?'':String(s);return d.innerHTML;}
  async function addTask(priority){
    var inp=document.getElementById('tasktitle');
    var title=inp.value.trim();
    if(!title)return;
    inp.disabled=true;
    try{
      var r=await fetch('/tasks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:title,priority:priority})});
      if(!r.ok)throw new Error('http '+r.status);
      var t=(await r.json()).task;
      var pri=(t.priority==='high'||t.priority==='low')?t.priority:'medium';
      var row=document.createElement('div');
      row.className='row task';row.dataset.id=t.id;
      row.innerHTML='<span class="pri pri-'+pri+'">'+pri+'</span>'+
        '<span class="body"><b>'+esc(t.title)+'</b></span>'+
        '<span class="done" onclick="markDone(\\''+t.id+'\\')" title="mark done">✓</span>';
      var list=document.getElementById('tasklist');
      var none=list.querySelector('.muted');if(none)none.remove();
      list.insertBefore(row,list.firstChild);
      inp.value='';
    }catch(e){alert('Could not add task: '+e.message);}
    inp.disabled=false;inp.focus();
  }
  async function markDone(id){
    var row=document.querySelector('.row.task[data-id="'+id+'"]');
    try{
      var r=await fetch('/tasks/'+id+'/done',{method:'POST'});
      if(!r.ok)throw new Error('http '+r.status);
      if(row){row.classList.add('fading');setTimeout(function(){row.remove();},350);}
    }catch(e){alert('Could not complete task: '+e.message);}
  }
  // ===== THE MONITOR =====
  (function(){
    function cls(p){return p>=90?'crit':p>=70?'warn':'';}
    function setBar(id,vid,p,txt){var b=document.getElementById(id),v=document.getElementById(vid);if(!b)return;p=Math.max(0,Math.min(100,p||0));b.style.width=p+'%';b.className='mon-fill '+cls(p);if(v)v.textContent=txt!=null?txt:p+'%';}
    function led(id,state){var e=document.getElementById(id);if(e)e.className='mon-led led-'+state;}
    function ago(ts){if(!ts)return 1e9;return (Date.now()-new Date(ts).getTime())/1000;}
    function fmtAgo(s){if(s>=1e8)return 'never';if(s<60)return Math.round(s)+'s';if(s<3600)return Math.round(s/60)+'m';return Math.round(s/3600)+'h';}
    function hhmm(ts){try{return new Date(ts).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:false});}catch(e){return '';}}

    var lastHost=null,lastApp=null;

    async function tick(){
      try{
        var[hr,ar]=await Promise.all([
          fetch('/metrics/host').then(r=>r.json()).catch(()=>({ok:false})),
          fetch('/metrics/app').then(r=>r.json()).catch(()=>({ok:false}))
        ]);
        lastHost=hr;lastApp=ar;
        // host bars
        var h=hr&&hr.host||{};
        setBar('b-cpu','v-cpu',h.cpu_pct,(h.cpu_pct==null?'--':h.cpu_pct+'%'));
        setBar('b-mem','v-mem',h.mem&&h.mem.used_pct,(h.mem?h.mem.used_pct+'%':'--'));
        setBar('b-disk','v-disk',h.disk&&h.disk.used_pct,(h.disk?h.disk.used_pct+'%':'--'));
        // services led
        var cs=h.containers||[];var down=cs.filter(function(c){return c.state!=='running';}).length;
        if(!cs.length){led('l-svc','off');setTxt('v-svc','--');}
        else{led('l-svc',down?'crit':'ok');setTxt('v-svc',down?down+' down':cs.length+' up');}
        // app: embed %
        var c=ar&&ar.counts||{};
        var emb=c.embedded||0,tot=(c.embedded||0)+(c.unembedded||0);
        var ep=tot?Math.round(emb/tot*100):100;
        setBar('b-embed','v-embed',ep,ep+'%');
        // sync leds
        var sync=(ar&&ar.sync)||[];
        var gm=sync.find(function(x){return x.source==='gmail';});
        var gc=sync.find(function(x){return x.source==='gcal';});
        function syncLed(lid,vid,row){var a=ago(row&&row.updated_at);led(lid,a<600?'ok':a<1800?'warn':'crit');setTxt(vid,fmtAgo(a));}
        syncLed('l-mail','v-mail',gm);syncLed('l-cal','v-cal',gc);
        // errors led
        var errs=(ar&&ar.errors)||[];
        var recentErr=errs.filter(function(e){return ago(e.at)<86400;}).length;
        led('l-err',recentErr?'crit':'ok');setTxt('v-err',recentErr?recentErr+' (24h)':'clean');
        if(document.getElementById('mon-back').classList.contains('open'))renderModal();
      }catch(e){/* keep last paint */}
    }
    function setTxt(id,t){var e=document.getElementById(id);if(e)e.textContent=t;}

    function renderModal(){
      var h=lastHost&&lastHost.host||{},a=lastApp||{};
      // host
      var hx='';
      if(h.cpu_pct!=null)hx+=evRow('CPU',h.cpu_pct+'%');
      if(h.mem)hx+=evRow('MEM',h.mem.used_pct+'%  ('+Math.round((h.mem.total_kb-h.mem.avail_kb)/1048576)+'/'+Math.round(h.mem.total_kb/1048576)+' GB)');
      if(h.disk)hx+=evRow('DISK',h.disk.used_pct+'%  ('+Math.round(h.disk.used_bytes/1e9)+'/'+Math.round(h.disk.total_bytes/1e9)+' GB)');
      if(h.load)hx+=evRow('LOAD',h.load.one+' / '+h.load.five+' / '+h.load.fifteen);
      if(h.uptime_sec)hx+=evRow('UPTIME',Math.floor(h.uptime_sec/86400)+'d '+Math.floor(h.uptime_sec%86400/3600)+'h');
      document.getElementById('mx-host').innerHTML=hx||'<div class="ev">host standby</div>';
      // containers -> the dock
      renderDock(h.containers||[]);
      // data
      var c=a.counts||{};
      var dx='';
      dx+=evRow('EMAILS',c.emails);dx+=evRow('EMBEDDED',c.embedded+' / '+((c.embedded||0)+(c.unembedded||0)));
      dx+=evRow('UNCLASSIFIED',c.unclassified);dx+=evRow('EVENTS',c.events);
      dx+=evRow('OPEN TASKS',c.open_tasks);dx+=evRow('PENDING ACTIONS',c.pending_actions);
      document.getElementById('mx-data').innerHTML=dx;
      // feed
      var rec=a.recent||[];
      document.getElementById('mx-feed').innerHTML=rec.map(function(r){
        var err=r.outcome!=='success'&&r.outcome!=='queued'&&r.outcome!=='running'&&r.outcome!=='recovered';
        return '<div class="ev'+(err?' err':'')+'"><span class="t">'+hhmm(r.at)+'</span><span>'+esc(r.action)+'</span><span class="t" style="margin-left:auto">'+esc(r.outcome)+'</span></div>';
      }).join('')||'<div class="ev">no activity</div>';
      // errors
      var errs=a.errors||[];
      document.getElementById('mx-err').innerHTML=errs.length?errs.map(function(e){
        return '<div class="mon-err">'+hhmm(e.at)+' · '+esc(e.action)+'<br>'+esc((e.detail||'').slice(0,180))+'</div>';
      }).join(''):'<div class="ev" style="color:#7CFC00;font-size:.7rem">no errors ▓</div>';
    }
    function ringTheme(name){
      if(/postgres|qdrant|redis/.test(name))return '#5dcaef';
      if(/marionette|contractor/.test(name))return '#c07bff';
      if(/deploy|portainer|dozzle|kuma|uptime/.test(name))return '#e3b341';
      return '#7CFC00';
    }
    var ringPhase={};var ringT=0;
    var dockInfo=[];var dockHover=-1;
    function dockMemPct(c){
      if(c&&c.mem){
        if(typeof c.mem.used_pct==='number')return c.mem.used_pct;
        if(c.mem.limit_bytes>0)return (c.mem.used_bytes/c.mem.limit_bytes)*100;
      }
      return 0;
    }
    function dockBlurb(name){
      if(/postgres/.test(name))return 'PostgreSQL — primary relational store for tasks, emails, and sync state.';
      if(/qdrant/.test(name))return 'Qdrant — vector database powering semantic search and embeddings recall.';
      if(/redis/.test(name))return 'Redis — in-memory cache and job queue broker.';
      if(/marionette/.test(name))return 'Marionette — the agent brain that plans and drives actions.';
      if(/contractor/.test(name))return 'Contractor — runs delegated work and background jobs.';
      if(/deploy/.test(name))return 'Deploy — build and release pipeline that ships new versions.';
      if(/whisper/.test(name))return 'Whisper — speech-to-text transcription service.';
      if(/cloudflared/.test(name))return 'Cloudflared — Cloudflare tunnel exposing services to the internet securely.';
      if(/portainer/.test(name))return 'Portainer — Docker management and container control UI.';
      if(/dozzle/.test(name))return 'Dozzle — live container log viewer.';
      if(/uptime|kuma/.test(name))return 'Uptime Kuma — uptime monitoring and status alerts.';
      if(/api/.test(name))return 'API — the core gateway serving this dashboard and all routes.';
      return 'Support service in the Bentley OS stack.';
    }
    function dockShowTip(el,idx){
      var t=document.getElementById('dock-tip');if(!t||dockInfo[idx]==null)return;
      dockHover=idx;
      t.innerHTML=dockInfo[idx];
      t.style.display='block';
      var r=el.getBoundingClientRect();
      var tw=t.offsetWidth,th=t.offsetHeight;
      var left=r.left+r.width/2-tw/2;
      var top=r.bottom+8;
      if(top+th>window.innerHeight-8)top=r.top-th-8;
      if(left<8)left=8;
      if(left+tw>window.innerWidth-8)left=window.innerWidth-8-tw;
      t.style.left=left+'px';t.style.top=top+'px';
    }
    function dockHideTip(){dockHover=-1;var t=document.getElementById('dock-tip');if(t)t.style.display='none';}
    function renderDock(all){
      var svg='';
      dockInfo=[];
      var n=all.length;
      var host=document.getElementById('mx-ring');if(!host)return;
      if(!n){host.innerHTML='';return;}
      var boxTop=24,boxH=64,boxBottom=88;
      var slotW=Math.min(60,720/n);
      var rowW=slotW*n;
      var startX=(720-rowW)/2;
      // dock floor line
      svg+='<line x1="'+startX.toFixed(1)+'" y1="'+(boxBottom+1)+'" x2="'+(startX+rowW).toFixed(1)+'" y2="'+(boxBottom+1)+'" stroke="#1e1838" stroke-width="1"/>';
      for(var i=0;i<n;i++){
        var c=all[i];
        var running=c.state==='running';
        var col=ringTheme(c.name);
        var short=c.name.replace('bentley-os-','').replace(/-1$/,'');
        var cellX=startX+i*slotW;
        var cx=cellX+slotW/2;
        var boxW=Math.min(46,slotW-14);
        var boxX=cx-boxW/2;
        var cpu=c.cpu_pct||0;
        var mp=dockMemPct(c);
        var load=(cpu+mp)/2;if(load<0)load=0;if(load>100)load=100;
        var busy=running&&load>=90;
        svg+='<g class="dock-berth" data-i="'+i+'" style="cursor:pointer">';
        // transparent hit area for easy hover
        svg+='<rect x="'+cellX.toFixed(1)+'" y="0" width="'+slotW.toFixed(1)+'" height="130" fill="transparent"/>';
        if(running){
          if(ringPhase[c.name]==null)ringPhase[c.name]=Math.random()*6.28;
          var ph=ringPhase[c.name];
          var lvl=(load/100)+Math.sin(ringT*1.5+ph)*0.03;if(lvl<0)lvl=0;if(lvl>1)lvl=1;
          var fillH=lvl*boxH;var fillY=boxBottom-fillH;
          var clipId='dk'+i;
          svg+='<clipPath id="'+clipId+'"><rect x="'+boxX.toFixed(1)+'" y="'+boxTop+'" width="'+boxW.toFixed(1)+'" height="'+boxH+'" rx="6"/></clipPath>';
          svg+='<rect x="'+boxX.toFixed(1)+'" y="'+boxTop+'" width="'+boxW.toFixed(1)+'" height="'+boxH+'" rx="6" fill="#0d0820" stroke="'+col+'" stroke-width="1.3"/>';
          svg+='<g clip-path="url(#'+clipId+')"><rect x="'+boxX.toFixed(1)+'" y="'+fillY.toFixed(1)+'" width="'+boxW.toFixed(1)+'" height="'+fillH.toFixed(1)+'" fill="'+col+'" fill-opacity="0.5"/>';
          svg+='<rect x="'+boxX.toFixed(1)+'" y="'+fillY.toFixed(1)+'" width="'+boxW.toFixed(1)+'" height="1.6" fill="'+col+'" fill-opacity="0.9"/></g>';
          // status lamp
          if(busy){
            var ap=(Math.sin(ringT*3+ph)*0.5+0.5);
            svg+='<circle cx="'+cx.toFixed(1)+'" cy="13" r="'+(5.5+ap*3).toFixed(1)+'" fill="#e3b341" fill-opacity="'+(0.28*ap+0.06).toFixed(2)+'"/>';
            svg+='<circle cx="'+cx.toFixed(1)+'" cy="13" r="3.2" fill="#e3b341"/>';
          } else {
            svg+='<circle cx="'+cx.toFixed(1)+'" cy="13" r="7" fill="#7CFC00" fill-opacity="0.16"/>';
            svg+='<circle cx="'+cx.toFixed(1)+'" cy="13" r="3.2" fill="#7CFC00"/>';
          }
          svg+='<text x="'+cx.toFixed(1)+'" y="103" text-anchor="middle" fill="#7a9a5a" font-size="6.5">'+esc(short)+'</text>';
        } else {
          // dark empty berth
          svg+='<rect x="'+boxX.toFixed(1)+'" y="'+boxTop+'" width="'+boxW.toFixed(1)+'" height="'+boxH+'" rx="6" fill="none" stroke="#2a2440" stroke-width="1" stroke-dasharray="3 3"/>';
          svg+='<circle cx="'+cx.toFixed(1)+'" cy="13" r="3.2" fill="#1e1838" stroke="#2a2440" stroke-width="0.8"/>';
          svg+='<text x="'+cx.toFixed(1)+'" y="103" text-anchor="middle" fill="#4a4560" font-size="6.5">'+esc(short)+'</text>';
        }
        svg+='</g>';
        // tooltip content
        var memTxt=(c.mem?Math.round(mp)+'%':'n/a');
        var tip='<b>'+esc(short)+'</b>';
        tip+='<div class="blurb">'+dockBlurb(c.name)+'</div>';
        tip+='<div class="st">state<b>'+esc(c.state)+'</b></div>';
        tip+='<div class="st">cpu<b>'+(running?Math.round(cpu)+'%':'—')+'</b></div>';
        tip+='<div class="st">mem<b>'+(running?memTxt:'—')+'</b></div>';
        tip+='<div class="st">load<b>'+(running?Math.round(load)+'%':'—')+'</b></div>';
        dockInfo[i]=tip;
      }
      host.innerHTML=svg;
      var berths=host.querySelectorAll('.dock-berth');
      for(var b=0;b<berths.length;b++){(function(g){
        var idx=+g.getAttribute('data-i');
        g.addEventListener('mouseenter',function(){dockShowTip(g,idx);});
        g.addEventListener('mouseleave',dockHideTip);
      })(berths[b]);}
      // keep tooltip live/synced if still hovering across re-render
      if(dockHover>=0){
        if(dockHover<dockInfo.length){
          var tt=document.getElementById('dock-tip');
          if(tt&&tt.style.display==='block')tt.innerHTML=dockInfo[dockHover];
        } else { dockHideTip(); }
      }
    }
    function evRow(l,v){return '<div class="ev"><span class="t" style="min-width:120px">'+esc(l)+'</span><span>'+esc(v)+'</span></div>';}

    var mon=document.getElementById('mon'),back=document.getElementById('mon-back'),modal=document.getElementById('mon-modal');
    if(mon){mon.addEventListener('click',function(){renderModal();back.classList.add('open');});}
    if(back){back.addEventListener('click',function(e){if(e.target===back)back.classList.remove('open');});}
    document.addEventListener('keydown',function(e){if(e.key==='Escape'&&back)back.classList.remove('open');});

    setInterval(function(){
      ringT+=0.12;
      if(document.getElementById('mon-back').classList.contains('open')&&lastHost&&lastHost.host){
        renderDock(lastHost.host.containers||[]);
      }
    },80);
    tick();setInterval(tick,4000);
  })();

</script>
</body></html>`);
});
