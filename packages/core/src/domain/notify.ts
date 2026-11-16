/**
 * Notification guardrails (spec §1.4 and §1.5), enforced at send time: quiet hours, at most two
 * scheduled pushes per local day, nothing stale, and nothing while paused.
 */

export const MAX_SCHEDULED_PER_DAY = 2;
export const MAX_SEND_ATTEMPTS = 5;
/** A brief or reveal older than this is no longer worth sending. */
export const STALE_AFTER_MS = 12 * 3_600_000;

/** Is `minutes` (since local midnight) inside quiet hours? Handles ranges that wrap midnight. */
export function inQuietHours(minutes: number, quietStart: number, quietEnd: number): boolean {
  if (quietStart === quietEnd) return false;
  return quietStart < quietEnd ? minutes >= quietStart && minutes < quietEnd : minutes >= quietStart || minutes < quietEnd;
}

export type SendDecision = { readonly action: 'send' } | { readonly action: 'wait' } | { readonly action: 'skip'; readonly reason: string };

export interface SendContext {
  readonly createdAt: Date;
  readonly now: Date;
  readonly localMinutes: number;
  readonly quietStart: number;
  readonly quietEnd: number;
  readonly paused: boolean;
  readonly linked: boolean;
  readonly scheduledSentToday: number;
  readonly scheduled: boolean; // brief and reveal count toward the cap; replies do not
}

export function decideSend(c: SendContext): SendDecision {
  if (!c.linked) return { action: 'skip', reason: 'not_linked' };
  if (c.paused) return { action: 'skip', reason: 'paused' };
  if (c.now.getTime() - c.createdAt.getTime() > STALE_AFTER_MS) return { action: 'skip', reason: 'stale' };
  if (c.scheduled && c.scheduledSentToday >= MAX_SCHEDULED_PER_DAY) return { action: 'skip', reason: 'daily_cap' };
  if (inQuietHours(c.localMinutes, c.quietStart, c.quietEnd)) return { action: 'wait' };
  return { action: 'send' };
}
