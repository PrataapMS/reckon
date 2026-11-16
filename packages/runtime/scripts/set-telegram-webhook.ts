import { TelegramMessenger } from '@reckon/adapters';

/**
 * Points the Telegram bot at this deployment's webhook (spec §1.5).
 * Usage: TELEGRAM_BOT_TOKEN=… TELEGRAM_WEBHOOK_SECRET=… pnpm telegram:webhook https://<site>.netlify.app
 */
const site = process.argv[2]?.replace(/\/$/, '');
const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
if (!site?.startsWith('https://') || !token || !secret) {
  console.error('Usage: TELEGRAM_BOT_TOKEN=… TELEGRAM_WEBHOOK_SECRET=… pnpm telegram:webhook https://<site>.netlify.app');
  process.exit(1);
}
if (!/^[A-Za-z0-9_-]{16,256}$/.test(secret)) {
  console.error('TELEGRAM_WEBHOOK_SECRET must be 16–256 characters of A–Z, a–z, 0–9, _ or - (Telegram secret_token rules).');
  process.exit(1);
}
const r = await new TelegramMessenger({ token }).setWebhook(`${site}/api/v1/telegram/webhook/${secret}`, secret);
if (!r.ok) {
  console.error(`setWebhook failed: ${r.error.detail ?? r.error.code}`);
  process.exit(1);
}
console.log(`Webhook set to ${site}/api/v1/telegram/webhook/<secret>`);
