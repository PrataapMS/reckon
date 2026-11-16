import { FakeMessenger, FakeOpenMeteo, FakeWorld, MemoryEvidenceStore, MemoryStore } from '@reckon/adapters';
import { build, memoryRepos } from '@reckon/runtime';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { hashPassphrase } from '../src/passphrase';

/** Phase 1 API (spec §2.5) against the in-memory stack and fake sources. */

const clock = {
  t: new Date('2026-10-05T23:15:00Z'),
  now() {
    return this.t;
  },
};
const store = new MemoryStore(clock);
const om = new FakeOpenMeteo(clock);
const tg = new FakeMessenger();
const SECRET = 'telegram-webhook-secret-123';
let cookie = '';
let userId = '';

const container = () =>
  build(
    {
      SESSION_SECRET: 'x'.repeat(32),
      PASSPHRASE_HASH: hash,
      TELEGRAM_BOT_TOKEN: 'fake',
      TELEGRAM_BOT_USERNAME: 'reckon_test_bot',
      TELEGRAM_WEBHOOK_SECRET: SECRET,
    },
    {
      clock,
      repos: memoryRepos(store),
      sources: { ...om, ...new FakeWorld(clock) },
      evidenceStore: new MemoryEvidenceStore(),
      messenger: tg,
      logger: { info() {}, warn() {}, error() {} },
    },
  );
let hash = '';
let app: ReturnType<typeof createApp>;

const json = (body: unknown, method = 'POST') => ({ method, body: JSON.stringify(body), headers: { 'content-type': 'application/json', cookie } });
const get = (path: string, headers: Record<string, string> = {}) => app.request(`/api/v1${path}`, { headers: { cookie, ...headers } });

beforeAll(async () => {
  hash = await hashPassphrase('correct horse');
  userId = store.addUser().id;
  app = createApp(container());
  const res = await app.request('/api/v1/session', {
    method: 'POST',
    body: JSON.stringify({ passphrase: 'correct horse' }),
    headers: { 'content-type': 'application/json' },
  });
  cookie = res.headers.get('set-cookie')?.split(';')[0] ?? '';
});

describe('Phase 1 API', () => {
  it('requires a session for personal data', async () => {
    expect((await app.request('/api/v1/brief/today')).status).toBe(401);
    expect((await app.request('/api/v1/me')).status).toBe(401);
  });

  it('onboards: settings, a place from city search, and generation straight away', async () => {
    const me = await get('/me');
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ user: { onboardedAt: null, telegramLinked: false }, locations: [], telegramAvailable: true });

    const geo = (await (await get('/geocode?q=Beng')).json()) as { results: { name: string; lat: number; lon: number; tz: string }[] };
    expect(geo.results[0]?.name).toBe('Bengaluru');

    const bad = await app.request('/api/v1/locations', json({ name: '', lat: 200, lon: 0, tz: 'Nowhere/City' }));
    expect(bad.status).toBe(400);
    const created = await app.request('/api/v1/locations', json({ name: 'Home', lat: 12.971599, lon: 77.594566, tz: 'Asia/Kolkata' }));
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ name: 'Home', lat: 12.97, lon: 77.59, isPrimary: true });
    expect(store.questions.length).toBeGreaterThan(0); // generated immediately (spec G4)

    const patched = await app.request(
      '/api/v1/me',
      json({ briefTime: '07:00', revealTime: '21:30', onboarded: true, settings: { actionThresholds: { rain: 0.6 } } }, 'PATCH'),
    );
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ user: { briefTime: '07:00', revealTime: '21:30', settings: { actionThresholds: { rain: 0.6 } } } });
    expect((await app.request('/api/v1/me', json({ briefTime: '7am' }, 'PATCH'))).status).toBe(400);
    expect((await app.request('/api/v1/me', json({ isAdmin: true }, 'PATCH'))).status).toBe(400);
  });

  it('serves today’s brief with ETag revalidation', async () => {
    const res = await get('/brief/today');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tomorrow: { trust: { status: string }; percent: number }[] };
    expect(body.tomorrow.length).toBeGreaterThanOrEqual(4);
    expect(body.tomorrow.every((i) => i.trust.status === 'learning')).toBe(true);
    const etag = res.headers.get('etag') ?? '';
    expect(etag).not.toBe('');
    expect((await get('/brief/today', { 'if-none-match': etag })).status).toBe(304);
  });

  it('keeps the reveal sealed until its time, and validates the date', async () => {
    const r = (await (await get('/reveal/2026-10-07')).json()) as { sealed: boolean; total: number };
    expect(r.sealed).toBe(true);
    expect((await get('/reveal/yesterday')).status).toBe(404);
    expect((await get('/reveal/latest')).status).toBe(200);
  });

  it('shows question detail and only that question’s evidence', async () => {
    const q = store.questions[0];
    if (!q) throw new Error('no question');
    const detail = await get(`/questions/${q.id}`);
    expect(detail.status).toBe(200);
    const d = (await detail.json()) as { judged: { rule: string }; evidence: { id: string; downloadPath: string }[] };
    expect(d.judged.rule).toContain('YES if');
    const ev = d.evidence[0];
    if (!ev) throw new Error('no evidence');
    const raw = await get(ev.downloadPath.replace('/api/v1', ''));
    expect(raw.status).toBe(200);
    expect(raw.headers.get('content-disposition')).toContain('attachment');
    const other = store.questions.find((x) => !store.questionEvidence.some((l) => l.questionId === x.id && l.evidenceId === ev.id));
    if (other) expect((await get(`/questions/${other.id}/evidence/${ev.id}/raw`)).status).toBe(404);
    expect((await get('/questions/00000000-0000-4000-8000-999999999999')).status).toBe(404);
  });

  it('lists questions by date range and rejects bad ranges', async () => {
    const r = await get('/questions?from=2026-10-01&to=2026-10-31');
    expect(r.status).toBe(200);
    const body = (await r.json()) as { questions: { targetDate: string }[] };
    expect(body.questions.length).toBe(store.questions.length);
    expect((await get('/questions?from=2026-10-10&to=2026-10-01')).status).toBe(400);
    expect((await get('/questions?from=2026-01-01&to=2026-12-31')).status).toBe(400);
  });

  it('keeps at least one location', async () => {
    const [loc] = store.locations;
    expect((await app.request(`/api/v1/locations/${loc?.id}`, { method: 'DELETE', headers: { cookie } })).status).toBe(409);
  });

  it('links Telegram through the webhook with both secrets checked', async () => {
    const link = (await (await app.request('/api/v1/telegram/link', json({}))).json()) as { url: string };
    const token = link.url.split('start=')[1];
    const update = { update_id: 1, message: { chat: { id: 4242, type: 'private' }, text: `/start ${token}` } };
    const post = (path: string, header?: string) =>
      app.request(`/api/v1/telegram/webhook/${path}`, {
        method: 'POST',
        body: JSON.stringify(update),
        headers: { 'content-type': 'application/json', ...(header ? { 'x-telegram-bot-api-secret-token': header } : {}) },
      });
    expect((await post('wrong', SECRET)).status).toBe(404);
    expect((await post(SECRET)).status).toBe(404);
    expect((await post(SECRET, 'wrong')).status).toBe(404);
    expect((await post(SECRET, SECRET)).status).toBe(200);
    expect(store.users.find((u) => u.id === userId)?.telegramChatId).toBe('4242');
    expect(tg.sent.at(-1)?.text).toContain('Linked');
  });

  it('ignores group chats so a brief is never broadcast', async () => {
    const before = tg.sent.length;
    const res = await app.request(`/api/v1/telegram/webhook/${SECRET}`, {
      method: 'POST',
      body: JSON.stringify({ update_id: 2, message: { chat: { id: -100, type: 'group' }, text: '/brief' } }),
      headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': SECRET },
    });
    expect(res.status).toBe(200);
    expect(tg.sent.length).toBe(before);
  });
});
