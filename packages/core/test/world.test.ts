import { describe, expect, it } from 'vitest';
import { formatObserved } from '../src/app/views';
import { frankfurterResolver, githubReleasesResolver, statuspageResolver, swpcKpResolver } from '../src/app/world-resolvers';
import { Criteria, evaluate } from '../src/domain/criteria';
import { describeCriteria } from '../src/domain/describe';
import { ok } from '../src/domain/result';
import type { GeomagForecast, KpPoint } from '../src/domain/world-data';
import { historyRate, historyRateForecaster, swpcProviderForecaster, worldPersistenceForecaster } from '../src/domain/world-forecasters';
import {
  DEFAULT_WATCH,
  fxUsdInrWeek,
  kpMax,
  median,
  needKey,
  newsTopicSurge,
  spaceKpStorm3d,
  surgeThreshold,
  swpcWindowChance,
  techReleaseWeek,
  topicOfTheDay,
  type WorldCtx,
  type WorldData,
  type WorldNeed,
  worldQuakeWeek,
} from '../src/domain/world-templates';

const MONDAY = '2026-10-05';
const ctx = (over: Partial<WorldCtx> = {}): WorldCtx => ({
  now: new Date('2026-10-04T23:15:00Z'), // 04:45 IST on Monday
  today: MONDAY,
  tz: 'Asia/Kolkata',
  briefMinutes: 6 * 60 + 30,
  topics: [],
  watch: DEFAULT_WATCH,
  ...over,
});
const data = (entries: [WorldNeed, unknown][]): WorldData => {
  const m = new Map(entries.map(([n, v]) => [needKey(n), v]));
  return { get: (n) => m.get(needKey(n)) as never };
};
const snap = <T>(parsed: T) => ok({ sourceId: 'test', fetchedAt: '2026-10-12T00:00:00Z', requestUrl: 'https://x', raw: '{}', parsed });

describe('history.rate and persistence for windows', () => {
  it('needs 8 windows, uses at most the last 52, and clips', () => {
    expect(historyRate({ outcomes: [true, false, true], unit: 'weeks' })).toBeNull();
    const h = { outcomes: [...Array(10).fill(false), ...Array(52).fill(true)], unit: 'weeks' };
    expect(historyRate(h)).toEqual({ k: 52, n: 52, rate: 1 });
    expect(historyRateForecaster.forecast({ history: h })?.p).toBe(0.99);
    expect(historyRateForecaster.forecast({ history: h })?.rationale).toBe('Happened in 52 of the last 52 comparable weeks.');
    expect(worldPersistenceForecaster.forecast({ history: { outcomes: [true, false], unit: 'weeks' } })?.p).toBe(0.3);
    expect(swpcProviderForecaster.forecast({})).toBeNull();
  });
});

describe('weekly windows', () => {
  it('run from Monday’s brief to the end of Sunday, and skip a generation after the brief', () => {
    const quakes = Array.from({ length: 53 }, (_, k) => ({
      id: `q${k}`,
      time: new Date(Date.parse('2026-10-01T00:00:00Z') - k * 7 * 86_400_000).toISOString(),
      magnitude: k % 2 ? 6.6 : 6.1,
      place: '',
      url: '',
    }));
    const c = ctx();
    const [need] = worldQuakeWeek.needs(c);
    if (!need) throw new Error('no need');
    const [q] = worldQuakeWeek.candidates(c, data([[need, quakes]]));
    expect(q?.spec.windowStart.toISOString()).toBe('2026-10-05T01:00:00.000Z'); // 06:30 IST
    expect(q?.spec.lockAt.toISOString()).toBe('2026-10-05T01:00:00.000Z');
    expect(q?.spec.windowEnd.toISOString()).toBe('2026-10-11T18:30:00.000Z'); // Monday 00:00 IST
    expect(q?.spec.targetDate).toBe('2026-10-11');
    expect(q?.spec.criteria).toMatchObject({ kind: 'count', filter: { minMagnitude: 6.5 }, threshold: 1 });
    expect(Criteria.safeParse(q?.spec.criteria).success).toBe(true);
    expect(q?.spec.meta.baseRate).toBe(0.5);

    const late = ctx({ now: new Date('2026-10-05T02:00:00Z') });
    expect(worldQuakeWeek.candidates(late, data([[worldQuakeWeek.needs(late)[0] as WorldNeed, quakes]]))).toEqual([]);
    expect(worldQuakeWeek.needs(ctx({ today: '2026-10-06' }))).toEqual([]);
  });

  it('only count release weeks the listing fully covers', () => {
    const releases = Array.from({ length: 100 }, (_, i) => ({
      tag: `v${i}`,
      name: null,
      publishedAt: new Date(Date.parse('2026-10-03T00:00:00Z') - i * 1.5 * 86_400_000).toISOString(),
      prerelease: false,
      url: '',
    }));
    // A full page reaching back ~150 days: only ~21 weeks count, and they always had a release.
    const c = ctx({ watch: { repos: [{ repo: 'a/b', label: 'B', keywords: [] }], services: [] } });
    const qs = techReleaseWeek.candidates(
      c,
      data([
        [
          { kind: 'releases', repo: 'a/b' },
          { repo: 'a/b', releases, complete: false },
        ],
      ]),
    );
    expect(qs).toEqual([]); // base rate 100%: not informative, so not asked
  });
});

describe('fx.usdinr_week', () => {
  it('compares Friday with Monday between the ECB fixing times', () => {
    const rates = [];
    for (let k = 0; k <= 60; k++) {
      const mon = new Date(Date.parse(`${MONDAY}T00:00:00Z`) - k * 7 * 86_400_000).toISOString().slice(0, 10);
      const fri = new Date(Date.parse(`${mon}T00:00:00Z`) + 4 * 86_400_000).toISOString().slice(0, 10);
      rates.push({ date: mon, rate: 83 }, { date: fri, rate: k % 2 ? 83.1 : 82.9 });
    }
    const c = ctx();
    const [q] = fxUsdInrWeek.candidates(c, data([[fxUsdInrWeek.needs(c)[0] as WorldNeed, rates]]));
    expect(q?.spec.criteria).toEqual({
      kind: 'compare',
      source: { id: 'frankfurter', version: '1' },
      missingPolicy: { retryUntilHours: 72, thenOutcome: 'annul' },
      metric: 'USD/INR',
      a: { at: '2026-10-05' },
      b: { at: '2026-10-09' },
      comparator: '>',
    });
    expect(q?.spec.windowStart.toISOString()).toBe('2026-10-05T12:00:00.000Z');
    expect(q?.spec.windowEnd.toISOString()).toBe('2026-10-09T16:00:00.000Z');
    expect(q?.spec.horizonDays).toBe(4);
    expect(q?.inputs.history?.outcomes).toHaveLength(52);
  });
});

describe('space.kp_storm_3d', () => {
  const slots = (from: string, days: number, kp: (i: number) => number): KpPoint[] =>
    Array.from({ length: days * 8 }, (_, i) => ({ time: new Date(Date.parse(from) + i * 3 * 3_600_000).toISOString(), kp: kp(i) }));

  it('starts at the first 3-hour slot after the brief and lasts 72 hours', () => {
    // A storm in every other 3-day window, counted back from the question's own window.
    const points = slots('2026-04-02T03:00:00Z', 186, (i) => (Math.floor(i / 24) % 2 ? 5.33 : 2));
    const c = ctx();
    const [hist] = spaceKpStorm3d.needs(c);
    const [q] = spaceKpStorm3d.candidates(c, data([[hist as WorldNeed, points]]));
    expect(q?.spec.windowStart.toISOString()).toBe('2026-10-05T03:00:00.000Z');
    expect(q?.spec.windowEnd.toISOString()).toBe('2026-10-08T03:00:00.000Z');
    expect(q?.spec.targetDate).toBe('2026-10-08');
    expect(q?.spec.criteria).toMatchObject({ kind: 'threshold', metric: 'kp', threshold: 5, aggregation: 'max_over_window' });
    expect(q?.inputs.provider).toBeUndefined();
  });

  it('needs most slots reported before judging a window', () => {
    const w = { start: new Date('2026-10-05T00:00:00Z'), end: new Date('2026-10-08T00:00:00Z') };
    expect(
      kpMax(
        slots('2026-10-05T00:00:00Z', 3, () => 4),
        w,
      ),
    ).toBe(4);
    expect(
      kpMax(
        slots('2026-10-05T00:00:00Z', 2, () => 4),
        w,
      ),
    ).toBeUndefined();
  });

  it('combines NOAA’s separate daily categories over the window', () => {
    const f: GeomagForecast = {
      issuedAt: '2026-10-04T22:05:00.000Z',
      days: [
        { date: '2026-10-05', pActive: 0.35, pMinor: 0.35, pModerate: 0.05, pStrong: 0.01, kpMax: 4.67 },
        { date: '2026-10-06', pActive: 0.35, pMinor: 0.2, pModerate: 0.05, pStrong: 0.01, kpMax: 3.67 },
        { date: '2026-10-07', pActive: 0.2, pMinor: 0.05, pModerate: 0.01, pStrong: 0.01, kpMax: 2.67 },
      ],
    };
    const w = { start: new Date('2026-10-05T00:00:00Z'), end: new Date('2026-10-08T00:00:00Z') };
    const r = swpcWindowChance(f, w, 5);
    expect(r?.p).toBeCloseTo(1 - (1 - 0.41) * (1 - 0.26) * (1 - 0.07), 10);
    expect(r?.rationale).toContain('41% on Mon 5 Oct');
    // A window mostly beyond the forecast has no provider probability.
    expect(swpcWindowChance(f, { start: new Date('2026-10-07T00:00:00Z'), end: new Date('2026-10-10T00:00:00Z') }, 5)).toBeUndefined();
  });
});

describe('news.topic_surge', () => {
  it('rotates topics daily and freezes a whole-article threshold above the median', () => {
    const topics = [
      { id: 'b', label: 'B', query: 'b', keywords: ['b'] },
      { id: 'a', label: 'A', query: 'a', keywords: ['a'] },
      { id: 'c', label: 'C', query: null, keywords: ['c'] },
    ];
    expect(topicOfTheDay(ctx({ topics }))?.id).not.toBe(topicOfTheDay(ctx({ topics, today: '2026-10-06' }))?.id);
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(surgeThreshold(2, 40)).toBe(81); // "more than 2 × 40"

    const c = ctx({ topics: [topics[1] as (typeof topics)[number]] });
    const need = newsTopicSurge.needs(c)[0] as Extract<WorldNeed, { kind: 'news.volume' }>;
    expect(need.query).toBe('a sourcelang:english');
    const points = [];
    for (let i = 0, d = need.start; d <= need.end; i++, d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10))
      points.push({ date: d, count: i % 3 ? 40 : 70 });
    const [q] = newsTopicSurge.candidates(c, data([[need, points]]));
    expect(q?.spec.criteria).toMatchObject({
      kind: 'count',
      comparator: '>=',
      window: { start: '2026-10-06T00:00:00+00:00', end: '2026-10-07T00:00:00+00:00', tz: 'UTC' },
    });
    expect(q?.spec.horizonDays).toBe(1);
    // A gap in the series would bias every median after it, so the day is skipped.
    expect(newsTopicSurge.candidates(c, data([[need, points.slice(1)]]))).toEqual([]);
  });
});

describe('world resolvers', () => {
  const window = { start: '2026-10-05T06:30:00+05:30', end: '2026-10-12T00:00:00+05:30', tz: 'Asia/Kolkata' };
  const MISSING = { retryUntilHours: 72, thenOutcome: 'annul' as const };

  it('read a pair of ECB rates, and leave a holiday missing', async () => {
    const c = {
      kind: 'compare' as const,
      source: { id: 'frankfurter', version: '1' },
      missingPolicy: MISSING,
      metric: 'USD/INR',
      a: { at: '2026-10-05' },
      b: { at: '2026-10-09' },
      comparator: '>' as const,
    };
    const fx = (rates: { date: string; rate: number }[]) => ({ dailyRates: async () => snap(rates) });
    const r = await frankfurterResolver(
      fx([
        { date: '2026-10-05', rate: 83 },
        { date: '2026-10-09', rate: 83.2 },
      ]),
    ).observe(c, '2026-10-09');
    expect(r.ok && r.value.parsed).toEqual({ kind: 'pair', a: 83, b: 83.2 });
    if (r.ok && r.value.parsed) expect(evaluate(c, r.value.parsed)).toEqual(ok(1));
    const holiday = await frankfurterResolver(fx([{ date: '2026-10-05', rate: 83 }])).observe(c, '2026-10-09');
    expect(holiday.ok && holiday.value.parsed).toBeNull();
  });

  it('refuse to count releases or incidents the listing no longer reaches', async () => {
    const c = {
      kind: 'count' as const,
      source: { id: 'github.releases', version: '1' },
      missingPolicy: MISSING,
      filter: { repo: 'a/b', includePrereleases: false },
      comparator: '>=' as const,
      threshold: 1,
      window,
    };
    const rel = (publishedAt: string[], complete: boolean) => ({
      releases: async () =>
        snap({ repo: 'a/b', complete, releases: publishedAt.map((p, i) => ({ tag: `v${i}`, name: null, publishedAt: p, prerelease: i === 0, url: '' })) }),
    });
    const counted = await githubReleasesResolver(rel(['2026-10-08T00:00:00Z', '2026-10-07T00:00:00Z', '2026-09-01T00:00:00Z'], false)).observe(c, '2026-10-11');
    expect(counted.ok && counted.value.parsed).toEqual({ kind: 'count', count: 1 }); // the pre-release is excluded
    const blind = await githubReleasesResolver(rel(['2026-10-08T00:00:00Z'], false)).observe(c, '2026-10-11');
    expect(blind.ok && blind.value.parsed).toBeNull();

    const sc = { ...c, source: { id: 'statuspage', version: '1' }, filter: { host: 'www.githubstatus.com', minImpact: 'major' } };
    const incidents = {
      incidents: async () =>
        snap({
          service: 'x',
          pageName: 'GitHub',
          complete: true,
          incidents: [
            { id: '1', name: '', impact: 'critical' as const, createdAt: '2026-10-06T10:00:00Z', url: '' },
            { id: '2', name: '', impact: 'minor' as const, createdAt: '2026-10-06T11:00:00Z', url: '' },
          ],
        }),
    };
    const r = await statuspageResolver(incidents).observe(sc, '2026-10-11');
    expect(r.ok && r.value.parsed).toEqual({ kind: 'count', count: 1 });
  });

  it('take the highest estimated Kp in the window', async () => {
    const c = {
      kind: 'threshold' as const,
      source: { id: 'swpc.kp', version: '1' },
      missingPolicy: MISSING,
      metric: 'kp',
      unit: 'Kp',
      aggregation: 'max_over_window' as const,
      comparator: '>=' as const,
      threshold: 5,
      window: { start: '2026-10-05T03:00:00+00:00', end: '2026-10-08T03:00:00+00:00', tz: 'UTC' },
    };
    const points = Array.from({ length: 30 }, (_, i) => ({
      time: new Date(Date.parse('2026-10-05T00:00:00Z') + i * 3 * 3_600_000).toISOString(),
      kp: i === 0 ? 8 : i === 10 ? 5.33 : 2,
    }));
    const r = await swpcKpResolver({ observedKp: async () => snap(points), geomagForecast: async () => snap({ issuedAt: '', days: [] }) }).observe(
      c,
      '2026-10-08',
    );
    expect(r.ok && r.value.parsed).toEqual({ kind: 'value', value: 5.33 }); // the 00:00 slot is before the window
  });
});

describe('how world questions are judged and shown', () => {
  it('name the dataset and say what is counted', () => {
    const d = describeCriteria({
      kind: 'count',
      source: { id: 'usgs.earthquake', version: '1' },
      missingPolicy: { retryUntilHours: 72, thenOutcome: 'annul' },
      filter: { minMagnitude: 6.5 },
      comparator: '>=',
      threshold: 1,
      window: { start: 'a', end: 'b', tz: 'UTC' },
    });
    expect(d.rule).toContain('earthquakes of magnitude 6.5 or more anywhere in the world');
    expect(d.dataset).toContain('USGS');
  });

  it('format counts, Kp and changes', () => {
    expect(formatObserved(1, 'quakes')).toBe('1 quake');
    expect(formatObserved(3, 'releases')).toBe('3 releases');
    expect(formatObserved(5.333, 'Kp')).toBe('Kp 5.33');
    expect(formatObserved(-0.0412, 'INR change')).toBe('−0.04 INR');
    expect(formatObserved(0.2, 'INR change')).toBe('+0.20 INR');
  });
});
