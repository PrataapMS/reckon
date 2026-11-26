import { err, ok, type PushError, type PushPayload, type PushSender, type PushSubscription, type Result } from '@reckon/core';
import { generateVAPIDKeys, sendNotification } from 'web-push';

export interface WebPushOptions {
  readonly publicKey: string;
  readonly privateKey: string;
  /** VAPID contact, 'mailto:you@example.com' or an https URL. */
  readonly subject: string;
  /** Test seam: the library call. */
  readonly sendImpl?: typeof sendNotification;
}

/** A brief or reveal older than this is not worth delivering, so the push service may drop it. */
const TTL_SECONDS = 12 * 3600;

/**
 * Web Push (VAPID) via the `web-push` library, which signs the request and encrypts the payload
 * (RFC 8291). The fallback channel when Telegram is not linked (spec §1.5).
 */
export class WebPushSender implements PushSender {
  constructor(private readonly o: WebPushOptions) {}

  get publicKey(): string {
    return this.o.publicKey;
  }

  async send(s: PushSubscription, payload: PushPayload): Promise<Result<void, PushError>> {
    const send = this.o.sendImpl ?? sendNotification;
    try {
      await send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), {
        vapidDetails: { subject: this.o.subject, publicKey: this.o.publicKey, privateKey: this.o.privateKey },
        TTL: TTL_SECONDS,
        timeout: 8_000,
      });
      return ok(undefined);
    } catch (e) {
      const status = typeof e === 'object' && e !== null && 'statusCode' in e ? Number((e as { statusCode: unknown }).statusCode) : 0;
      // 404/410: the browser unsubscribed or the subscription expired.
      if (status === 404 || status === 410) return err({ code: 'gone', detail: String(status) });
      return err({ code: 'failed', detail: status ? `HTTP ${status}` : String(e).slice(0, 200) });
    }
  }
}

export function generateVapidKeys(): { readonly publicKey: string; readonly privateKey: string } {
  return generateVAPIDKeys();
}
