import { Hono } from 'hono';
import { pool } from '../db/pool.js';

export const documentsRoute = new Hono();

// Thrown by extractText for a MIME we deliberately don't handle yet. The handler
// maps this to a 415 (not a 500) — a clean rejection seam for DOCX/PDF later.
class UnsupportedType extends Error {
  constructor(public mime: string) {
    super(`unsupported file type: ${mime}`);
  }
}

// extractText — the single content seam. Today: plaintext/markdown only, read as
// text. DOCX/PDF land here later; until then anything else is rejected cleanly.
// api does NO interpretation of the text (§9) — it just pulls the raw string.
async function extractText(file: File): Promise<string> {
  switch (file.type) {
    case 'text/markdown':
    case 'text/x-markdown':
    case 'text/plain':
      return await file.text();
    default:
      throw new UnsupportedType(file.type || 'application/octet-stream');
  }
}

// POST /documents — multipart upload. api extracts text + writes the row only;
// marionette embeds it later (Chonkie chunks -> OpenAI 3-small -> Qdrant) via the
// /embed-doc work-queue, which drains on embedded_at IS NULL. No reasoning here (§9).
documentsRoute.post('/documents', async (c) => {
  let file: unknown;
  try {
    const body = await c.req.parseBody();
    file = body['file'];
  } catch {
    return c.json({ error: 'file required' }, 400);
  }
  if (!(file instanceof File)) return c.json({ error: 'file required' }, 400);

  let text: string;
  try {
    text = await extractText(file);
  } catch (err) {
    if (err instanceof UnsupportedType) return c.json({ error: err.message }, 415);
    return c.json({ error: 'file required' }, 400);
  }

  const title = file.name || 'untitled';
  const mime = file.type || 'application/octet-stream';
  const char_count = text.length;

  try {
    const { rows } = await pool.query(
      `insert into documents (title, source, mime, body, char_count)
       values ($1, 'upload', $2, $3, $4)
       returning id, title, mime, char_count, created_at, embedded_at`,
      [title, mime, text, char_count],
    );
    return c.json({ document: rows[0] }, 201);
  } catch (err) {
    console.error('POST /documents failed:', err);
    return c.json({ error: 'insert failed' }, 500);
  }
});
