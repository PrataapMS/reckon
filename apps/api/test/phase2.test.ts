import { FakeMessenger, FakeOpenMeteo, FakePushSender, FakeWorld, MemoryEvidenceStore, MemoryStore } from '@reckon/adapters';
import { CalibrationResponse, QuestionDetailResponse, ScoreboardResponse, TopicsResponse } from '@reckon/contracts';
import { build, type Container, memoryRepos } from '@reckon/runtime';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { hashPassphrase } from '../src/passphrase';

/** Phase 2 API (spec §2.5): scoreboard, calibration, topics, Web Push, and news on question detail. */

const clock = {
  t: new Date('2026-10-04T23:15:00Z'), // Monday 04:45 IST
  now() {
    return this.t;
  },
};
const store = new MemoryStore(clock);
const push = new FakePushSender();
let cookie = '';
let app: ReturnType<typeof createApp>;
let container: Container;

/** What the scheduled jobs do, without depending on the jobs app. */
async function cycle() {
  const db = container.db;
  if (!db) throw new Error('no database');
  await db.app.lockAndEnqueueResolutions();
  await db.app.enqueueDueGeneration();
  await db.app.enqueueDueWorldGeneration();
  await db.drain(db.app.handlers, 20_000);
}
const news = () => container.db?.app.runNews();

const json = (body: unknown, method = 'POST') => ({ method, body: JSON.stringify(body), headers: { 'content-type': 'application/json', cookie } });
const get = (path: string) => app.request(`/api/v1${path}`, { headers: { cookie } });

beforeAll(async () => {
  const user = store.addUser({ onboardedAt: '2026-10-01T00:00:00.000Z' });
  store.locations.push({
    id: '10000000-0000-4000-8000-000000000001',
    userId: user.id,
    name: 'Bengaluru',
    lat: 12.97,
    lon: 77.59,
    tz: 'Asia/Kolkata',
    isPrimary: true,
    createdAt: 0,
  });
  container = build(
    { SESSION_SECRET: 'x'.repeat(32), PASSPHRASE_HASH: await hashPassphrase('correct horse') },
    {
      clock,
      repos: memoryRepos(store),
      sources: { ...new FakeOpenMeteo(clock), ...new FakeWorld(clock) },
      evidenceStore: new MemoryEvidenceStore(),
      messenger: new FakeMessenger(),
      pushSender: push,
      logger: { info() {}, warn() {}, error() {} },
    },
  );
  app = createApp(container);
  const res = await app.request('/api/v1/session', json({ passphrase: 'correct horse' }));
  cookie = res.headers.get('set-cookie')?.split(';')[0] ?? '';
});

describe('Phase 2 API', () => {
  it('requires a session', async () => {
    for (const path of ['/scoreboard', '/scoreboard/calibration', '/topics']) expect((await app.request(`/api/v1${path}`)).status).toBe(401);
  });

  it('manages topics: defaults, suggestions, custom labels, removal', async () => {
    const list = TopicsResponse.parse(await (await get('/topics')).json());
    expect(list.topics.map((t) => t.label)).toContain('Bengaluru');
    expect((await app.request('/api/v1/topics', json({ label: 'x' }))).status).toBe(400);
    expect((await app.request('/api/v1/topics', json({ suggestion: 'nope' }))).status).toBe(400);
    const added = await app.request('/api/v1/topics', json({ suggestion: 'cricket' }));
    expect(added.status).toBe(201);
    const cricket = TopicsResponse.parse(await added.json()).topics.find((t) => t.label === 'Cricket');
    const removed = await app.request(`/api/v1/topics/${cricket?.id}`, { method: 'DELETE', headers: { cookie } });
    expect(TopicsResponse.parse(await removed.json()).suggestions.some((s) => s.key === 'cricket')).toBe(true);
    expect((await app.request('/api/v1/topics/00000000-0000-4000-8000-00000000ffff', { method: 'DELETE', headers: { cookie } })).status).toBe(404);
  });

  it('accepts a push subscription and advertises the VAPID key', async () => {
    const me = (await (await get('/me')).json()) as { pushPublicKey: string | null };
    expect(me.pushPublicKey).toBe(push.publicKey);
    expect((await app.request('/api/v1/push/subscribe', json({ endpoint: 'not a url', keys: { p256dh: 'k', auth: 'a' } }))).status).toBe(400);
    expect((await app.request('/api/v1/push/subscribe', json({ endpoint: 'https://push.example/1', keys: { p256dh: 'k', auth: 'a' } }))).status).toBe(204);
    expect(store.push).toHaveLength(1);
    expect((await app.request('/api/v1/push/subscribe', json({ endpoint: 'https://push.example/1' }, 'DELETE'))).status).toBe(204);
    expect(store.push).toHaveLength(0);
  });

  it('shows linked headlines on a world question and keeps them out of the raw data list', async () => {
    await cycle();
    clock.t = new Date('2026-10-05T00:05:00Z');
    await news();
    const quake = store.questions.find((q) => q.templateId === 'world.quake_m6_week');
    const detail = QuestionDetailResponse.parse(await (await get(`/questions/${quake?.id}`)).json());
    expect(detail.scope).toBe('world');
    expect(detail.news.length).toBeGreaterThan(0);
    expect(detail.news[0]?.url).toMatch(/^https:/);
    expect(detail.judged.dataset).toContain('USGS');
  });

  it('serves an empty scoreboard and calibration before anything resolves, then filled ones', async () => {
    const empty = ScoreboardResponse.parse(await (await get('/scoreboard')).json());
    expect(empty.templates).toEqual([]);
    const cal0 = CalibrationResponse.parse(await (await get('/scoreboard/calibration')).json());
    expect(cal0.n).toBe(0);
    expect(cal0.bins.every((b) => b.count === 0 && b.observed === null)).toBe(true);

    for (let day = 0; day < 9; day++) {
      clock.t = new Date(Date.parse('2026-10-05T00:05:00Z') + day * 86_400_000);
      await cycle();
      clock.t = new Date(clock.t.getTime() + 12 * 3_600_000);
      await cycle();
      clock.t = new Date(clock.t.getTime() + 10 * 3_600_000);
      await cycle();
    }
    const board = ScoreboardResponse.parse(await (await get('/scoreboard')).json());
    expect(board.resolvedQuestions).toBeGreaterThan(0);
    const cal = CalibrationResponse.parse(await (await get('/scoreboard/calibration?forecaster=history.rate%401')).json());
    expect(cal.forecaster).toBe('history.rate@1');
    expect(cal.n).toBeGreaterThan(0);
    expect((await get('/scoreboard/calibration?forecaster=')).status).toBe(400);
  }, 30_000);
});
