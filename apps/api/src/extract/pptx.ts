import { unzipSync, strFromU8 } from 'fflate';
import { DOMParser } from '@xmldom/xmldom';

// A .pptx is a zip of XML. Slide text lives in ppt/slides/slideN.xml inside
// <a:t> runs. Speaker notes live in ppt/notesSlides/notesSlideN.xml, same shape.
// We read both, in slide order, and emit plain text. No interpretation (§9).

const SLIDE_RE = /^ppt\/slides\/slide(\d+)\.xml$/;
const NOTES_RE = /^ppt\/notesSlides\/notesSlide(\d+)\.xml$/;

// <a:p> is a paragraph, <a:t> a text run within it. Joining runs inside a
// paragraph without a separator preserves words split across formatting
// boundaries ("Bent" + "ley"); paragraphs become newlines.
function textFromXml(xml: string): string {
  const doc = new DOMParser({
    onError: () => {},
  }).parseFromString(xml, 'text/xml');

  const paras = doc.getElementsByTagName('a:p');
  const lines: string[] = [];

  for (let i = 0; i < paras.length; i++) {
    const runs = paras[i].getElementsByTagName('a:t');
    let line = '';
    for (let j = 0; j < runs.length; j++) {
      line += runs[j].textContent ?? '';
    }
    line = line.trim();
    if (line) lines.push(line);
  }

  return lines.join('\n');
}

function slideNumber(path: string, re: RegExp): number {
  const m = path.match(re);
  return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
}

export function extractPptxText(buffer: Uint8Array): string {
  const files = unzipSync(buffer);

  const slides = Object.keys(files)
    .filter((p) => SLIDE_RE.test(p))
    .sort((a, b) => slideNumber(a, SLIDE_RE) - slideNumber(b, SLIDE_RE));

  const notes = Object.keys(files)
    .filter((p) => NOTES_RE.test(p))
    .sort((a, b) => slideNumber(a, NOTES_RE) - slideNumber(b, NOTES_RE));

  const notesByNumber = new Map<number, string>();
  for (const path of notes) {
    const text = textFromXml(strFromU8(files[path]));
    if (text) notesByNumber.set(slideNumber(path, NOTES_RE), text);
  }

  const out: string[] = [];
  for (const path of slides) {
    const n = slideNumber(path, SLIDE_RE);
    const body = textFromXml(strFromU8(files[path]));
    const note = notesByNumber.get(n);

    const parts = [`## Slide ${n}`];
    if (body) parts.push(body);
    if (note) parts.push(`Notes: ${note}`);
    out.push(parts.join('\n'));
  }

  return out.join('\n\n');
}
