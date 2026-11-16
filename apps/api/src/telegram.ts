import { timingSafeEqual } from 'node:crypto';
import { TelegramUpdate } from '@reckon/contracts';
import type { Container } from '@reckon/runtime';
import { Hono } from 'hono';

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * POST /telegram/webhook/:secret (spec §1.5): a secret path segment plus Telegram's
 * X-Telegram-Bot-Api-Secret-Token header. Unknown callers get 404 so the route is not advertised.
 * Handled updates always answer 200, or Telegram would redeliver them.
 */
export function telegramRoutes(container: Container) {
  const r = new Hono();
  r.post('/webhook/:secret', async (c) => {
    const secret = container.config.TELEGRAM_WEBHOOK_SECRET;
    const app = container.db?.app;
    if (!secret || !app) return c.notFound();
    const header = c.req.header('x-telegram-bot-api-secret-token') ?? '';
    if (!safeEqual(c.req.param('secret'), secret) || !safeEqual(header, secret)) return c.notFound();

    const update = TelegramUpdate.safeParse(await c.req.json().catch(() => null));
    const message = update.success ? update.data.message : undefined;
    // Private chats only: a group link would broadcast someone's brief to everyone in it.
    if (message?.text && message.chat.type === 'private') {
      try {
        await app.telegramMessage(String(message.chat.id), message.text);
      } catch (e) {
        container.logger.error('telegram.update_failed', { error: String(e) });
      }
    }
    return c.json({ ok: true });
  });
  return r;
}
