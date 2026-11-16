import type { Clock, LinkTokenRepo, Logger, Messenger, OutboxMessage, TokenSource, UserRepo } from '../ports';
import { briefMessage, revealMessage } from './notify';
import type { BriefView, RevealView } from './views';

/** Spec §1.5: deep-link tokens are one-time and short-lived. */
export const LINK_TOKEN_MINUTES = 30;

export function createTelegramLink(deps: { clock: Clock; tokens: TokenSource; linkTokens: LinkTokenRepo; botUsername: string | undefined }) {
  return async (userId: string): Promise<{ url: string; expiresAt: string } | null> => {
    if (!deps.botUsername) return null;
    const token = deps.tokens.token(18);
    const expiresAt = new Date(deps.clock.now().getTime() + LINK_TOKEN_MINUTES * 60_000);
    await deps.linkTokens.create(userId, token, expiresAt);
    return { url: `https://t.me/${deps.botUsername}?start=${token}`, expiresAt: expiresAt.toISOString() };
  };
}

export interface TelegramDeps {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly users: UserRepo;
  readonly linkTokens: LinkTokenRepo;
  readonly messenger: Messenger | undefined;
  readonly appUrl?: string;
  readonly brief: (userId: string) => Promise<BriefView | null>;
  readonly reveal: (userId: string, date: string) => Promise<RevealView | null>;
}

const HELP = [
  '<b>Reckon</b> makes small predictions about your day and checks every one against reality.',
  '',
  '/brief: today’s brief',
  '/reveal: the latest reveal',
  '/pause: stop scheduled messages',
  '/resume: start them again',
  '/stop: unlink this chat',
].join('\n');

const NOT_LINKED = 'This chat is not linked yet. Open Reckon → Settings → “Link Telegram”, then tap the link it gives you.';

/**
 * Handle one incoming Telegram message (commands only; spec §1.5). Replies are sent directly,
 * not through the outbox: they answer the user and do not count toward the push cap.
 */
export function handleTelegramMessage(deps: TelegramDeps) {
  const reply = async (chatId: string, msg: OutboxMessage | string) => {
    if (!deps.messenger) return;
    const r = await deps.messenger.send(chatId, typeof msg === 'string' ? { text: msg } : msg);
    if (!r.ok) deps.logger.warn('telegram.reply_failed', { error: r.error });
  };

  return async (chatId: string, text: string): Promise<void> => {
    const [rawCommand = '', arg] = text.trim().split(/\s+/, 2);
    const command = rawCommand.split('@')[0]?.toLowerCase() ?? '';

    if (command === '/start' && arg) {
      const userId = await deps.linkTokens.consume(arg, deps.clock.now());
      if (!userId) return reply(chatId, 'That link has expired or was already used. Make a new one in Reckon → Settings.');
      await deps.users.setTelegramChat(userId, chatId);
      const user = await deps.users.byId(userId);
      deps.logger.info('telegram.linked', { userId });
      return reply(
        chatId,
        `Linked. Your brief arrives at ${user?.briefTime ?? '06:30'} and the reveal at ${user?.revealTime ?? '21:00'} (${user?.tz ?? 'your timezone'}).\n\n${HELP}`,
      );
    }

    const user = await deps.users.byTelegramChat(chatId);
    if (!user) return reply(chatId, command === '/start' || command === '/help' ? `${HELP}\n\n${NOT_LINKED}` : NOT_LINKED);

    switch (command) {
      case '/brief': {
        const b = await deps.brief(user.id);
        return reply(chatId, b ? briefMessage(b, deps.appUrl) : 'No brief yet.');
      }
      case '/reveal': {
        const r = await deps.reveal(user.id, 'latest');
        return reply(chatId, r ? revealMessage(r, deps.appUrl) : 'No reveal yet.');
      }
      case '/pause':
        await deps.users.update(user.id, { paused: true });
        return reply(chatId, 'Paused. No scheduled messages until you send /resume. Commands still work.');
      case '/resume':
        await deps.users.update(user.id, { paused: false });
        return reply(chatId, `Resumed. Next brief at ${user.briefTime}.`);
      case '/stop':
        await deps.users.setTelegramChat(user.id, null);
        return reply(chatId, 'Unlinked. Reckon will not message this chat again. You can relink from Settings at any time.');
      default:
        return reply(chatId, HELP);
    }
  };
}
