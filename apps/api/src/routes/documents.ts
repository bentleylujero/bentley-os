import { Hono } from 'hono';
import mammoth from 'mammoth';
import { extractText as pdfExtractText, getDocumentProxy } from 'unpdf';
import { extractPptxText } from '../extract/pptx.js';
import { pool } from '../db/pool.js';

export const documentsRoute = new Hono();

// Thrown by extractText for a MIME we deliberately don't handle yet, OR for a
// file whose text layer came back effectively empty. The handler maps this to a
// 415 (not a 500) — a clean rejection, not a crash.
class UnsupportedType extends Error {
  constructor(message: string) {
    super(message);
  }
}

// A file that parses fine but yields no real text is silent garbage: an empty
// documents row that embeds to nothing. Reject loudly at upload instead. Covers
// image-only DOCX today and scanned PDFs when that case lands.
const MIN_CHARS = 20;

const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PPTX_MIME =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';

// extractText — the single content seam. api does NO interpretation of the text
// (§9) — it just pulls the raw string. PDF lands here next.
async function extractText(file: File): Promise<string> {
  const mime = file.type || 'application/octet-stream';
  let text: string;

  switch (mime) {
    case 'text/markdown':
    case 'text/x-markdown':
    case 'text/plain':
      text = await file.text();
      break;

    case DOCX_MIME: {
      const buffer = Buffer.from(await file.arrayBuffer());
      const result = await mammoth.extractRawText({ buffer });
      text = result.value;
      break;
    }

    case PPTX_MIME: {
      // Slide text + speaker notes, in slide order, with '## Slide N' headers
      // so chunks carry provenance. Pure zip+XML — no OCR, no model call (§9).
      const bytes = new Uint8Array(await file.arrayBuffer());
      text = extractPptxText(bytes);
      break;
    }
    case 'application/pdf': {
      // Text layer only. A scanned/image-only PDF yields ~nothing and falls
      // through to the MIN_CHARS guard below as a clean 415. OCR is a separate,
      // later slice — this seam accommodates it without rework.
      const bytes = new Uint8Array(await file.arrayBuffer());
      const pdf = await getDocumentProxy(bytes);
      const { text: pdfText } = await pdfExtractText(pdf, { mergePages: true });
      text = pdfText;
      break;
    }

    default:
      throw new UnsupportedType(`unsupported file type: ${mime}`);
  }

  if (text.trim().length < MIN_CHARS) {
    throw new UnsupportedType(
      `no usable text extracted from ${mime} — file may be empty or image-only`,
    );
  }
  return text;
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
    console.error('POST /documents extract failed:', err);
    return c.json({ error: 'could not read file' }, 400);
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
