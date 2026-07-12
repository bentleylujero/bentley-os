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

async function sendMessage(chatId: number, text: string) {
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

telegramRoute.post('/telegram/webhook', async (c) => {
  // Reject anything that isn't actually from Telegram before touching the body.
  const secretHeader = c.req.header('x-telegram-bot-api-secret-token');
  if (secretHeader !== webhookSecret) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  const update = await c.req.json<{
    message?: { text?: string; from?: { id?: number }; chat?: { id?: number } };
  }>();

  const message = update.message;
  const fromId = message?.from?.id;
  const chatId = message?.chat?.id;
  const text = message?.text;

  // Always 200 back to Telegram (it retries on non-2xx), but silently drop
  // anything from a non-allow-listed user or without a chat to reply to.
  if (!chatId || !text) {
    return c.json({ ok: true });
  }
  if (String(fromId) !== allowedUserId) {
    return c.json({ ok: true });
  }

  const { data, error } = await fetch('http://marionette:4200/think', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ request: text }),
  }).then(async (res) => {
    if (!res.ok) {
      return { data: null, error: await res.text() };
    }
    return { data: await res.json(), error: null };
  });

  if (error || !data) {
    await sendMessage(chatId, `Error reaching marionette: ${error ?? 'unknown'}`);
    return c.json({ ok: true });
  }

  const decision = (data as { decision?: { message?: string } }).decision;
  await sendMessage(chatId, decision?.message ?? '(no message returned)');

  return c.json({ ok: true });
});
