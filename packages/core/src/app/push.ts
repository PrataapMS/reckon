import { err, ok, type Result } from '../domain/result';
import type { PushSubscription, PushSubscriptionRepo } from '../ports';

/** Web Push endpoints are HTTPS URLs on the browser vendor's push service. */
function validEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && !/^(localhost|\d+\.\d+\.\d+\.\d+|\[.*\])$/.test(u.hostname);
  } catch {
    return false;
  }
}

/** At most a few devices per user; the oldest extra subscriptions stop mattering after one failed send. */
export function subscribePush(deps: { push: PushSubscriptionRepo }) {
  return async (userId: string, s: PushSubscription): Promise<Result<true, { code: 'invalid_endpoint' }>> => {
    if (!validEndpoint(s.endpoint)) return err({ code: 'invalid_endpoint' });
    await deps.push.add(userId, s);
    return ok(true);
  };
}

export function unsubscribePush(deps: { push: PushSubscriptionRepo }) {
  return (userId: string, endpoint: string): Promise<boolean> => deps.push.remove(userId, endpoint);
}
