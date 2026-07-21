import { Hono } from 'hono';

export const telegramRoute = new Hono();

// Guard at module load, same pattern as opencode.ts — refuse to mount
// unguarded rather than silently no-op on a misconfigured deploy.
const botToken = process.env.TELEGRAM_BOT_TOKEN;
const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
const allowedUserId = process.env.TELEGRAM_ALLOWED_USER_ID;

if (!botToken || !webhookSecret || !allowedUserId) {
  throw new Error(
    'TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, and TELEGRAM_ALLOWED_USER_ID must all be set — refusing to mount /telegram routes unguarded.'
  );
}

const MARIONETTE = 'http://marionette:4200';

async function sendMessage(
  chatId: number,
  text: string,
  replyMarkup?: unknown
) {
  const body: Record<string, unknown> = { chat_id: chatId, text };
  if (replyMarkup) body.reply_markup = replyMarkup;
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Clears the tapped button's loading spinner. Must be called fast, and we do
// NOT await marionette before calling it — Telegram wants a prompt ack.
async function answerCallbackQuery(callbackQueryId: string, text?: string) {
  await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  });
}

// ── Update types (only the fields we read) ──────────────────────────────────
interface TgFrom { id?: number }
interface TgChat { id?: number }
interface TgMessage { text?: string; from?: TgFrom; chat?: TgChat }
interface TgCallbackQuery {
  id: string;
  data?: string;
  from?: TgFrom;
  message?: { chat?: TgChat };
}
interface TgUpdate {
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

// ── Webhook: handles BOTH message updates and callback_query (button) updates ─
telegramRoute.post('/telegram/webhook', async (c) => {
  // Reject anything that isn't actually from Telegram before touching the body.
  const secretHeader = c.req.header('x-telegram-bot-api-secret-token');
  if (secretHeader !== webhookSecret) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  const update = await c.req.json<TgUpdate>();

  // Always 200 back to Telegram (it retries on non-2xx). Downstream failures
  // are reported in-chat, not via HTTP status.
  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query);
    return c.json({ ok: true });
  }
  await handleMessage(update.message);
  return c.json({ ok: true });
});

// ── Message path (unchanged behavior: forward text to marionette /think) ─────
async function handleMessage(message: TgMessage | undefined) {
  const fromId = message?.from?.id;
  const chatId = message?.chat?.id;
  const text = message?.text;

  if (!chatId || !text) return;
  if (String(fromId) !== allowedUserId) return;

  const { data, error } = await fetch(`${MARIONETTE}/think`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // conversation_id = the Telegram chat id: a stable, already-present
    // identifier. api stays a thin relay — it passes the id through, it does
    // not read or assemble history (that is marionette's, per THE_BIBLE §9).
    body: JSON.stringify({ request: text, conversation_id: String(chatId) }),
  }).then(async (res) => {
    if (!res.ok) return { data: null, error: await res.text() };
    return { data: await res.json(), error: null };
  });

  if (error || !data) {
    await sendMessage(chatId, `Error reaching marionette: ${error ?? 'unknown'}`);
    return;
  }

  const decision = (data as { decision?: { message?: string } }).decision;
  await sendMessage(chatId, decision?.message ?? '(no message returned)');
}

// ── Callback path (button taps: approve:<id> / deny:<id>) ────────────────────
async function handleCallbackQuery(cq: TgCallbackQuery) {
  const fromId = cq.from?.id;
  const chatId = cq.message?.chat?.id;
  const data = cq.data;

  // Same allow-list gate as messages. Silently ack + drop non-allow-listed.
  if (String(fromId) !== allowedUserId) {
    await answerCallbackQuery(cq.id);
    return;
  }

  // Ack immediately — clears the spinner. Do this BEFORE hitting marionette.
  await answerCallbackQuery(cq.id);

  if (!chatId || !data) return;

  // callback_data is "approve:<id>" or "deny:<id>". Parse defensively.
  const [verb, rawId] = data.split(':');
  const id = Number(rawId);
  if ((verb !== 'approve' && verb !== 'deny') || !Number.isInteger(id)) {
    await sendMessage(chatId, `Ignored malformed action button: ${data}`);
    return;
  }

  const res = await fetch(`${MARIONETTE}/actions/${id}/${verb}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  }).catch((e) => {
    return { ok: false, status: 0, _err: e?.message ?? 'fetch failed' } as any;
  });

  // Race / double-tap: marionette returns 409 when the row isn't 'proposed'.
  if (res.status === 409) {
    await sendMessage(chatId, `Action ${id} already handled.`);
    return;
  }
  if (!res.ok) {
    const detail = (res as any)._err ?? `HTTP ${res.status}`;
    await sendMessage(chatId, `Failed to ${verb} action ${id}: ${detail}`);
    return;
  }

  if (verb === 'approve') {
    await sendMessage(chatId, `✅ Action ${id} approved — executing. Result reported when done.`);
  } else {
    await sendMessage(chatId, `🛑 Action ${id} denied.`);
  }
}

// ── Surface: push an existing proposed action to Telegram WITH buttons ───────
// Internal relay only — reads the action from marionette (which owns the
// lifecycle) and pushes it to the allow-listed chat with an inline keyboard.
// Trigger: POST /telegram/surface/:id  (optional body {"chat_id": <n>};
// defaults to the single allow-listed user, whose chat id == user id in a DM).
telegramRoute.post('/telegram/surface/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ error: 'id must be an integer' }, 400);

  const body: { chat_id?: number } = await c.req.json<{ chat_id?: number }>().catch(() => ({}));
  const chatId = body.chat_id ?? Number(allowedUserId);

  const res = await fetch(`${MARIONETTE}/actions/${id}`);
  if (!res.ok) {
    return c.json({ error: `marionette /actions/${id} returned ${res.status}` }, 502);
  }
  const { action } = (await res.json()) as {
    action?: { id: string | number; kind: string; status: string; briefing: string | null; intent: Record<string, unknown> };
  };
  if (!action) return c.json({ error: 'no action in marionette response' }, 502);

  if (action.status !== 'proposed') {
    return c.json({ error: `action ${id} is '${action.status}', not 'proposed' — nothing to approve` }, 409);
  }

  const summary =
    action.briefing?.trim() ||
    `${action.kind} — ${JSON.stringify(action.intent)}`;

  await sendMessage(chatId, `Proposed action #${id}:\n${summary}`, {
    inline_keyboard: [
      [
        { text: 'Approve', callback_data: `approve:${id}` },
        { text: 'Deny', callback_data: `deny:${id}` },
      ],
    ],
  });

  return c.json({ ok: true, surfaced: id, chat_id: chatId });
});

// ── Notify: push a deploy's TRUE terminal outcome to Telegram ────────────────
// Internal relay only (backend-network isolation, same trust model as surface).
// Called by marionette's deploy-completion poll once a job reaches a real
// terminal audit row — fulfills the "Result reported when done." promise made
// on approve. Marionette cannot message out itself (§9), so it POSTs here.
// Body: { action_id, state: 'succeeded'|'failed'|'timeout', detail?, chat_id? }
telegramRoute.post('/telegram/notify', async (c) => {
  const body = await c.req
    .json<{ action_id?: number; state?: string; detail?: string; chat_id?: number }>()
    .catch(() => ({} as Record<string, never>));

  const actionId = body.action_id;
  const state = body.state;
  if (!Number.isInteger(actionId) || !state) {
    return c.json({ error: 'action_id (int) and state are required' }, 400);
  }

  const chatId = body.chat_id ?? Number(allowedUserId);
  const detail = body.detail ? ` — ${body.detail}` : '';

  let text: string;
  if (state === 'succeeded') {
    text = `✅ Action #${actionId} deploy succeeded${detail}.`;
  } else if (state === 'timeout') {
    text = `⏱️ Action #${actionId} deploy status unknown — poll timed out${detail}. Check audit_log.`;
  } else {
    text = `❌ Action #${actionId} deploy failed${detail}.`;
  }

  await sendMessage(chatId, text);
  return c.json({ ok: true, notified: actionId, state });
});
