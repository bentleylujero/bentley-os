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
</style></head>
<body><div class="wrap">
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
</script>
</body></html>`);
});
