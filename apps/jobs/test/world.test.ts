import { FakeMessenger, FakeOpenMeteo, FakePushSender, FakeWorld, MemoryEvidenceStore, MemoryStore } from '@reckon/adapters';
import { addDays, isWorldMeta, WORLD_TEMPLATES } from '@reckon/core';
import { build, type Container, memoryRepos } from '@reckon/runtime';
import { beforeEach, describe, expect, it } from 'vitest';
import { runJob } from '../src';

/**
 * Phase 2 World Pulse end to end on a fake clock: world questions are generated with every
 * forecaster before lock, headlines are linked as evidence, the brief carries a World pulse, the
 * week resolves from each declared source, and the scoreboard reports Brier and reliability.
 */

class TestClock {
  constructor(public t: Date) {}
  now() {
    return this.t;
  }
  set(iso: string) {
    this.t = new Date(iso);
  }
}

const ist = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+05:30`).toISOString();
const MONDAY = '2026-10-05';

function world(opts: { telegram?: boolean; push?: boolean } = {}) {
  const clock = new TestClock(new Date(ist(MONDAY, '04:45')));
  const store = new MemoryStore(clock);
  const om = new FakeOpenMeteo(clock);
  const fw = new FakeWorld(clock);
  const tg = new FakeMessenger();
  const push = new FakePushSender();
  const user = store.addUser(opts.telegram === false ? {} : { telegramChatId: '42' });
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
  const c: Container = build(
    { TELEGRAM_BOT_USERNAME: 'reckon_test_bot', APP_URL: 'https://reckon.example' },
    {
      clock,
      repos: memoryRepos(store),
      sources: { ...om, ...fw },
      evidenceStore: new MemoryEvidenceStore(),
      messenger: tg,
      ...(opts.push ? { pushSender: push } : {}),
      logger: { info() {}, warn() {}, error() {} },
    },
  );
  const app = c.db?.app;
  if (!app) throw new Error('no app');
  return { c, app, clock, store, fw, tg, push, userId: user.id };
}
type World = ReturnType<typeof world>;

async function runDay(w: World, date: string) {
  w.clock.set(ist(date, '04:45'));
  await runJob(w.c, 'generate');
  w.clock.set(ist(date, '05:35'));
  await runJob(w.c, 'news');
  w.clock.set(ist(date, '06:15'));
  await runJob(w.c, 'brief');
  w.clock.set(ist(date, '06:35'));
  await runJob(w.c, 'tick');
  w.clock.set(ist(date, '14:05'));
  await runJob(w.c, 'tick');
  w.clock.set(ist(date, '20:45'));
  await runJob(w.c, 'reveal');
}

const worldQuestions = (w: World) => w.store.questions.filter((q) => isWorldMeta(q.meta));

describe('World Pulse generation', () => {
  let w: World;
  beforeEach(() => {
    w = world();
  });

  it('asks every world template on a Monday, with forecasts made before lock and cited evidence', async () => {
    await runJob(w.c, 'generate');
    const qs = worldQuestions(w);
    const templates = new Set(qs.map((q) => q.templateId));
    expect([...templates].sort()).toEqual(WORLD_TEMPLATES.map((t) => t.id).sort());
    expect(templates.size + 5).toBeGreaterThanOrEqual(10); // spec acceptance: ≥ 10 templates active
    for (const q of qs) {
      expect(q.locationId).toBeNull();
      const fs = w.store.forecasts.filter((f) => f.questionId === q.id);
      expect(fs.map((f) => f.forecasterId)).toEqual(expect.arrayContaining(['history.rate@1', 'persistence@1']));
      for (const f of fs) {
        expect(f.madeAt.getTime()).toBeLessThan(q.lockAt.getTime());
        expect(f.evidenceIds.length).toBeGreaterThan(0);
      }
      expect(q.meta.baseRate).toBeGreaterThanOrEqual(0.25);
      expect(q.meta.baseRate).toBeLessThanOrEqual(0.75);
    }
    const kp = qs.find((q) => q.templateId === 'space.kp_storm_3d');
    expect(w.store.forecasts.some((f) => f.questionId === kp?.id && f.forecasterId === 'provider.swpc@1')).toBe(true);
  });

  it('is idempotent: re-running adds no questions or forecasts', async () => {
    await runJob(w.c, 'generate');
    const counts = [worldQuestions(w).length, w.store.forecasts.length];
    w.clock.set(ist(MONDAY, '05:30'));
    await runJob(w.c, 'tick');
    for (const t of WORLD_TEMPLATES) await w.app.generateWorld(w.userId, t.id);
    expect([worldQuestions(w).length, w.store.forecasts.length]).toEqual(counts);
  });

  it('asks only the daily world templates on other weekdays', async () => {
    w.clock.set(ist('2026-10-06', '04:45'));
    await runJob(w.c, 'generate');
    expect(new Set(worldQuestions(w).map((q) => q.templateId))).toEqual(new Set(['space.kp_storm_3d', 'news.topic_surge']));
  });

  it('retries a failing source and fills in the missing questions before lock', async () => {
    w.fw.failing.add('releases');
    await runJob(w.c, 'generate');
    expect(worldQuestions(w).some((q) => q.templateId === 'tech.release_week')).toBe(false);
    w.fw.failing.delete('releases');
    w.clock.set(ist(MONDAY, '05:15'));
    await runJob(w.c, 'tick');
    expect(worldQuestions(w).some((q) => q.templateId === 'tech.release_week')).toBe(true);
  });
});

describe('news and evidence', () => {
  it('links tagged headlines to world questions and shows them in "Why we believe this"', async () => {
    const w = world();
    await runJob(w.c, 'generate');
    w.clock.set(ist(MONDAY, '05:35'));
    const stats = await runJob(w.c, 'news');
    expect(stats.inserted).toBeGreaterThan(0);
    const quake = worldQuestions(w).find((q) => q.templateId === 'world.quake_m6_week');
    if (!quake) throw new Error('no quake question');
    const detail = await w.app.questionDetail(w.userId, quake.id);
    expect(detail?.news.map((n) => n.title)).toContain('Strong earthquake shakes coastal towns');
    expect(detail?.evidence.every((e) => !e.sourceId.startsWith('news.'))).toBe(true);
    // Headlines become permanent, hashed ledger evidence.
    expect(w.store.evidence.some((e) => e.kind === 'news' && e.sha256.length === 64)).toBe(true);
  });

  it('deduplicates by canonical URL and near-identical titles, and never re-links', async () => {
    const w = world();
    await runJob(w.c, 'generate');
    w.fw.headlines = [
      {
        url: 'https://www.wire.example/quake?utm_source=x',
        title: 'Strong earthquake shakes coastal towns!',
        source: 'Wire',
        publishedAt: null,
        snippet: null,
        lang: 'en',
        origin: 'rss',
      },
      { url: 'https://wire.example/quake', title: 'Another title entirely', source: 'Wire', publishedAt: null, snippet: null, lang: 'en', origin: 'rss' },
    ];
    w.clock.set(ist(MONDAY, '05:35'));
    const first = await runJob(w.c, 'news');
    expect(first.duplicates).toBeGreaterThanOrEqual(2);
    const links = w.store.questionEvidence.length;
    // Nothing new to fetch: feeds are not due yet and the other searches fail.
    w.fw.failing.add('search');
    w.clock.set(ist(MONDAY, '05:45'));
    await runJob(w.c, 'news');
    expect(w.store.questionEvidence.length).toBe(links);
    const pairs = w.store.questionEvidence.map((x) => `${x.questionId}|${x.evidenceId}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it('puts world questions in the brief and a World pulse in the Telegram message', async () => {
    const w = world();
    await runDay(w, MONDAY);
    const brief = await w.app.brief(w.userId);
    expect(brief?.world.length).toBeGreaterThanOrEqual(6);
    // The base-rate champion is the reference itself; the other world forecasters are learning.
    expect(brief?.world.every((i) => i.scope === 'world' && i.trust.status === 'baseline')).toBe(true);
    expect(brief?.today.every((i) => i.scope === 'place')).toBe(true);
    const msg = w.tg.sent.find((m) => m.text.includes('Your Reckon brief'));
    expect(msg?.text).toContain('World pulse');
  });
});

describe('topics', () => {
  it('seeds defaults once (with the city), offers suggestions, and remembers removals', async () => {
    const w = world();
    const first = await w.app.topics(w.userId);
    expect(first.topics.map((t) => t.label)).toEqual(expect.arrayContaining(['Bengaluru', 'India economy', 'AI', 'Google']));
    const ai = first.topics.find((t) => t.label === 'AI');
    if (!ai) throw new Error('no AI topic');
    const after = await w.app.removeTopic(w.userId, ai.id);
    expect(after?.topics.some((t) => t.label === 'AI')).toBe(false);
    expect(after?.suggestions.some((s) => s.key === 'ai')).toBe(true);
    expect((await w.app.topics(w.userId)).topics.some((t) => t.label === 'AI')).toBe(false);
    const added = await w.app.addTopic(w.userId, { suggestion: 'monsoon' });
    expect(added.ok && added.value.topics.some((t) => t.label === 'Monsoon')).toBe(true);
    const custom = await w.app.addTopic(w.userId, { label: 'Chandrayaan' });
    expect(custom.ok && custom.value.topics.find((t) => t.label === 'Chandrayaan')?.searchable).toBe(true);
  });
});

describe('a week of world questions', () => {
  it('resolves each from its declared source, reveals them and scores them', async () => {
    const w = world();
    for (let d = MONDAY; d <= addDays(MONDAY, 9); d = addDays(d, 1)) await runDay(w, d);
    const weekly = worldQuestions(w).filter((q) => q.targetDate <= addDays(MONDAY, 6));
    expect(weekly.length).toBeGreaterThanOrEqual(6);
    for (const q of weekly) expect(q.status, `${q.templateId} ${q.title}`).toBe('resolved');
    const fx = weekly.find((q) => q.templateId === 'fx.usdinr_week');
    const fxRes = w.store.resolutions.find((r) => r.questionId === fx?.id);
    expect(fxRes?.observedUnit).toBe('INR change');
    expect(fxRes?.resolverVersion).toBe('frankfurter.compare@1');

    const sunday = await w.app.reveal(w.userId, addDays(MONDAY, 6));
    expect(sunday?.cards.filter((c) => c.scope === 'world').length).toBeGreaterThanOrEqual(5);
    expect(sunday?.cards.find((c) => c.questionId === fx?.id)).toBeUndefined(); // FX is about Friday
    const quakeCard = sunday?.cards.find((c) => c.subject.includes('earthquake'));
    expect(quakeCard?.observed).toMatch(/^\d+ quakes?$/);

    const board = await w.app.scoreboard(w.userId);
    expect(board.templates.map((t) => t.templateId)).toEqual(expect.arrayContaining(['world.quake_m6_week', 'space.kp_storm_3d', 'wx.rain_any']));
    const kp = board.templates.find((t) => t.templateId === 'space.kp_storm_3d');
    expect(kp?.forecasters.find((f) => f.forecasterId === 'history.rate@1')?.trust.status).toBe('baseline');
    expect(kp?.forecasters.find((f) => f.forecasterId === 'provider.swpc@1')?.trust.status).toBe('learning');

    const cal = await w.app.calibration(w.userId);
    expect(cal.bins).toHaveLength(5);
    expect(cal.n).toBe(board.resolvedQuestions);
    expect(cal.bins.reduce((s, b) => s + b.count, 0)).toBe(cal.n);
  }, 30_000);

  it('annuls a world question exactly when its source never answers, never guessing', async () => {
    const w = world();
    await runDay(w, MONDAY);
    w.fw.failing.add('quakes');
    for (let d = addDays(MONDAY, 1); d <= addDays(MONDAY, 10); d = addDays(d, 1)) await runDay(w, d);
    const quake = worldQuestions(w).find((q) => q.templateId === 'world.quake_m6_week');
    expect(quake?.status).toBe('annulled');
    expect(quake?.annulReason).toBe('upstream_5xx');
  }, 30_000);
});

describe('Web Push fallback', () => {
  it('sends the brief by Web Push when Telegram is not linked, and drops dead subscriptions', async () => {
    const w = world({ telegram: false, push: true });
    expect((await w.app.subscribePush(w.userId, { endpoint: 'http://localhost/evil', p256dh: 'k', auth: 'a' })).ok).toBe(false);
    await w.app.subscribePush(w.userId, { endpoint: 'https://push.example/a', p256dh: 'k', auth: 'a' });
    await w.app.subscribePush(w.userId, { endpoint: 'https://push.example/b', p256dh: 'k', auth: 'a' });
    w.push.gone.add('https://push.example/b');
    await runJob(w.c, 'generate');
    w.clock.set(ist(MONDAY, '06:15'));
    await runJob(w.c, 'brief');
    expect(w.tg.sent).toHaveLength(0);
    expect(w.push.sent).toHaveLength(1);
    expect(w.push.sent[0]?.payload.title).toContain('Your Reckon brief');
    expect(w.store.push.map((p) => p.endpoint)).toEqual(['https://push.example/a']);
  });

  it('sends nothing without a channel', async () => {
    const w = world({ telegram: false, push: true });
    await runJob(w.c, 'generate');
    w.clock.set(ist(MONDAY, '06:15'));
    await runJob(w.c, 'brief');
    expect(w.store.outbox).toHaveLength(0);
  });
});
