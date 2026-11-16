import { z } from 'zod';

/** All configuration comes from the environment and is validated once at startup. */
const Env = z.object({
  DATABASE_URL: z.string().optional(),
  SESSION_SECRET: z.string().min(16, 'SESSION_SECRET must be at least 16 characters').optional(),
  PASSPHRASE_HASH: z.string().optional(),
  DEFAULT_LAT: z.coerce.number().min(-90).max(90).default(12.97),
  DEFAULT_LON: z.coerce.number().min(-180).max(180).default(77.59),
  DEFAULT_TZ: z.string().default('Asia/Kolkata'),
  CONTACT_EMAIL: z.string().default('unknown'),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_BOT_USERNAME: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
  /** Public site URL for "Open in Reckon" buttons. Netlify sets URL automatically. */
  APP_URL: z.string().optional(),
  URL: z.string().optional(),
  /** Where raw evidence goes: Netlify Blobs in production, files locally. */
  EVIDENCE_STORE: z.enum(['netlify', 'fs', 'memory']).optional(),
  EVIDENCE_DIR: z.string().default('.data/evidence'),
  /** Optional: raises GitHub's limit from 60 to 5,000 requests an hour (no scopes needed). */
  GITHUB_TOKEN: z.string().optional(),
  /** Web Push (VAPID) keys from `pnpm push:keys`; without them Web Push is off. */
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().optional(),
  /** Netlify sets these inside functions; used to pick the evidence store automatically. */
  NETLIFY_BLOBS_CONTEXT: z.string().optional(),
  SITE_ID: z.string().optional(),
});
export type Config = z.infer<typeof Env>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const r = Env.safeParse(cleaned);
  if (!r.success) throw new Error(`Invalid configuration: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return r.data;
}

export function appUrl(c: Config): string | undefined {
  return c.APP_URL ?? c.URL;
}

export function evidenceStoreKind(c: Config): 'netlify' | 'fs' | 'memory' {
  return c.EVIDENCE_STORE ?? (c.NETLIFY_BLOBS_CONTEXT || c.SITE_ID ? 'netlify' : 'fs');
}
