import { describe, expect, it } from 'vitest';
import { type FetchLike, TelegramMessenger } from '../src';

describe('TelegramMessenger', () => {
  it('sends HTML messages with URL buttons', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response('{"ok":true,"result":{}}');
    };
    const r = await new TelegramMessenger({ token: 'T', fetchImpl }).send('42', { text: '<b>hi</b>', buttons: [{ text: 'Open', url: 'https://x.example/' }] });
    expect(r.ok).toBe(true);
    expect(calls[0]?.url).toBe('https://api.telegram.org/botT/sendMessage');
    expect(calls[0]?.body).toMatchObject({
      chat_id: '42',
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: 'Open', url: 'https://x.example/' }]] },
    });
  });

  it('maps 403 to blocked so the outbox stops retrying', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response('{"ok":false,"error_code":403,"description":"Forbidden: bot was blocked by the user"}', { status: 403 });
    const r = await new TelegramMessenger({ token: 'T', fetchImpl }).send('42', { text: 'x' });
    expect(r.ok ? 'ok' : r.error.code).toBe('blocked');
  });

  it('maps other failures to failed with detail', async () => {
    const fetchImpl: FetchLike = async () => new Response('{"ok":false,"error_code":400,"description":"Bad Request"}', { status: 400 });
    const r = await new TelegramMessenger({ token: 'T', fetchImpl }).send('42', { text: 'x' });
    expect(r.ok ? 'ok' : r.error).toEqual({ code: 'failed', detail: '400: Bad Request' });
  });
});
