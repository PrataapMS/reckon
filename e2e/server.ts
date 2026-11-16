import { serve } from '@hono/node-server';
import { FakeMessenger, FakeOpenMeteo, FakeWorld, MemoryEvidenceStore, MemoryStore } from '@reckon/adapters';
import { createApp } from '@reckon/api';
import { hashPassphrase } from '@reckon/api/passphrase';
import { type JobName, runJob } from '@reckon/jobs';
import { build, memoryRepos } from '@reckon/runtime';
import { Hono } from 'hono';

/**
 * E2E stack (spec §2.6, Playwright on a fake clock): the real API, use cases and jobs over
 * in-memory repositories and a deterministic fake Open-Meteo. The `/__e2e/*` control routes exist
 * only in this server, never in the deployed app.
 */
export const E2E_PASSPHRASE = 'e2e correct horse battery';
const port = Number(process.env.E2E_API_PORT ?? 8790);

const passphraseHash = await hashPassphrase(E2E_PASSPHRASE);

/** One fake world: clock, in-memory ledger, fake sources and Telegram. Rebuilt by /__e2e/reset. */
function makeWorld() {
  const clock = {
    t: new Date(process.env.E2E_START ?? '2026-10-06T04:00:00+05:30'),
    now() {
      return this.t;
    },
  };
  const store = new MemoryStore(clock);
  store.addUser();
  const tg = new FakeMessenger();
  const container = build(
    {
      SESSION_SECRET: 'e2e-session-secret-that-is-long-enough',
      PASSPHRASE_HASH: passphraseHash,
      TELEGRAM_BOT_TOKEN: 'fake',
      TELEGRAM_BOT_USERNAME: 'reckon_e2e_bot',
    },
    {
      clock,
      repos: memoryRepos(store),
      sources: { ...new FakeOpenMeteo(clock), ...new FakeWorld(clock) },
      evidenceStore: new MemoryEvidenceStore(),
      messenger: tg,
      logger: { info() {}, warn() {}, error: console.error },
    },
  );
  return { clock, tg, container, api: createApp(container) };
}

let world = makeWorld();
const app = new Hono();
app.post('/__e2e/reset', (c) => {
  world = makeWorld();
  return c.json({ ok: true });
});
app.post('/__e2e/clock', async (c) => {
  const { iso } = (await c.req.json()) as { iso: string };
  world.clock.t = new Date(iso);
  return c.json({ now: world.clock.t.toISOString() });
});
app.post('/__e2e/run/:job', async (c) => c.json(await runJob(world.container, c.req.param('job') as JobName)));
app.get('/__e2e/telegram', (c) => c.json(world.tg.sent));
app.all('/api/*', (c) => world.api.fetch(c.req.raw));

serve({ fetch: app.fetch, port }, () => console.log(`E2E API on http://localhost:${port}`));
