import { err, type Messenger, type MessengerError, type OutboxMessage, ok, type Result } from '@reckon/core';
import { z } from 'zod';
import type { FetchLike } from '../sources/http';

/**
 * Telegram Bot API (spec §1.5). Docs: https://core.telegram.org/bots/api — sendMessage with
 * parse_mode HTML and an inline keyboard of URL buttons; setWebhook with a secret_token.
 */
export interface TelegramOptions {
  readonly token: string;
  readonly fetchImpl?: FetchLike;
  readonly apiBase?: string;
}

const ApiResponse = z.object({ ok: z.boolean(), description: z.string().optional(), error_code: z.number().optional() });

export class TelegramMessenger implements Messenger {
  readonly channel = 'telegram' as const;
  constructor(private readonly o: TelegramOptions) {}

  private async call(method: string, body: Record<string, unknown>): Promise<Result<void, MessengerError>> {
    const doFetch = this.o.fetchImpl ?? fetch;
    try {
      const res = await doFetch(`${this.o.apiBase ?? 'https://api.telegram.org'}/bot${this.o.token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8_000),
      });
      const parsed = ApiResponse.safeParse(await res.json().catch(() => ({})));
      if (parsed.success && parsed.data.ok) return ok(undefined);
      const detail = parsed.success ? `${parsed.data.error_code ?? res.status}: ${parsed.data.description ?? ''}` : `HTTP ${res.status}`;
      // 403 means the user blocked the bot or left the chat: retrying will not help.
      return err({ code: res.status === 403 ? 'blocked' : 'failed', detail });
    } catch (e) {
      return err({ code: 'failed', detail: String(e) });
    }
  }

  send(chatId: string, msg: OutboxMessage): Promise<Result<void, MessengerError>> {
    return this.call('sendMessage', {
      chat_id: chatId,
      text: msg.text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...(msg.buttons?.length ? { reply_markup: { inline_keyboard: [msg.buttons.map((b) => ({ text: b.text, url: b.url }))] } } : {}),
    });
  }

  setWebhook(url: string, secretToken: string): Promise<Result<void, MessengerError>> {
    return this.call('setWebhook', { url, secret_token: secretToken, allowed_updates: ['message'], drop_pending_updates: true });
  }
}
