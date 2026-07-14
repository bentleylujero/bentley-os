// deepseek.ts — thin client for the DeepSeek chat-completions API.
// Proven working against api.deepseek.com/chat/completions (JSON mode, deepseek-v4-pro).
// Model is configurable via MARIONETTE_MODEL so we can test cheaply against
// deepseek-v4-flash and reserve deepseek-v4-pro for real decisions.
const API_URL = 'https://api.deepseek.com/chat/completions';
const DEFAULT_MODEL = 'deepseek-v4-pro';
const TIMEOUT_MS = 60_000;
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}
export interface DeepSeekResult {
  content: string;
  model: string;
  usage: unknown;
  finishReason: string | undefined;
}
// DeepSeek's reasoning models sometimes leak a thinking trace even in JSON mode —
// content can arrive as "<think>...reasoning...</think>{...real json...}" or with a
// stray "<｜end▁of▁thinking｜>" token, occasionally with the JSON object duplicated.
// Strip trace wrappers, then pull out the first balanced {...} object so downstream
// JSON.parse gets a clean string. Content stays "a JSON object string" either way —
// callers are unaffected.
function stripThinkingArtifacts(raw: string): string {
  let cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, '');
  cleaned = cleaned.replace(/<｜[^｜]*｜>/g, '');
  return cleaned.trim();
}
function extractFirstJsonObject(raw: string): string {
  const start = raw.indexOf('{');
  if (start === -1) return raw;
  let depth = 0;
  for (let i = start; i < raw.length; i++) {
    if (raw[i] === '{') depth++;
    else if (raw[i] === '}') {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return raw.slice(start);
}
// Calls DeepSeek in JSON mode. Returns the raw string content (expected to be a
// JSON object) plus metadata. Throws on network failure, non-2xx, or missing content.
export async function callDeepSeek(messages: ChatMessage[]): Promise<DeepSeekResult> {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error('DEEPSEEK_API_KEY not set in environment');
  const model = process.env.MARIONETTE_MODEL || DEFAULT_MODEL;
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + key,
    },
    body: JSON.stringify({
      model,
      messages,
      response_format: { type: 'json_object' },
      stream: false,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(`DeepSeek HTTP ${res.status}: ${body.slice(0, 500)}`);
  }
  const data = await res.json();
  let content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error('DeepSeek returned no message content');
  }
  content = extractFirstJsonObject(stripThinkingArtifacts(content));
  return {
    content,
    model,
    usage: data?.usage,
    finishReason: data?.choices?.[0]?.finish_reason,
  };
}
