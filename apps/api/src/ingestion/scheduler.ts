import cron from 'node-cron';
import { runGcalSync } from './gcal.js';
import { runGmailSync } from './gmail.js';

let running = false;

async function runAllSyncs() {
  if (running) {
    console.log('[scheduler] previous sync still running, skipping tick');
    return;
  }
  running = true;
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
  running = false;
}

export function startScheduler() {
  // every 5 minutes
  cron.schedule('*/5 * * * *', () => {
    runAllSyncs();
  });
  console.log('[scheduler] ingestion scheduler started (every 5 min)');
}
