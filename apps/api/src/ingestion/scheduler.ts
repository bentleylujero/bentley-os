import cron from 'node-cron';
import { runGcalSync } from './gcal.js';
import { runGmailSync } from './gmail.js';

const MARIONETTE = 'http://marionette:4200';
let running = false;

async function drain(path: string, limit: number) {
  try {
    const res = await fetch(`${MARIONETTE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ limit }),
    });
    const report = await res.json().catch(() => ({}));
    console.log(`[scheduler] drain ${path} done`, report);
  } catch (err) {
    console.error(`[scheduler] drain ${path} failed`, err);
  }
}

async function runAllSyncs() {
  if (running) {
    console.log('[scheduler] previous sync still running, skipping tick');
    return;
  }
  running = true;
  try {
    try {
      console.log('[scheduler] starting gcal sync');
      const gcalResult = await runGcalSync();
      console.log('[scheduler] gcal sync done', gcalResult);
    } catch (err) {
      console.error('[scheduler] gcal sync failed', err);
    }
    try {
      console.log('[scheduler] starting gmail sync');
      const gmailResult = await runGmailSync();
      console.log('[scheduler] gmail sync done', gmailResult);
    } catch (err) {
      console.error('[scheduler] gmail sync failed', err);
    }
    // Drains run after ingestion so this tick's new mail gets picked up.
    // Each drain isolates its own failure; marionette owns the reasoning (§9).
    await drain('/classify', 50);
    await drain('/embed', 50);
  } finally {
    running = false;
  }
}

export function startScheduler() {
  // every 5 minutes
  cron.schedule('*/5 * * * *', () => {
    runAllSyncs();
  });
  console.log('[scheduler] ingestion scheduler started (every 5 min)');
}
