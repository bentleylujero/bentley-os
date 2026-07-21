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
  let actions: any[] = [];
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

    // Mari's action lifecycle — current state lives on the row; audit_log is the ledger.
    const actionsQ = pool.query(
      `SELECT id, kind, status, intent, result, created_at
         FROM actions
        ORDER BY created_at DESC
        LIMIT 8`
    );
    const [tasksR, attnR, periphR, upcomingR, pastR, newEmailsR, newEventsR, actionsR] =
      await Promise.all([
        tasksQ,
        attnQ,
        periphQ,
        upcomingQ,
        pastQ,
        newEmailsQ,
        newEventsQ,
        actionsQ,
      ]);
    tasks = tasksR.rows;
    attnEmails = attnR.rows;
    periphEmails = periphR.rows;
    upcomingEvents = upcomingR.rows;
    pastEvents = pastR.rows;
    newEmails = newEmailsR.rows;
    newEvents = newEventsR.rows;
    actions = actionsR.rows;
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

  // --- Actions (M4 lifecycle) ---------------------------------------------
  function actionRow(a: any): string {
    const st = String(a.status || 'proposed');
    const svc = a.intent && a.intent.service ? String(a.intent.service) : '';
    const reason = a.result && a.result.reason ? String(a.result.reason) : '';
    return `<div class="row">
        <span class="time">${esc(fmtStamp(a.created_at))}</span>
        <span class="body"><span class="tag act-${esc(st)}">${esc(st)}</span> <b>${esc(a.kind)}</b>${
      svc ? `<span class="sub"> · ${esc(svc)}</span>` : ''
    }${reason ? `<span class="sub"> — ${escT(reason)}</span>` : ''}</span>
      </div>`;
  }
  const actionsHtml = dbError
    ? ''
    : actions.length === 0
    ? `<p class="empty-ph">No actions yet. Standing by ▓</p>`
    : actions.map(actionRow).join('');
  const pendingCount = actions.filter((a) => a.status === 'proposed').length;
  const actionsBadge =
    pendingCount > 0 ? ` <span class="count">${pendingCount}</span>` : '';
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
  /* ======================================================================
     CRT SHELL — two colors only: phosphor green + purple. No other hues.
     Priority/score tiers differentiate by BRIGHTNESS + BORDER WEIGHT, never hue.
     ====================================================================== */
  :root{
    --green:#7CFC00;          /* bright phosphor */
    --green-dim:#9ad46a;      /* mid */
    --green-faint:#5a8a3a;    /* faint / labels */
    --green-ghost:#3a5a26;    /* borders, dividers */
    --purple-bg:#150d24;      /* card / panel bg */
    --purple-bg2:#0d0820;     /* deepest bg */
    --purple-bg3:#100a1c;     /* mid bg (inputs, tracks) */
    --purple-border:#3a2a5c;  /* default border */
    --purple-accent:#c07bff;  /* purple highlight — used sparingly */
    --text:#c8f0a0;           /* body text (green-tinted) */
  }
  *{box-sizing:border-box;}
  html,body{margin:0;height:100%;}
  body{
    background:var(--purple-bg2);
    color:var(--text);
    font-family:'SF Mono',ui-monospace,Menlo,Consolas,monospace;
    overflow:hidden;
  }
  /* global scanline texture overlay */
  body::after{
    content:'';position:fixed;inset:0;pointer-events:none;z-index:100;
    background:repeating-linear-gradient(0deg,rgba(124,252,0,0.025) 0 1px,transparent 1px 3px);
    mix-blend-mode:screen;
  }
  /* ---- viewport grid: sidebar | main | (chatbar floats) ---- */
  .app{
    display:grid;
    grid-template-columns:200px 1fr;
    grid-template-rows:1fr;
    height:100vh;
    width:100vw;
  }
  /* ---- SIDEBAR ---- */
  .side{
    background:var(--purple-bg);
    border-right:1px solid var(--purple-border);
    display:flex;flex-direction:column;
    padding:1.1rem .8rem;
    overflow-y:auto;
  }
  .brand{
    color:var(--green);
    font-size:.92rem;letter-spacing:.14em;text-transform:uppercase;
    text-shadow:0 0 8px rgba(124,252,0,.45);
    padding:.2rem .3rem 1.1rem;
    display:flex;align-items:center;gap:.5rem;
  }
  .brand .blip{width:9px;height:9px;border-radius:50%;background:var(--green);box-shadow:0 0 8px var(--green);animation:blink 2.4s infinite;}
  .nav{display:flex;flex-direction:column;gap:.15rem;flex:1;}
  .navi{
    display:flex;align-items:center;gap:.6rem;
    padding:.5rem .55rem;border-radius:5px;
    color:var(--green-dim);
    font-size:.72rem;letter-spacing:.1em;text-transform:uppercase;
    border:1px solid transparent;cursor:default;user-select:none;
    transition:background .15s,border-color .15s,color .15s;
  }
  .navi[data-live="1"]{cursor:pointer;}
  .navi:hover{background:var(--purple-bg3);border-color:var(--purple-border);color:var(--green);}
  .navi .nd{width:7px;height:7px;border-radius:50%;flex-shrink:0;background:var(--green-faint);}
  .navi .nd.on{background:var(--green);box-shadow:0 0 6px var(--green);}
  .navi .nd.busy{background:var(--purple-accent);box-shadow:0 0 6px var(--purple-accent);}
  .side-foot{font-size:.58rem;color:var(--green-faint);letter-spacing:.08em;padding:.6rem .4rem 0;border-top:1px solid var(--purple-border);margin-top:.6rem;}
  .side-foot a{color:var(--green-faint);text-decoration:none;}
  .side-foot a:hover{color:var(--green);}
  /* ---- MAIN ---- */
  .main{
    overflow-y:auto;
    padding:1.2rem 1.4rem 6rem;   /* bottom pad clears the floating chatbar */
  }
  .grid{
    display:grid;
    grid-template-columns:repeat(auto-fit,minmax(340px,1fr));
    gap:1rem;
    align-items:start;
  }
  .card{
    background:var(--purple-bg);
    border:1px solid var(--purple-border);
    border-radius:9px;
    padding:1rem 1.15rem;
  }
  .card.now{border-color:var(--green-ghost);box-shadow:0 0 0 1px rgba(124,252,0,.08) inset,0 0 22px rgba(124,252,0,.05);}
  .card.span2{grid-column:1 / -1;}
  .ch{
    color:var(--green);
    font-size:.82rem;letter-spacing:.12em;text-transform:uppercase;
    margin:0 0 .7rem;
    text-shadow:0 0 7px rgba(124,252,0,.35);
    display:flex;align-items:center;gap:.4rem;
  }
  .sh{
    color:var(--green-dim);
    font-size:.68rem;letter-spacing:.12em;text-transform:uppercase;
    margin:1rem 0 .4rem;font-weight:bold;
    border-bottom:1px solid var(--purple-border);padding-bottom:.25rem;
  }
  .sh:first-child{margin-top:0;}
  .row{display:flex;gap:.8rem;padding:.4rem 0;border-bottom:1px solid rgba(58,42,92,.5);align-items:baseline;}
  .row:last-child{border-bottom:none;}
  .row.task{transition:opacity .35s ease;}
  .row.fading{opacity:0;}
  .time{color:var(--green-faint);font-size:.78rem;min-width:84px;white-space:nowrap;font-variant-numeric:tabular-nums;}
  .body{flex:1;overflow:hidden;}
  .sub{color:var(--green-faint);font-weight:normal;}
  .unread{color:var(--green);text-shadow:0 0 5px var(--green);}
  .tag{display:inline-block;font-size:.62rem;text-transform:uppercase;letter-spacing:.06em;color:var(--green-dim);border:1px solid var(--purple-border);border-radius:4px;padding:0 5px;margin-right:4px;}
  .act-proposed{color:var(--green);border-color:var(--green-ghost);}
  .act-approved{color:var(--green);border-color:var(--green-ghost);}
  .act-executing{color:var(--green);border-color:var(--green);}
  .act-succeeded{color:var(--green-dim);border-color:var(--purple-border);}
  .act-failed{color:#ff6b6b;border-color:#ff6b6b;}
  .act-denied{color:var(--green-dim);border-color:var(--purple-border);opacity:.6;}
  .count{display:inline-block;background:transparent;color:var(--green);font-size:.66rem;border:1px solid var(--green-ghost);border-radius:9px;padding:0 7px;margin-left:6px;vertical-align:middle;text-shadow:0 0 5px rgba(124,252,0,.4);}
  /* score chips — brightness/border only, no hue shift */
  .score{min-width:34px;text-align:center;font-size:.78rem;font-weight:bold;border-radius:6px;padding:2px 0;height:fit-content;font-variant-numeric:tabular-nums;}
  .score-high{background:rgba(124,252,0,.14);color:var(--green);border:1px solid var(--green);text-shadow:0 0 6px rgba(124,252,0,.5);}
  .score-mid{background:rgba(124,252,0,.06);color:var(--green-dim);border:1px solid var(--green-ghost);}
  .score-low{background:transparent;color:var(--green-faint);border:1px dashed var(--purple-border);}
  /* priority bands — same brightness ladder */
  .pri{min-width:58px;text-align:center;font-size:.62rem;font-weight:bold;text-transform:uppercase;letter-spacing:.05em;border-radius:6px;padding:3px 0;height:fit-content;}
  .pri-high{background:rgba(124,252,0,.14);color:var(--green);border:1px solid var(--green);text-shadow:0 0 6px rgba(124,252,0,.5);}
  .pri-medium{background:rgba(124,252,0,.06);color:var(--green-dim);border:1px solid var(--green-ghost);}
  .pri-low{background:transparent;color:var(--green-faint);border:1px dashed var(--purple-border);}
  .done{color:var(--green);cursor:pointer;font-weight:bold;padding:0 4px;opacity:.5;user-select:none;}
  .done:hover{opacity:1;text-shadow:0 0 6px var(--green);}
  .addtask{display:flex;gap:.5rem;margin-top:.75rem;flex-wrap:wrap;align-items:center;}
  .addtask input{flex:1;min-width:160px;background:var(--purple-bg3);border:1px solid var(--purple-border);border-radius:6px;color:var(--text);padding:.4rem .6rem;font-family:inherit;font-size:.82rem;}
  .addtask input:focus{outline:none;border-color:var(--green);box-shadow:0 0 8px rgba(124,252,0,.25);}
  .pbtn{background:var(--purple-bg3);border:1px solid var(--purple-border);border-radius:6px;color:var(--green-dim);padding:.4rem .7rem;font-family:inherit;font-size:.66rem;text-transform:uppercase;letter-spacing:.05em;cursor:pointer;transition:border-color .15s,color .15s;}
  .pbtn[data-p="high"]:hover{border-color:var(--green);color:var(--green);text-shadow:0 0 5px var(--green);}
  .pbtn[data-p="medium"]:hover{border-color:var(--green-ghost);color:var(--green-dim);}
  .pbtn[data-p="low"]:hover{border-color:var(--purple-border);color:var(--text);}
  .docdrop{margin-top:.75rem;border:1px dashed var(--purple-border);border-radius:6px;padding:.5rem .6rem;color:var(--green-faint);font-size:.66rem;text-transform:uppercase;letter-spacing:.06em;cursor:pointer;transition:border-color .15s,color .15s;text-align:center;}
  .docdrop:hover,.docdrop.drag{border-color:var(--green);color:var(--green-dim);}
  .docdrop b{color:var(--green-dim);text-transform:none;letter-spacing:0;}
  #doclist{margin-top:.4rem;}
  #doclist .docrow{font-size:.7rem;color:var(--green-dim);padding:.2rem 0;}
  #doclist .docrow .ok{color:var(--green);margin-right:.4rem;}
  .muted{color:var(--green-faint);font-size:.8rem;}
  .empty-ph{color:var(--green-faint);font-size:.78rem;padding:1.5rem .5rem;text-align:center;border:1px dashed var(--purple-border);border-radius:7px;letter-spacing:.05em;}
  /* ---- FLOATING CHATBAR ---- */
  .chatbar{
    position:fixed;left:216px;right:20px;bottom:16px;z-index:40;
    background:var(--purple-bg);
    border:1px solid var(--purple-border);
    border-radius:10px;
    box-shadow:0 0 30px rgba(13,8,32,.7),0 0 0 1px rgba(124,252,0,.04) inset;
    padding:.55rem .6rem;
    display:flex;flex-direction:column;gap:.4rem;
  }
  .chat-log{display:flex;flex-direction:column;gap:.25rem;max-height:120px;overflow-y:auto;padding:0 .2rem;}
  .chat-log:empty{display:none;}
  .chat-msg{font-size:.72rem;color:var(--green-dim);padding:.2rem .35rem;border-left:2px solid var(--green-ghost);}
  .chat-in{display:flex;gap:.5rem;align-items:center;}
  .chat-in .prompt{color:var(--green);font-size:.8rem;text-shadow:0 0 6px rgba(124,252,0,.4);padding-left:.3rem;}
  .chat-in input{flex:1;background:transparent;border:none;color:var(--text);font-family:inherit;font-size:.85rem;padding:.35rem .2rem;}
  .chat-in input:focus{outline:none;}
  .chat-in input::placeholder{color:var(--green-faint);}
  /* ===== THE MONITOR — modal only (compact bar removed; opened from sidebar) ===== */
  .mon-back{position:fixed;inset:0;background:rgba(5,3,12,.45);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);display:none;align-items:center;justify-content:center;z-index:80;}
  .mon-back.open{display:flex;}
  .mon-modal{width:44%;min-width:520px;max-width:760px;max-height:82vh;overflow-y:auto;background:var(--purple-bg);border:1px solid var(--green);border-radius:10px;padding:1.3rem 1.5rem;font-family:'SF Mono',Menlo,Consolas,monospace;box-shadow:0 0 40px rgba(124,252,0,.15);}
  .mon-modal h2{color:var(--green);font-size:.85rem;letter-spacing:.2em;text-transform:uppercase;margin:0 0 1rem;text-shadow:0 0 8px rgba(124,252,0,.4);}
  .mon-sect{margin:0 0 1.3rem;}
  .mon-sect h3{color:var(--green-dim);font-size:.68rem;letter-spacing:.12em;text-transform:uppercase;margin:0 0 .55rem;border-bottom:1px solid var(--purple-border);padding-bottom:.3rem;}
  .mon-feed{font-size:.68rem;line-height:1.5;}
  .mon-feed .ev{display:flex;gap:.6rem;color:var(--green-dim);padding:.12rem 0;}
  .mon-feed .ev .t{color:var(--green-faint);min-width:58px;}
  .mon-feed .ev.err{color:var(--green);opacity:.85;}
  .mon-err{font-size:.66rem;color:var(--green-dim);background:var(--purple-bg2);border:1px solid var(--purple-accent);border-radius:4px;padding:.4rem .6rem;margin:.3rem 0;white-space:pre-wrap;word-break:break-word;max-height:70px;overflow:hidden;}
  .ring-wrap{display:flex;justify-content:center;padding:.3rem 0 .1rem;}
  .ring-wrap svg{width:100%;max-width:700px;height:auto;}
  .ring-legend{display:flex;gap:.8rem;flex-wrap:wrap;justify-content:center;font-size:.58rem;color:var(--green-faint);margin-top:.2rem;letter-spacing:.05em;}
  .ring-legend span span{display:inline-block;width:8px;height:8px;border-radius:2px;vertical-align:-1px;margin-right:3px;}
  .dock-tip{position:fixed;display:none;z-index:90;pointer-events:none;max-width:240px;background:var(--purple-bg2);border:1px solid var(--green);border-radius:6px;padding:.45rem .6rem;font-size:.6rem;line-height:1.45;color:var(--green-dim);box-shadow:0 0 16px rgba(124,252,0,.28);font-family:'SF Mono',Menlo,Consolas,monospace;}
  .dock-tip b{color:var(--green);letter-spacing:.06em;text-transform:uppercase;}
  .dock-tip .blurb{color:var(--green-dim);margin:.22rem 0 .35rem;}
  .dock-tip .st{display:flex;justify-content:space-between;gap:1rem;color:var(--green-faint);}
  .dock-tip .st b{color:var(--green);text-transform:none;letter-spacing:0;font-weight:normal;}
  /* CPU digital twin — 8-cell die grid, driven by REAL aggregate heat */
  .cpu-twin{display:flex;align-items:center;justify-content:center;gap:1.4rem;padding:.2rem 0 .1rem;}
  .cpu-socket{position:relative;display:grid;grid-template-columns:repeat(4,1fr);gap:6px;padding:12px;background:var(--purple-bg2);border:1px solid var(--purple-border);border-radius:6px;box-shadow:inset 0 0 14px rgba(0,0,0,.55);}
  .cpu-socket::before{content:'';position:absolute;top:4px;left:4px;width:7px;height:7px;border-top:1px solid var(--purple-border);border-left:1px solid var(--purple-border);}
  .cpu-socket::after{content:'';position:absolute;inset:0;pointer-events:none;border-radius:6px;background:repeating-linear-gradient(0deg,rgba(124,252,0,0.03) 0 1px,transparent 1px 3px);}
  .cpu-core{width:22px;height:22px;border-radius:3px;background:var(--purple-bg3);transition:background .5s ease,box-shadow .5s ease;}
  .cpu-agg{text-align:center;min-width:96px;}
  .cpu-agg-val{font-size:2.1rem;line-height:1;color:var(--green);text-shadow:0 0 14px rgba(124,252,0,.55);font-variant-numeric:tabular-nums;}
  .cpu-agg-lbl{font-size:.6rem;color:var(--green-faint);letter-spacing:.24em;text-transform:uppercase;margin-top:.3rem;}
  .cpu-agg-sub{font-size:.55rem;color:var(--green-faint);letter-spacing:.08em;margin-top:.35rem;}
  /* core-four vitals gauges */
  .gauge-row{display:flex;justify-content:space-around;align-items:flex-end;gap:.6rem;flex-wrap:wrap;}
  .gauge{display:flex;flex-direction:column;align-items:center;flex:1;min-width:74px;}
  .g-svg{width:100%;max-width:96px;height:auto;}
  .g-num{fill:var(--green);font-size:15px;font-family:ui-monospace,monospace;font-variant-numeric:tabular-nums;}
  .g-lbl{font-size:.58rem;color:var(--green-faint);letter-spacing:.16em;text-transform:uppercase;margin-top:.15rem;}
  .load-gauge{justify-content:flex-end;}
  .load-bars{width:100%;max-width:96px;display:flex;flex-direction:column;gap:5px;padding:0 2px 8px;}
  .lb{display:flex;align-items:center;gap:.4rem;font-size:.55rem;color:var(--green-faint);}
  .lb-t{min-width:22px;letter-spacing:.05em;}
  .lb-track{flex:1;height:7px;background:var(--purple-bg3);border:1px solid var(--purple-border);border-radius:2px;overflow:hidden;}
  .lb-fill{display:block;height:100%;width:0;background:var(--green);box-shadow:0 0 6px rgba(124,252,0,.5);transition:width .5s ease;}
  @keyframes blink{50%{opacity:.3;}}
  @media(max-width:820px){
    .app{grid-template-columns:56px 1fr;}
    .brand span.txt,.navi span.lbl,.side-foot{display:none;}
    .navi{justify-content:center;}
    .chatbar{left:72px;}
  }
  @media(max-width:640px){.mon-modal{width:92%;min-width:0;}}
</style></head>
<body>
<div class="app">
  <!-- ================= SIDEBAR ================= -->
  <aside class="side">
    <div class="brand"><span class="blip"></span><span class="txt">Bentley OS</span></div>
    <nav class="nav">
      <div class="navi" title="Right Now"><span class="nd on"></span><span class="lbl">Right Now</span></div>
      <div class="navi" data-live="1" id="nav-svc" title="Services — open THE MONITOR"><span class="nd on" id="nav-svc-dot"></span><span class="lbl">Services</span></div>
      <div class="navi" title="Inbox"><span class="nd on"></span><span class="lbl">Inbox</span></div>
      <div class="navi" title="Calendar"><span class="nd on"></span><span class="lbl">Calendar</span></div>
      <div class="navi" title="Tasks"><span class="nd on"></span><span class="lbl">Tasks</span></div>
      <div class="navi" title="Actions"><span class="nd"></span><span class="lbl">Actions</span></div>
    </nav>
    <div class="side-foot"><a href="/health">/health</a> · <span id="time"></span></div>
  </aside>

  <!-- ================= MAIN ================= -->
  <main class="main">
    <div class="grid">
      <!-- RIGHT NOW -->
      <section class="card now">
        <div class="ch">▸ Right Now</div>
        <div class="sh">Tasks</div>
        <div id="tasklist">${tasksHtml}</div>
        <div class="addtask">
          <input id="tasktitle" type="text" placeholder="Add a task…" onkeydown="if(event.key==='Enter')addTask('medium')">
          <button class="pbtn" data-p="high" onclick="addTask('high')">High</button>
          <button class="pbtn" data-p="medium" onclick="addTask('medium')">Med</button>
          <button class="pbtn" data-p="low" onclick="addTask('low')">Low</button>
        </div>
        <div class="docdrop" id="docdrop" onclick="document.getElementById('docfile').click()">
          Drop a doc here or <b>click to upload</b> (.md / .txt / .docx / .pptx / .pdf)
        </div>
        <input id="docfile" type="file" accept=".md,.txt,.docx,.pptx,.pdf,text/markdown,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.presentationml.presentation" style="display:none">
        <div id="doclist"></div>
      </section>

      <!-- NEEDS ATTENTION -->
      <section class="card">
        <div class="ch">▸ Needs Attention${attnBadge}</div>
        ${attnHtml}
      </section>

      <!-- NEXT UP -->
      <section class="card">
        <div class="ch">▸ Next Up</div>
        ${upcomingHtml}
      </section>

      <!-- PERIPHERAL -->
      <section class="card">
        <div class="ch">▸ Peripheral</div>
        ${periphHtml}
      </section>

      <!-- WHAT CHANGED -->
      <section class="card">
        <div class="ch">▸ What Changed${changedBadge}</div>
        ${changedHtml}
      </section>

      <!-- EARLIER TODAY -->
      <section class="card">
        <div class="ch">▸ Earlier Today</div>
        ${pastHtml}
      </section>

      <!-- ACTIONS -->
      <section class="card">
        <div class="ch">▸ Actions${actionsBadge}</div>
        ${actionsHtml}
      </section>
    </div>
  </main>
</div>

<!-- ================= FLOATING CHATBAR (stub) ================= -->
<div class="chatbar">
  <div class="chat-log" id="chat-log"></div>
  <div class="chat-in">
    <span class="prompt">&gt;</span>
    <input id="chat-input" type="text" placeholder="Ask Bentley OS…" onkeydown="if(event.key==='Enter')chatSubmit()">
  </div>
</div>

<!-- ================= THE MONITOR modal ================= -->
<div class="mon-back" id="mon-back">
  <div class="mon-modal" id="mon-modal">
    <h2>▓ SYSTEM MONITOR — GRANULAR</h2>
    <div class="mon-sect"><h3>Host / The Situation</h3><div id="mx-host" class="mon-feed"></div></div>
    <div class="mon-sect"><h3>THE DOCK</h3><div class="ring-wrap"><svg id="mx-ring" viewBox="0 0 720 130" xmlns="http://www.w3.org/2000/svg"></svg></div><div id="dock-tip" class="dock-tip"></div><div class="ring-legend"><span><span style="background:#7CFC00"></span>docked</span><span><span style="background:#c07bff"></span>busy</span><span><span style="background:#2a2440"></span>empty berth</span></div></div>
    <div class="mon-sect"><h3>CPU Digital Twin</h3><div class="cpu-twin"><div class="cpu-socket" id="cpu-die"></div><div class="cpu-agg"><div class="cpu-agg-val" id="cpu-agg">--</div><div class="cpu-agg-lbl">CPU</div><div class="cpu-agg-sub" id="cpu-agg-sub">8 cores</div></div></div></div>
    <div class="mon-sect"><h3>Core Vitals</h3><div class="gauge-row">
      <div class="gauge"><svg class="g-svg" viewBox="0 0 90 66"><path d="M10,55 A35,35 0 0,1 80,55" stroke="#3a2a5c" stroke-width="6" fill="none" stroke-linecap="round"></path><path id="g-cpu-arc" d="M10,55 A35,35 0 0,1 10,55" stroke="#7CFC00" stroke-width="6" fill="none" stroke-linecap="round"></path><text id="g-cpu-num" x="45" y="50" text-anchor="middle" class="g-num">--</text></svg><div class="g-lbl">CPU</div></div>
      <div class="gauge"><svg class="g-svg" viewBox="0 0 90 66"><path d="M10,55 A35,35 0 0,1 80,55" stroke="#3a2a5c" stroke-width="6" fill="none" stroke-linecap="round"></path><path id="g-mem-arc" d="M10,55 A35,35 0 0,1 10,55" stroke="#7CFC00" stroke-width="6" fill="none" stroke-linecap="round"></path><text id="g-mem-num" x="45" y="50" text-anchor="middle" class="g-num">--</text></svg><div class="g-lbl">MEM</div></div>
      <div class="gauge"><svg class="g-svg" viewBox="0 0 90 66"><path d="M10,55 A35,35 0 0,1 80,55" stroke="#3a2a5c" stroke-width="6" fill="none" stroke-linecap="round"></path><path id="g-disk-arc" d="M10,55 A35,35 0 0,1 10,55" stroke="#7CFC00" stroke-width="6" fill="none" stroke-linecap="round"></path><text id="g-disk-num" x="45" y="50" text-anchor="middle" class="g-num">--</text></svg><div class="g-lbl">DISK</div></div>
      <div class="gauge load-gauge"><div class="load-bars"><div class="lb"><span class="lb-t">1m</span><span class="lb-track"><span class="lb-fill" id="ld-1"></span></span></div><div class="lb"><span class="lb-t">5m</span><span class="lb-track"><span class="lb-fill" id="ld-5"></span></span></div><div class="lb"><span class="lb-t">15m</span><span class="lb-track"><span class="lb-fill" id="ld-15"></span></span></div></div><div class="g-lbl">LOAD</div></div>
    </div></div>
    <div class="mon-sect"><h3>Pipeline & Data</h3><div id="mx-data" class="mon-feed"></div></div>
    <div class="mon-sect"><h3>Recent Activity</h3><div id="mx-feed" class="mon-feed"></div></div>
    <div class="mon-sect"><h3>Errors</h3><div id="mx-err"></div></div>
  </div>
</div>

<script>
  document.getElementById('time').textContent = new Date().toLocaleTimeString();
  function esc(s){var d=document.createElement('div');d.textContent=s==null?'':String(s);return d.innerHTML;}

  // ===== tasks =====
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

  // ===== document upload =====
  // Thin multipart POST to /documents. api writes the row; marionette embeds it
  // later via the /embed-doc drain. No content-type header — the browser sets the
  // multipart boundary itself.
  async function uploadDoc(file){
    if(!file)return;
    var fd=new FormData();
    fd.append('file',file);
    try{
      var r=await fetch('/documents',{method:'POST',body:fd});
      if(!r.ok)throw new Error('http '+r.status);
      var d=(await r.json()).document;
      var row=document.createElement('div');
      row.className='docrow';
      row.innerHTML='<span class="ok">✓</span><b>'+esc(d.title)+'</b> queued';
      var list=document.getElementById('doclist');
      list.insertBefore(row,list.firstChild);
    }catch(e){alert('Could not upload document: '+e.message);}
  }
  (function(){
    var zone=document.getElementById('docdrop');
    var picker=document.getElementById('docfile');
    picker.addEventListener('change',function(){
      if(picker.files&&picker.files[0])uploadDoc(picker.files[0]);
      picker.value='';
    });
    zone.addEventListener('dragover',function(e){e.preventDefault();zone.classList.add('drag');});
    zone.addEventListener('dragleave',function(){zone.classList.remove('drag');});
    zone.addEventListener('drop',function(e){
      e.preventDefault();zone.classList.remove('drag');
      if(e.dataTransfer&&e.dataTransfer.files&&e.dataTransfer.files[0])uploadDoc(e.dataTransfer.files[0]);
    });
  })();

  // ===== chatbar (STUB: wire to marionette /think next pass) =====
  function chatSubmit(){
    var inp=document.getElementById('chat-input');
    var txt=inp.value.trim();
    if(!txt)return;
    var log=document.getElementById('chat-log');
    var m=document.createElement('div');
    m.className='chat-msg';
    m.textContent='> '+txt;
    log.appendChild(m);
    log.scrollTop=log.scrollHeight;
    inp.value='';
    // STUB: no fetch. Next pass forwards to marionette /think, same thin-forward
    // pattern as the Telegram webhook — no reasoning in api (Bible §9).
  }

  // ===== THE MONITOR =====
  (function(){
    function led(id,state){var e=document.getElementById(id);if(e)e.className='nd '+(state==='off'?'':state);}
    function ago(ts){if(!ts)return 1e9;return (Date.now()-new Date(ts).getTime())/1000;}
    function fmtAgo(s){if(s>=1e8)return 'never';if(s<60)return Math.round(s)+'s';if(s<3600)return Math.round(s/60)+'m';return Math.round(s/3600)+'h';}
    function hhmm(ts){try{return new Date(ts).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:false});}catch(e){return '';}}
    function setTxt(id,t){var e=document.getElementById(id);if(e)e.textContent=t;}

    var lastHost=null,lastApp=null;

    async function tick(){
      try{
        var res=await Promise.all([
          fetch('/metrics/host').then(function(r){return r.json();}).catch(function(){return {ok:false};}),
          fetch('/metrics/app').then(function(r){return r.json();}).catch(function(){return {ok:false};})
        ]);
        lastHost=res[0];lastApp=res[1];
        // sidebar services dot: green if all up, purple(busy) if any down
        var h=lastHost&&lastHost.host||{};
        var cs=h.containers||[];
        var down=cs.filter(function(c){return c.state!=='running';}).length;
        var dot=document.getElementById('nav-svc-dot');
        if(dot)dot.className='nd '+(!cs.length?'':down?'busy':'on');
        if(document.getElementById('mon-back').classList.contains('open'))renderModal();
      }catch(e){/* keep last paint */}
    }

    function evRow(l,v){return '<div class="ev"><span class="t" style="min-width:120px">'+esc(l)+'</span><span>'+esc(v)+'</span></div>';}

    function renderModal(){
      var h=lastHost&&lastHost.host||{},a=lastApp||{};
      // host feed
      var hx='';
      if(h.cpu_pct!=null)hx+=evRow('CPU',h.cpu_pct+'%');
      if(h.mem)hx+=evRow('MEM',h.mem.used_pct+'%  ('+Math.round((h.mem.total_kb-h.mem.avail_kb)/1048576)+'/'+Math.round(h.mem.total_kb/1048576)+' GB)');
      if(h.disk)hx+=evRow('DISK',h.disk.used_pct+'%  ('+Math.round(h.disk.used_bytes/1e9)+'/'+Math.round(h.disk.total_bytes/1e9)+' GB)');
      if(h.load)hx+=evRow('LOAD',h.load.one+' / '+h.load.five+' / '+h.load.fifteen);
      if(h.uptime_sec)hx+=evRow('UPTIME',Math.floor(h.uptime_sec/86400)+'d '+Math.floor(h.uptime_sec%86400/3600)+'h');
      document.getElementById('mx-host').innerHTML=hx||'<div class="ev">host standby</div>';
      // real vitals: cpu die + gauges + load
      renderVitals(h);
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

    // ---- REAL vitals: 8-cell CPU die derived from aggregate heat ----
    // No fabricated per-core data (endpoint has none). Heat = blend of real
    // cpu_pct, load-per-core, and mem. Cells spread the real aggregate with a
    // deterministic per-index offset so the grid reads "alive" but always
    // averages back to the true number. Idle box => calm/dim; busy => bright.
    var CORES=8;
    var dieBuilt=false;
    var pulseT=0;
    function buildDie(){
      var die=document.getElementById('cpu-die');if(!die)return;
      var dh='';for(var i=0;i<CORES;i++){dh+='<div class="cpu-core"></div>';}
      die.innerHTML=dh;dieBuilt=true;
    }
    // green ramp: faint -> bright by utilization (single hue, brightness only)
    function heatCell(u){
      // u 0..100 -> rgb along dim-green .. bright phosphor
      var t=Math.max(0,Math.min(1,u/100));
      var r=Math.round(26+(124-26)*t);
      var g=Math.round(28+(252-28)*t);
      var b=Math.round(30+(0-30)*t*0.6+18*(1-t)); // stay slightly purple-tinted when cold
      return [r,g,b];
    }
    function renderVitals(h){
      if(!dieBuilt)buildDie();
      var die=document.getElementById('cpu-die');if(!die)return;
      var cpu=(h.cpu_pct!=null)?h.cpu_pct:0;
      var memPct=(h.mem&&h.mem.used_pct!=null)?h.mem.used_pct:0;
      var loadOne=(h.load&&h.load.one!=null)?h.load.one:0;
      var loadPerCore=Math.min(100,(loadOne/CORES)*100);
      // combined "heat" drives glow/pulse intensity — weighted to cpu, then load, then mem
      var heat=Math.max(0,Math.min(100, cpu*0.6 + loadPerCore*0.3 + memPct*0.1 ));
      var cells=die.querySelectorAll('.cpu-core');
      // deterministic spread offsets (sum ~0) so cells differ but average = cpu
      var OFF=[-6,4,-2,7,-5,2,-3,3];
      var pulse=(Math.sin(pulseT)*0.5+0.5); // 0..1, speed scaled below
      for(var i=0;i<cells.length;i++){
        var spread=OFF[i]*(cpu/100); // spread widens with load, vanishes at idle
        var u=Math.max(0,Math.min(100, cpu + spread + (pulse-0.5)*heat*0.18*OFF[i]));
        var col=heatCell(u);
        cells[i].style.background='rgb('+col[0]+','+col[1]+','+col[2]+')';
        var glow=(u/100)*(0.35+heat/100*0.75); // brighter glow when hot
        var blur=(1.5+(u/100)*(3+heat/100*10)).toFixed(1);
        cells[i].style.boxShadow='0 0 '+blur+'px rgba(124,252,0,'+glow.toFixed(2)+')';
      }
      var av=document.getElementById('cpu-agg');if(av)av.textContent=Math.round(cpu)+'%';
      var sub=document.getElementById('cpu-agg-sub');
      if(sub)sub.textContent=CORES+' cores · load '+(loadOne.toFixed(2));
      // gauges
      setDial('g-cpu-arc','g-cpu-num',cpu);
      setDial('g-mem-arc','g-mem-num',memPct);
      setDial('g-disk-arc','g-disk-num',(h.disk&&h.disk.used_pct!=null)?h.disk.used_pct:0);
      // load bars scaled to real core count (16 logical)
      var LCORES=16;
      setLoad('ld-1',h.load?h.load.one:0,LCORES);
      setLoad('ld-5',h.load?h.load.five:0,LCORES);
      setLoad('ld-15',h.load?h.load.fifteen:0,LCORES);
    }
    function dialPath(v){
      v=Math.max(0,Math.min(100,v||0));
      var ang=Math.PI*(1-v/100);
      return 'M10,55 A35,35 0 0,1 '+(45+35*Math.cos(ang)).toFixed(2)+','+(55-35*Math.sin(ang)).toFixed(2);
    }
    function setDial(arcId,numId,v){
      var arc=document.getElementById(arcId),num=document.getElementById(numId);
      if(arc)arc.setAttribute('d',dialPath(v));
      if(num)num.textContent=Math.round(v||0)+'%';
    }
    function setLoad(id,val,cores){
      var e=document.getElementById(id);if(!e)return;
      var p=Math.min(100,(val||0)/cores*100);
      e.style.width=p+'%';
    }

    // ---- THE DOCK (containers) ----
    function ringTheme(name){
      // two-color scheme: purple for stateful/brain, green for everything else
      if(/postgres|qdrant|redis|marionette|contractor/.test(name))return '#c07bff';
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
      svg+='<line x1="'+startX.toFixed(1)+'" y1="'+(boxBottom+1)+'" x2="'+(startX+rowW).toFixed(1)+'" y2="'+(boxBottom+1)+'" stroke="#2a2440" stroke-width="1"/>';
      var maxMem=1;for(var mi=0;mi<n;mi++){if(all[mi].state==='running'){var mb=all[mi].mem?all[mi].mem.used_bytes:0;if(mb>maxMem)maxMem=mb;}}
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
        svg+='<rect x="'+cellX.toFixed(1)+'" y="0" width="'+slotW.toFixed(1)+'" height="130" fill="transparent"/>';
        if(running){
          if(ringPhase[c.name]==null)ringPhase[c.name]=Math.random()*6.28;
          var ph=ringPhase[c.name];
          var frac=(c.mem?c.mem.used_bytes:0)/maxMem*0.92;
          var amp=0.02*(load/100);
          var lvl=frac+Math.sin(ringT*1.5+ph)*amp;if(lvl<0)lvl=0;if(lvl>1)lvl=1;
          var fillH=lvl*boxH;var fillY=boxBottom-fillH;
          var clipId='dk'+i;
          svg+='<clipPath id="'+clipId+'"><rect x="'+boxX.toFixed(1)+'" y="'+boxTop+'" width="'+boxW.toFixed(1)+'" height="'+boxH+'" rx="6"/></clipPath>';
          svg+='<rect x="'+boxX.toFixed(1)+'" y="'+boxTop+'" width="'+boxW.toFixed(1)+'" height="'+boxH+'" rx="6" fill="#0d0820" stroke="'+col+'" stroke-width="1.3"/>';
          svg+='<g clip-path="url(#'+clipId+')"><rect x="'+boxX.toFixed(1)+'" y="'+fillY.toFixed(1)+'" width="'+boxW.toFixed(1)+'" height="'+fillH.toFixed(1)+'" fill="'+col+'" fill-opacity="0.5"/>';
          svg+='<rect x="'+boxX.toFixed(1)+'" y="'+fillY.toFixed(1)+'" width="'+boxW.toFixed(1)+'" height="1.6" fill="'+col+'" fill-opacity="0.9"/></g>';
          if(busy){
            var ap=(Math.sin(ringT*3+ph)*0.5+0.5);
            svg+='<circle cx="'+cx.toFixed(1)+'" cy="13" r="'+(5.5+ap*3).toFixed(1)+'" fill="#c07bff" fill-opacity="'+(0.28*ap+0.06).toFixed(2)+'"/>';
            svg+='<circle cx="'+cx.toFixed(1)+'" cy="13" r="3.2" fill="#c07bff"/>';
          } else {
            svg+='<circle cx="'+cx.toFixed(1)+'" cy="13" r="7" fill="#7CFC00" fill-opacity="0.16"/>';
            svg+='<circle cx="'+cx.toFixed(1)+'" cy="13" r="3.2" fill="#7CFC00"/>';
          }
          svg+='<text x="'+cx.toFixed(1)+'" y="103" text-anchor="middle" fill="#7a9a5a" font-size="6.5">'+esc(short)+'</text>';
        } else {
          svg+='<rect x="'+boxX.toFixed(1)+'" y="'+boxTop+'" width="'+boxW.toFixed(1)+'" height="'+boxH+'" rx="6" fill="none" stroke="#2a2440" stroke-width="1" stroke-dasharray="3 3"/>';
          svg+='<circle cx="'+cx.toFixed(1)+'" cy="13" r="3.2" fill="#1e1838" stroke="#2a2440" stroke-width="0.8"/>';
          svg+='<text x="'+cx.toFixed(1)+'" y="103" text-anchor="middle" fill="#4a4560" font-size="6.5">'+esc(short)+'</text>';
        }
        svg+='</g>';
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
      if(dockHover>=0){
        if(dockHover<dockInfo.length){
          var tt=document.getElementById('dock-tip');
          if(tt&&tt.style.display==='block')tt.innerHTML=dockInfo[dockHover];
        } else { dockHideTip(); }
      }
    }

    // open/close from sidebar SERVICES item
    var navSvc=document.getElementById('nav-svc'),back=document.getElementById('mon-back');
    if(navSvc){navSvc.addEventListener('click',function(){renderModal();back.classList.add('open');});}
    if(back){back.addEventListener('click',function(e){if(e.target===back)back.classList.remove('open');});}
    document.addEventListener('keydown',function(e){if(e.key==='Escape'&&back)back.classList.remove('open');});

    // animation loop — dock breathing + cpu pulse, only while modal open
    setInterval(function(){
      ringT+=0.12;pulseT+=0.18;
      if(document.getElementById('mon-back').classList.contains('open')&&lastHost&&lastHost.host){
        renderDock(lastHost.host.containers||[]);
        renderVitals(lastHost.host);
      }
    },80);
    tick();setInterval(tick,4000);
  })();
</script>
</body></html>`);
});
