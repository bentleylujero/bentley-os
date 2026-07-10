import { runGmailSync } from './gmail.js';

runGmailSync()
  .then((result) => {
    console.log('SYNC RESULT:', JSON.stringify(result, null, 2));
    process.exit(0);
  })
  .catch((err) => {
    console.error('SYNC FAILED:', err);
    process.exit(1);
  });
