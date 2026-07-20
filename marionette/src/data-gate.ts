// data-gate.ts — the bridge between Mari's raw email *content* (via Qdrant +
// Postgres, see retrieve.ts) and her *reasoning* (/think). Mirrors
// system-sight.ts's shape exactly: a keyword gate + a formatter, nothing more.
//
//   1. isDataQuestion() — a keyword gate deciding whether a given /think
//      request is asking Mari to recall/search actual email content ("what did
//      X say", "find the email about...", "did I get anything from..."). A
//      miss just falls back to Mari's honest "I don't have that yet" reply —
//      never a wrong answer, only a missed one.
//   2. formatRetrievalForPrompt() — turns retrieveContext()'s email hits into a
//      COMPACT text block for injection, same "signal not noise" discipline as
//      formatAuditForPrompt().
//
// No new state, no DB/Qdrant access here — that's retrieve.ts's job. This gate
// only decides IF to call it and shapes what it returns for the prompt.
import type { Retrieved } from './retrieve.ts';

const DATA_PATTERNS: string[] = [
  'email about',
  'email from',
  'email says',
  'email said',
  'did i get',
  'did i receive',
  'find the email',
  'search my email',
  'search email',
  'what did the email',
  'what does the email',
  'any email',
  'anything from',
  'message from',
  'message about',
  'inbox',
  'my email',
  'my emails',
  'what did i receive',
  'receipt for',
  'invoice',
  'attachment',
  'newsletter about',
];

export function isDataQuestion(request: string): boolean {
  const q = request.toLowerCase();
  return DATA_PATTERNS.some((p) => q.includes(p));
}

export function formatRetrievalForPrompt(hits: Retrieved[]): string {
  const lines: string[] = [];
  lines.push(
    `RETRIEVED CONTEXT (top ${hits.length} match${hits.length === 1 ? '' : 'es'} for this request):`,
  );

  if (hits.length === 0) {
    lines.push('  (no relevant emails or documents found)');
    return lines.join('\n');
  }

  // Citation BRANCH on kind — retrieval returns the discriminated union, the
  // rendering decision lives here. Email citations are unchanged; chunks cite
  // their document title + chunk index.
  for (const h of hits) {
    if (h.kind === 'email') {
      lines.push(
        `  - [score ${h.score.toFixed(3)}] Subject: "${h.subject ?? '(no subject)'}" (received ${h.received_at ?? 'unknown'})`,
      );
      lines.push(`    ${truncate((h.body ?? '').trim(), 1200)}`);
    } else {
      const title = h.title && h.title.trim() ? h.title : '(untitled document)';
      lines.push(
        `  - [score ${h.score.toFixed(3)}] Document: "${title}" (chunk ${h.chunk_index})`,
      );
      lines.push(`    ${truncate((h.text ?? '').trim(), 1200)}`);
    }
  }

  return lines.join('\n');
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
