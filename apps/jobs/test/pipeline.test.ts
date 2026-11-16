import { FakeMessenger, FakeOpenMeteo, FakeWorld, MemoryEvidenceStore, MemoryStore } from '@reckon/adapters';
import { build, type Container, memoryRepos } from '@reckon/runtime';
import { beforeEach, describe, expect, it } from 'vitest';
import { runJob } from '../src';

/**
 * The Phase 1 daily loop end to end on a fake clock (spec §1.3): generate → brief → lock →
 * resolve → reveal, with in-memory repositories that enforce the same ledger rules as Postgres.
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

/** Instants in Bengaluru (UTC+05:30). */
const ist = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+05:30`).toISOString();

interface World {
  c: Container;
  app: NonNullable<Container['db']>['app'];
  clock: TestClock;
  store: MemoryStore;
  om: FakeOpenMeteo;
  fw: FakeWorld;
  tg: FakeMessenger;
  evidence: MemoryEvidenceStore;
  userId: string;
}

function world(): World {
  const clock = new TestClock(new Date(ist('2026-10-06', '04:45')));
  const store = new MemoryStore(clock);
  const om = new FakeOpenMeteo(clock);
  const fw = new FakeWorld(clock);
  const tg = new FakeMessenger();
  const evidence = new MemoryEvidenceStore();
  const user = store.addUser({ telegramChatId: '42' });
  store.locations.push({
    id: '10000000-0000-4000-8000-000000000001',
    userId: user.id,
    name: 'Home',
    lat: 12.97,
    lon: 77.59,
    tz: 'Asia/Kolkata',
    isPrimary: true,
    createdAt: 0,
  });
  const c = build(
    { TELEGRAM_BOT_USERNAME: 'reckon_test_bot', APP_URL: 'https://reckon.example' },
    { clock, repos: memoryRepos(store), sources: { ...om, ...fw }, evidenceStore: evidence, messenger: tg, logger: { info() {}, warn() {}, error() {} } },
  );
  const app = c.db?.app;
  if (!app) throw new Error('no app');
  return { c, app, clock, store, om, fw, tg, evidence, userId: user.id };
}

/** One local day of scheduled jobs, in the order Netlify runs them. */
async function runDay(w: World, date: string) {
  w.clock.set(ist(date, '04:45'));
  await runJob(w.c, 'generate');
  w.clock.set(ist(date, '06:15'));
  await runJob(w.c, 'brief');
  w.clock.set(ist(date, '06:35'));
  await runJob(w.c, 'tick');
  w.clock.set(ist(date, '20:45'));
  await runJob(w.c, 'reveal');
}

describe('the daily loop', () => {
  let w: World;
  beforeEach(() => {
    w = world();
  });

  it('generates questions with every applicable forecaster before lock, idempotently', async () => {
    await runJob(w.c, 'generate');
    const qs = w.store.questions;
    expect(qs.length).toBeGreaterThanOrEqual(8);
    for (const q of qs) {
      const fs = w.store.forecasts.filter((f) => f.questionId === q.id);
      expect(fs.length, q.title).toBeGreaterThanOrEqual(2);
      for (const f of fs) expect(f.madeAt.getTime()).toBeLessThan(q.lockAt.getTime());
      expect(fs.every((f) => f.evidenceIds.length > 0)).toBe(true);
    }
    expect(w.store.climatology.size).toBe(3);
    expect(w.evidence.items.size).toBeGreaterThan(0);

    const before = { q: qs.length, f: w.store.forecasts.length };
    await runJob(w.c, 'generate'); // same day: dedupe key stops a second generation
    await w.app.generate('10000000-0000-4000-8000-000000000001'); // a direct rerun adds nothing either
    expect({ q: w.store.questions.length, f: w.store.forecasts.length }).toEqual(before);
  });

  it('fills in missing forecasts on retry when a source was down, but never after lock', async () => {
    w.om.failing.add('ensemble');
    await runJob(w.c, 'generate');
    expect(w.store.forecasts.some((f) => f.forecasterId === 'ensemble.openmeteo@1')).toBe(false);
    w.om.failing.delete('ensemble');
    w.clock.set(ist('2026-10-06', '05:10'));
    await runJob(w.c, 'tick'); // the generate item retries after 20 minutes
    expect(w.store.forecasts.some((f) => f.forecasterId === 'ensemble.openmeteo@1')).toBe(true);

    const count = w.store.forecasts.length;
    w.clock.set(ist('2026-10-06', '07:00')); // after the 06:30 lock
    await w.app.generate('10000000-0000-4000-8000-000000000001');
    expect(w.store.forecasts.length).toBe(count);
  });

  it('runs a full week: briefs with ≥ 4 items, resolutions with evidence, sealed then opened reveals', async () => {
    for (const d of ['2026-10-06', '2026-10-07', '2026-10-08']) await runDay(w, d);

    // Brief on 8 Oct: today's items are the 1-day questions generated on 7 Oct.
    w.clock.set(ist('2026-10-08', '07:00'));
    const brief = await w.app.brief(w.userId);
    expect(brief?.today.length).toBeGreaterThanOrEqual(4);
    expect(brief?.today.every((i) => i.status === 'locked' && i.trust.status === 'learning')).toBe(true);
    expect(brief?.today.find((i) => i.templateId === 'wx.rain_any')?.forecaster.id).toBe('ensemble.openmeteo@1');
    expect(brief?.today.find((i) => i.templateId === 'air.aqi_decision')?.forecaster.id).toBe('provider.openmeteo@1');

    // One brief per day reached Telegram, before the brief time.
    const briefs = w.tg.sent.filter((m) => m.text.includes('Your Reckon brief'));
    expect(briefs).toHaveLength(3);
    expect(briefs[2]?.text).toContain('Today');
    expect(briefs[2]?.buttons?.[0]?.url).toBe('https://reckon.example/');

    // Questions about 7 Oct resolved on the 8 Oct morning tick, each with a raw snapshot.
    // Open-Meteo questions only: world questions about the same day resolve from their own sources.
    const oct7 = w.store.questions.filter((q) => q.targetDate === '2026-10-07' && q.locationId !== null);
    expect(oct7.length).toBeGreaterThan(0);
    expect(oct7.every((q) => q.status === 'resolved')).toBe(true);
    for (const q of oct7) {
      const r = w.store.resolutions.find((x) => x.questionId === q.id);
      expect(r?.evidenceId).toBeTruthy();
      expect(w.store.questionEvidence.some((x) => x.questionId === q.id && x.evidenceId === r?.evidenceId)).toBe(true);
    }

    // The reveal for 7 Oct is sealed until 21:00 on 8 Oct, then opens with outcomes and scores.
    w.clock.set(ist('2026-10-08', '20:59'));
    const sealed = await w.app.reveal(w.userId, '2026-10-07');
    expect(sealed?.sealed).toBe(true);
    expect(sealed?.cards).toEqual([]);
    expect(sealed?.total).toBeGreaterThan(0);
    w.clock.set(ist('2026-10-08', '21:00'));
    const open = await w.app.reveal(w.userId, 'latest');
    expect(open?.date).toBe('2026-10-07');
    expect(open?.sealed).toBe(false);
    expect(open?.cards.every((c) => c.outcome === 0 || c.outcome === 1)).toBe(true);
    expect(open?.summary.meanBrier).not.toBeNull();
    expect(open?.cards[0]?.forecasts.length).toBeGreaterThanOrEqual(2);

    // The 20:45 reveal job sent it to Telegram once.
    expect(w.tg.sent.filter((m) => m.text.includes('The Reveal · Wed 7 Oct'))).toHaveLength(1);
  });

  it('shows how each question is judged and serves its raw evidence', async () => {
    for (const d of ['2026-10-06', '2026-10-07']) await runDay(w, d);
    w.clock.set(ist('2026-10-08', '07:00'));
    await runJob(w.c, 'tick'); // resolves 7 Oct
    const q = w.store.questions.find((x) => x.targetDate === '2026-10-07' && x.templateId === 'wx.rain_any');
    if (!q) throw new Error('no question');

    const sealedDetail = await w.app.questionDetail(w.userId, q.id);
    expect(sealedDetail?.sealed).toBe(true);
    expect(sealedDetail?.resolution).toBeNull();
    expect(sealedDetail?.evidence.some((e) => e.purpose === 'resolution')).toBe(false);

    w.clock.set(ist('2026-10-08', '21:30'));
    const d = await w.app.questionDetail(w.userId, q.id);
    expect(d?.judged.dataset).toContain('Open-Meteo');
    expect(d?.criteriaHash).toMatch(/^[0-9a-f]{64}$/);
    expect(d?.resolution?.outcome === 0 || d?.resolution?.outcome === 1).toBe(true);
    expect(d?.forecasts.every((f) => f.brier != null)).toBe(true);
    const res = d?.evidence.find((e) => e.purpose === 'resolution');
    expect(res?.downloadPath).toBe(`/api/v1/questions/${q.id}/evidence/${res?.id}/raw`);
    const raw = await w.app.evidenceRaw(w.userId, q.id, res?.id ?? '');
    expect(JSON.parse(raw?.body ?? '{}')).toHaveProperty('value');
    expect(await w.app.evidenceRaw(w.userId, q.id, '00000000-0000-4000-8000-999999999999')).toBeNull();
  });

  it('retries a failing source on the backoff schedule and annuls at 72 hours, never guessing', async () => {
    await runDay(w, '2026-10-06');
    w.om.failing.add('observations');
    // 7 Oct questions become due at 06:00 on 8 Oct (window end + 6 h).
    for (let h = 0; h <= 96; h++) {
      w.clock.set(new Date(Date.parse(ist('2026-10-08', '06:05')) + h * 3_600_000).toISOString());
      await runJob(w.c, 'tick');
    }
    // Open-Meteo questions only: world questions about the same day resolve from their own sources.
    const oct7 = w.store.questions.filter((q) => q.targetDate === '2026-10-07' && q.locationId !== null);
    expect(oct7.length).toBeGreaterThan(0);
    for (const q of oct7) {
      expect(q.status).toBe('annulled');
      expect(q.annulReason).toBe('upstream_5xx');
      expect(w.store.resolutions.find((r) => r.questionId === q.id)?.outcome).toBeNull();
    }
    // Annulled at the deadline (72 h after the window closed), not at the next backoff step.
    const ids = new Set(oct7.map((q) => q.id));
    const lastResolve = w.store.work
      .filter((x) => x.kind === 'resolve' && ids.has((x.payload as { questionId: string }).questionId))
      .map((x) => x.runAfter.getTime());
    expect(Math.max(...lastResolve)).toBeLessThanOrEqual(Date.parse(ist('2026-10-11', '00:00')));
  });
});

describe('Telegram', () => {
  it('links a chat with a one-time token and answers commands', async () => {
    const w = world();
    await w.app.updateMe(w.userId, {}); // no-op
    w.store.users[0] = { ...(w.store.users[0] as (typeof w.store.users)[number]), telegramChatId: null };
    const link = await w.app.telegramLink(w.userId);
    expect(link?.url).toMatch(/^https:\/\/t\.me\/reckon_test_bot\?start=[\w-]{20,}$/);
    const token = link?.url.split('start=')[1] ?? '';

    await w.app.telegramMessage('777', `/start ${token}`);
    expect(w.tg.sent.at(-1)?.text).toContain('Linked');
    expect((await w.app.me(w.userId))?.user.telegramLinked).toBe(true);

    await w.app.telegramMessage('888', `/start ${token}`); // single use
    expect(w.tg.sent.at(-1)?.text).toContain('expired or was already used');
    await w.app.telegramMessage('888', '/brief');
    expect(w.tg.sent.at(-1)?.text).toContain('not linked');

    await w.app.telegramMessage('777', '/pause');
    expect((await w.app.me(w.userId))?.user.paused).toBe(true);
    await runJob(w.c, 'generate');
    w.clock.set(ist('2026-10-06', '06:15'));
    const sentBefore = w.tg.sent.length;
    await runJob(w.c, 'brief');
    expect(w.tg.sent.length).toBe(sentBefore); // paused: no scheduled brief
    await w.app.telegramMessage('777', '/brief'); // but commands still answer
    expect(w.tg.sent.at(-1)?.text).toContain('Your Reckon brief');

    await w.app.telegramMessage('777', '/stop');
    expect((await w.app.me(w.userId))?.user.telegramLinked).toBe(false);
  });
});
