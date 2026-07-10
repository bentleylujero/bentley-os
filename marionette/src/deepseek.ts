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
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error('DeepSeek returned no message content');
  }

  return {
    content,
    model,
    usage: data?.usage,
    finishReason: data?.choices?.[0]?.finish_reason,
  };
}
