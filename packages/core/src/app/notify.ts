import { addDays, humanDate, localDate, localMinutes, timeToMinutes, zonedTimeToUtc } from '../domain/dates';
import { decideSend, MAX_SEND_ATTEMPTS } from '../domain/notify';
import type { Channel, Clock, Logger, Messenger, OutboxMessage, OutboxRepo, PushSender, PushSubscriptionRepo, User, UserRepo } from '../ports';
import type { BriefItemView, BriefView, RevealView } from './views';

/** Messages use Telegram's HTML parse mode, so every dynamic string is escaped. */
export function escapeHtml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

const EMOJI: Record<string, string> = { weather: '🌦', air: '🌫', money: '💱', tech: '💻', world: '🌍' };

function line(i: BriefItemView): string {
  const head = i.action ? `<b>${escapeHtml(i.action)}</b> · ` : '';
  if (i.scope === 'world') return `${EMOJI[i.domain] ?? '•'} ${escapeHtml(i.subject)}, ${escapeHtml(i.when)}: <b>${i.percent}%</b> (${i.label.toLowerCase()})`;
  return `${EMOJI[i.domain] ?? '•'} ${head}${escapeHtml(i.subject)} at ${escapeHtml(i.placeName)}: <b>${i.percent}%</b> (${i.label.toLowerCase()})`;
}

/** Spec §1.3: the brief carries 2–3 world and tech items after the local ones. */
const WORLD_IN_BRIEF = 3;

function openButton(appUrl: string | undefined, path: string): Pick<OutboxMessage, 'buttons'> {
  // Telegram rejects non-HTTPS button URLs, so local development sends text only.
  return appUrl?.startsWith('https://') ? { buttons: [{ text: 'Open in Reckon', url: `${appUrl.replace(/\/$/, '')}${path}` }] } : {};
}

/** The Morning Brief (spec §1.3): actions first, then the probability, then honesty about trust. */
export function briefMessage(b: BriefView, appUrl?: string): OutboxMessage {
  const parts = [`<b>Your Reckon brief · ${escapeHtml(humanDate(b.date))}</b>`];
  if (b.today.length) parts.push('', '<b>Today</b>', ...b.today.map(line));
  const tomorrowDecisions = b.tomorrow.filter((i) => i.class === 'decision');
  if (tomorrowDecisions.length) parts.push('', '<b>Tomorrow</b>', ...tomorrowDecisions.map(line));
  const world = b.world.slice(0, WORLD_IN_BRIEF);
  if (world.length) parts.push('', '<b>World pulse</b>', ...world.map(line));
  if (!b.today.length && !tomorrowDecisions.length && !world.length)
    parts.push('', 'No claims are locked for today yet. Your first brief items arrive tomorrow morning.');
  const learning = [...b.today, ...b.tomorrow, ...world].some((i) => i.trust.status === 'learning');
  if (learning) parts.push('', '<i>Every number is still learning: nothing has a track record yet.</i>');
  const lead = b.today.find((i) => i.action) ?? b.today[0] ?? world[0];
  return {
    text: parts.join('\n'),
    ...openButton(appUrl, '/'),
    push: {
      title: `Your Reckon brief · ${humanDate(b.date)}`,
      body: lead ? `${lead.action ? `${lead.action} · ` : ''}${lead.subject}: ${lead.percent}%` : 'Your claims for today are locked.',
      path: '/',
    },
  };
}

/** The Reveal (spec §1.3): what Reckon said, what happened, and the score. */
export function revealMessage(r: RevealView, appUrl?: string): OutboxMessage {
  if (r.sealed) return { text: `The reveal for ${escapeHtml(humanDate(r.date))} opens at ${r.opensAt.slice(11, 16)} UTC. ${r.total} claims are sealed.` };
  const parts = [`<b>The Reveal · ${escapeHtml(humanDate(r.date))}</b>`, ''];
  for (const c of r.cards) {
    const head = c.scope === 'world' ? escapeHtml(c.subject) : `${escapeHtml(c.subject)} at ${escapeHtml(c.placeName)}`;
    if (c.status === 'annulled') parts.push(`⚪ ${head}: annulled (${escapeHtml(c.annulReason ?? 'no data')})`);
    else if (c.outcome == null) parts.push(`⏳ ${head}: said ${c.percent ?? '–'}%, still waiting for the data`);
    else parts.push(`${c.hit ? '✅' : '❌'} ${head}: said ${c.percent}%, observed ${escapeHtml(c.observed ?? '–')} → <b>${c.outcome ? 'YES' : 'NO'}</b>`);
  }
  if (!r.cards.length) parts.push('Nothing was asked about this day.');
  const s = r.summary;
  if (s.meanBrier != null) parts.push('', `${s.hits} right, ${s.misses} wrong. Brier ${s.meanBrier.toFixed(3)} (0 is perfect, 0.25 is a coin flip).`);
  return {
    text: parts.join('\n'),
    ...openButton(appUrl, '/reveal'),
    push: {
      title: `The Reveal · ${humanDate(r.date)}`,
      body: s.hits + s.misses ? `${s.hits} right, ${s.misses} wrong. Tap to flip the cards.` : `${r.total} claims are ready to open.`,
      path: '/reveal',
    },
  };
}

export interface NotifyDeps {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly users: UserRepo;
  readonly outbox: OutboxRepo;
  readonly appUrl?: string;
  /** Web Push subscriptions; absent when VAPID keys are not configured. */
  readonly push?: PushSubscriptionRepo;
}

/** Telegram first; Web Push is the fallback for users without a linked chat (spec §1.5). */
async function channelFor(deps: NotifyDeps, user: User): Promise<Channel | null> {
  if (user.telegramChatId) return 'telegram';
  if (deps.push && (await deps.push.forUser(user.id)).length) return 'webpush';
  return null;
}

/** Build the brief up to 30 minutes early so it is delivered by the brief time (spec G1). */
export const BRIEF_LEAD_MINUTES = 30;
/** After this long past the brief time the brief is no longer a morning brief; skip the day. */
const BRIEF_CUTOFF_MINUTES = 6 * 60;
const REVEAL_LEAD_MINUTES = 30;
const REVEAL_CUTOFF_MINUTES = 3 * 60;

function dueWindow(user: User, now: Date, time: string, lead: number, cutoff: number): boolean {
  const m = localMinutes(now, user.tz);
  const t = timeToMinutes(time);
  return m >= t - lead && m < t + cutoff;
}

/** Put each linked user's brief into the outbox once per local day (dedupe key `brief:<date>:<user>`). */
export function buildDueBriefs(deps: NotifyDeps & { brief: (userId: string) => Promise<BriefView | null> }) {
  return async (): Promise<number> => {
    const now = deps.clock.now();
    let built = 0;
    for (const user of await deps.users.all()) {
      if (user.paused || !dueWindow(user, now, user.briefTime, BRIEF_LEAD_MINUTES, BRIEF_CUTOFF_MINUTES)) continue;
      const channel = await channelFor(deps, user);
      if (!channel) continue;
      const dedupeKey = `brief:${localDate(now, user.tz)}:${user.id}`;
      if (await deps.outbox.exists(dedupeKey)) continue;
      const b = await deps.brief(user.id);
      if (!b) continue;
      if (await deps.outbox.enqueue({ userId: user.id, channel, kind: 'brief', payload: briefMessage(b, deps.appUrl), dedupeKey, createdAt: now })) built++;
    }
    return built;
  };
}

/** Put each linked user's reveal (for yesterday) into the outbox once per day. */
export function buildDueReveals(deps: NotifyDeps & { reveal: (userId: string, date: string, opts: { ignoreSeal: boolean }) => Promise<RevealView | null> }) {
  return async (): Promise<number> => {
    const now = deps.clock.now();
    let built = 0;
    for (const user of await deps.users.all()) {
      if (user.paused || !dueWindow(user, now, user.revealTime, REVEAL_LEAD_MINUTES, REVEAL_CUTOFF_MINUTES)) continue;
      const channel = await channelFor(deps, user);
      if (!channel) continue;
      const today = localDate(now, user.tz);
      const dedupeKey = `reveal:${today}:${user.id}`;
      if (await deps.outbox.exists(dedupeKey)) continue;
      // Built up to 30 minutes before it opens in the app, so the seal is lifted explicitly here.
      const r = await deps.reveal(user.id, addDays(today, -1), { ignoreSeal: true });
      if (!r || r.total === 0) continue;
      if (await deps.outbox.enqueue({ userId: user.id, channel, kind: 'reveal', payload: revealMessage(r, deps.appUrl), dedupeKey, createdAt: now })) built++;
    }
    return built;
  };
}

/**
 * Send pending outbox entries (inside `tick` and right after the brief and reveal jobs).
 * Guardrails are applied at send time: quiet hours, pause, daily cap, staleness.
 */
export function sendOutbox(deps: NotifyDeps & { messenger: Messenger | undefined; pushSender?: PushSender }) {
  return async (limit = 20): Promise<{ sent: number; skipped: number; failed: number; waiting: number }> => {
    const stats = { sent: 0, skipped: 0, failed: 0, waiting: 0 };
    if (!deps.messenger && !deps.pushSender) return stats;
    const now = deps.clock.now();
    for (const e of await deps.outbox.pending(limit, MAX_SEND_ATTEMPTS)) {
      const user = e.userId ? await deps.users.byId(e.userId) : null;
      if (!user) {
        await deps.outbox.markSkipped(e.id, 'no_user', now);
        stats.skipped++;
        continue;
      }
      // A channel this server cannot send on waits (it may be configured later), then goes stale.
      if ((e.channel === 'telegram' && !deps.messenger) || (e.channel === 'webpush' && !(deps.pushSender && deps.push))) {
        stats.waiting++;
        continue;
      }
      const subscriptions = e.channel === 'webpush' && deps.push ? await deps.push.forUser(user.id) : [];
      const scheduled = e.kind === 'brief' || e.kind === 'reveal';
      const dayStart = zonedTimeToUtc(localDate(now, user.tz), 0, user.tz);
      const decision = decideSend({
        createdAt: e.createdAt,
        now,
        localMinutes: localMinutes(now, user.tz),
        quietStart: timeToMinutes(user.quietStart),
        quietEnd: timeToMinutes(user.quietEnd),
        paused: user.paused,
        linked: e.channel === 'telegram' ? Boolean(user.telegramChatId) : subscriptions.length > 0,
        scheduledSentToday: scheduled ? await deps.outbox.scheduledSentSince(user.id, dayStart) : 0,
        scheduled,
      });
      if (decision.action === 'wait') {
        stats.waiting++;
        continue;
      }
      if (decision.action === 'skip') {
        await deps.outbox.markSkipped(e.id, decision.reason, now);
        stats.skipped++;
        continue;
      }
      const r =
        e.channel === 'webpush'
          ? await sendPush(deps, user.id, subscriptions, e.payload)
          : await (deps.messenger as Messenger).send(user.telegramChatId as string, e.payload);
      if (r.ok) {
        await deps.outbox.markSent(e.id, deps.clock.now());
        stats.sent++;
      } else if (r.error.code === 'blocked') {
        await deps.outbox.markSkipped(e.id, 'blocked', now);
        stats.skipped++;
      } else {
        await deps.outbox.markFailed(e.id, r.error.detail ?? r.error.code);
        stats.failed++;
        deps.logger.warn('outbox.send_failed', { id: e.id, error: r.error });
      }
    }
    return stats;
  };
}

/**
 * Send to every subscribed device of the user. A device the push service reports as gone is
 * unsubscribed; the message counts as sent if any device took it.
 */
async function sendPush(
  deps: NotifyDeps & { pushSender?: PushSender },
  userId: string,
  subscriptions: readonly { endpoint: string; p256dh: string; auth: string }[],
  msg: OutboxMessage,
): Promise<{ ok: true } | { ok: false; error: { code: 'blocked' | 'failed'; detail?: string } }> {
  const sender = deps.pushSender as PushSender;
  const payload = msg.push ?? { title: 'Reckon', body: msg.text.replace(/<[^>]+>/g, '').slice(0, 180), path: '/' };
  let delivered = 0;
  let lastError = '';
  for (const s of subscriptions) {
    const r = await sender.send(s, payload);
    if (r.ok) delivered++;
    else if (r.error.code === 'gone') await deps.push?.remove(userId, s.endpoint);
    else lastError = r.error.detail ?? r.error.code;
  }
  if (delivered) return { ok: true };
  return lastError ? { ok: false, error: { code: 'failed', detail: lastError } } : { ok: false, error: { code: 'blocked', detail: 'no live subscriptions' } };
}
