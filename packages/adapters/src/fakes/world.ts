import {
  addDays,
  type FeedPort,
  type FeedRef,
  type FxPort,
  type FxRate,
  type GeomagForecast,
  type HackerNewsPort,
  type Incident,
  type IncidentImpact,
  type KpHistoryPort,
  type KpPoint,
  type NewsSearchPort,
  type NewsVolumePort,
  ok,
  type PushError,
  type PushPayload,
  type PushSender,
  type PushSubscription,
  type Quake,
  type QuakePort,
  type RawNewsItem,
  type Release,
  type ReleasePort,
  type Result,
  type SourceError,
  type SourceSnapshot,
  type SpaceWeatherPort,
  type StatusPagePort,
} from '@reckon/core';

/**
 * Deterministic fake world sources for tests and the E2E stack (fake clock). Like FakeOpenMeteo,
 * every value is a pure function of its date or slot, so history, forecasts and resolutions
 * agree; rates are tuned so each world template finds a rung near 50% and asks its question.
 */

export type FakeWorldSource = 'fx' | 'quakes' | 'kp' | 'space' | 'releases' | 'status' | 'volume' | 'search' | 'feeds' | 'hn';

/** FNV-1a plus a murmur3 finaliser, so inputs differing only in their last characters still spread evenly. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const DAY = 86_400_000;
const SLOT = 3 * 3_600_000;
const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);
const isWeekday = (date: string) => {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay();
  return d >= 1 && d <= 5;
};

export function fakeFxRate(date: string): number {
  const n = Date.parse(`${date}T00:00:00Z`) / DAY;
  return Math.round((83 + 1.5 * Math.sin(n / 45) + (hash(`fx:${date}`) - 0.5) * 0.8) * 10000) / 10000;
}

/** At most one quake a day: one day in five, magnitude 6.0–7.1. */
export function fakeQuake(date: string): Quake | null {
  if (hash(`q:${date}`) >= 0.2) return null;
  const magnitude = Math.round((6 + hash(`qm:${date}`) * 1.2) * 10) / 10;
  const time = new Date(Date.parse(`${date}T00:00:00Z`) + Math.floor(hash(`qt:${date}`) * DAY)).toISOString();
  return { id: `fake${date.replaceAll('-', '')}`, time, magnitude, place: 'Fake Trench', url: `https://earthquake.example/${date}` };
}

/** Kp per 3-hour slot: quiet, with an active or stormy day now and then. */
export function fakeKp(slotStart: number): number {
  const day = dayOf(slotStart);
  const storm = hash(`kpd:${day}`);
  const peak = storm < 0.1 ? 6 : storm < 0.2 ? 5 : storm < 0.35 ? 4 : 2.67;
  const shape = hash(`kps:${slotStart}`);
  return Math.round(Math.min(9, Math.max(0, peak - (shape > 0.7 ? 0 : 1 + shape * 2))) * 100) / 100;
}

const slotsBetween = (start: number, end: number) => {
  const out: number[] = [];
  for (let t = Math.ceil(start / SLOT) * SLOT; t <= end; t += SLOT) out.push(t);
  return out;
};

export function fakeRelease(repo: string, date: string): Release | null {
  if (hash(`rel:${repo}:${date}`) >= 0.1) return null;
  const at = new Date(Date.parse(`${date}T00:00:00Z`) + Math.floor(hash(`relt:${repo}:${date}`) * DAY)).toISOString();
  return {
    tag: `v${date.replaceAll('-', '.')}`,
    name: null,
    publishedAt: at,
    prerelease: hash(`relp:${repo}:${date}`) < 0.2,
    url: `https://github.com/${repo}/releases`,
  };
}

const IMPACTS: readonly IncidentImpact[] = ['none', 'minor', 'minor', 'major', 'critical'];

export function fakeIncident(host: string, date: string): Incident | null {
  if (hash(`inc:${host}:${date}`) >= 0.15) return null;
  const impact = IMPACTS[Math.floor(hash(`inci:${host}:${date}`) * IMPACTS.length)] ?? 'minor';
  const createdAt = new Date(Date.parse(`${date}T00:00:00Z`) + Math.floor(hash(`inct:${host}:${date}`) * DAY)).toISOString();
  return { id: `${host}-${date}`, name: 'Degraded performance', impact, createdAt, url: `https://${host}/incidents/${date}` };
}

export function fakeVolume(query: string, date: string): number {
  const n = Date.parse(`${date}T00:00:00Z`) / DAY;
  return Math.round(60 + 15 * Math.sin(n / 9) + hash(`vol:${query}:${date}`) * 40);
}

export class FakeWorld {
  /** Sources listed here fail with `upstream_5xx` until removed. */
  readonly failing = new Set<FakeWorldSource>();
  calls: { source: FakeWorldSource; detail: string }[] = [];
  /** Extra headlines the next feed fetch returns (tests). */
  headlines: RawNewsItem[] = [];

  constructor(private readonly clock: { now(): Date }) {}

  private snap<T>(sourceId: string, parsed: T, url: string, contentType?: string): Result<SourceSnapshot<T>, SourceError> {
    return ok({
      sourceId,
      fetchedAt: this.clock.now().toISOString(),
      requestUrl: url,
      raw: JSON.stringify(parsed),
      parsed,
      ...(contentType ? { contentType } : {}),
    });
  }

  private fail(name: FakeWorldSource, sourceId: string, detail: string): Result<never, SourceError> | null {
    this.calls.push({ source: name, detail });
    return this.failing.has(name) ? { ok: false, error: { code: 'upstream_5xx', sourceId, detail: 'fake failure' } } : null;
  }

  private now() {
    return this.clock.now().getTime();
  }

  readonly fx: FxPort = {
    dailyRates: async (q) => {
      const f = this.fail('fx', 'frankfurter', `${q.start}..${q.end}`);
      if (f) return f;
      const out: FxRate[] = [];
      // ECB publishes around 16:00 CET: a day's rate exists only after 15:00 UTC.
      for (let d = q.start; d <= q.end; d = addDays(d, 1))
        if (isWeekday(d) && Date.parse(`${d}T15:00:00Z`) <= this.now()) out.push({ date: d, rate: fakeFxRate(d) });
      return this.snap('frankfurter', out, `https://fake.frankfurter/${q.start}..${q.end}`);
    },
  };

  readonly quakes: QuakePort = {
    events: async (q) => {
      const f = this.fail('quakes', 'usgs.earthquake', `${q.start}..${q.end}`);
      if (f) return f;
      const end = Math.min(Date.parse(q.end), this.now());
      const out: Quake[] = [];
      for (let d = dayOf(Date.parse(q.start)); Date.parse(`${d}T00:00:00Z`) < end; d = addDays(d, 1)) {
        const e = fakeQuake(d);
        if (e && e.magnitude >= q.minMagnitude && Date.parse(e.time) >= Date.parse(q.start) && Date.parse(e.time) < end) out.push(e);
      }
      return this.snap('usgs.earthquake', out, `https://fake.usgs/query?minmagnitude=${q.minMagnitude}`);
    },
  };

  readonly kpHistory: KpHistoryPort = {
    kpHistory: async (q) => {
      const f = this.fail('kp', 'gfz.kp', `${q.start}..${q.end}`);
      if (f) return f;
      // GFZ lags real time by about a day.
      const end = Math.min(Date.parse(q.end), this.now() - DAY);
      const out: KpPoint[] = slotsBetween(Date.parse(q.start), end).map((t) => ({ time: new Date(t).toISOString(), kp: fakeKp(t) }));
      return this.snap('gfz.kp', out, 'https://fake.gfz/kp');
    },
  };

  readonly space: SpaceWeatherPort = {
    observedKp: async () => {
      const f = this.fail('space', 'swpc.kp', 'observed');
      if (f) return f;
      const out = slotsBetween(this.now() - 7 * DAY, this.now() - SLOT).map((t) => ({ time: new Date(t).toISOString(), kp: fakeKp(t) }));
      return this.snap('swpc.kp', out, 'https://fake.swpc/kp');
    },
    geomagForecast: async () => {
      const f = this.fail('space', 'swpc.geomag_forecast', 'forecast');
      if (f) return f;
      const today = dayOf(this.now());
      const days = [0, 1, 2].map((i) => {
        const date = addDays(today, i);
        const peak = Math.max(...slotsBetween(Date.parse(`${date}T00:00:00Z`), Date.parse(`${date}T21:00:00Z`)).map(fakeKp));
        const noise = hash(`gf:${date}`) * 0.2;
        return {
          date,
          pActive: peak >= 4 ? 0.3 : 0.15 + noise,
          pMinor: peak >= 5 ? 0.35 + noise : 0.05 + noise / 2,
          pModerate: peak >= 6 ? 0.2 : 0.01,
          pStrong: 0.01,
          kpMax: peak,
        };
      });
      const forecast: GeomagForecast = { issuedAt: `${today}T00:30:00.000Z`, days };
      return this.snap('swpc.geomag_forecast', forecast, 'https://fake.swpc/3-day-geomag-forecast.txt', 'text/plain');
    },
  };

  readonly releases: ReleasePort = {
    releases: async (repo) => {
      const f = this.fail('releases', 'github.releases', repo);
      if (f) return f;
      const out: Release[] = [];
      for (let d = dayOf(this.now()); out.length < 100 && d >= dayOf(this.now() - 450 * DAY); d = addDays(d, -1)) {
        const r = fakeRelease(repo, d);
        if (r && Date.parse(r.publishedAt) <= this.now()) out.push(r);
      }
      return this.snap('github.releases', { repo, releases: out, complete: out.length < 100 }, `https://fake.github/repos/${repo}/releases`);
    },
  };

  readonly status: StatusPagePort = {
    incidents: async (host) => {
      const f = this.fail('status', 'statuspage', host);
      if (f) return f;
      const out: Incident[] = [];
      for (let d = dayOf(this.now()); out.length < 50 && d >= dayOf(this.now() - 450 * DAY); d = addDays(d, -1)) {
        const i = fakeIncident(host, d);
        if (i && Date.parse(i.createdAt) <= this.now()) out.push(i);
      }
      return this.snap(
        'statuspage',
        { service: host, pageName: host.split('.').at(-2) ?? host, incidents: out, complete: out.length < 50 },
        `https://${host}/api/v2/incidents.json`,
      );
    },
  };

  readonly newsVolume: NewsVolumePort = {
    dailyVolume: async (q) => {
      const f = this.fail('volume', 'gdelt.doc', q.query);
      if (f) return f;
      const out = [];
      // A UTC day's count exists once the day is over.
      for (let d = q.start; d <= q.end && Date.parse(`${addDays(d, 1)}T00:00:00Z`) <= this.now(); d = addDays(d, 1))
        out.push({ date: d, count: fakeVolume(q.query, d) });
      return this.snap('gdelt.doc', out, `https://fake.gdelt/timelinevolraw?query=${encodeURIComponent(q.query)}`);
    },
  };

  readonly newsSearch: NewsSearchPort = {
    articles: async (q) => {
      const f = this.fail('search', 'gdelt.doc', q.query);
      if (f) return f;
      const at = new Date(this.now() - 2 * 3_600_000).toISOString();
      const words = q.query.replace(/sourcelang:\w+|[()"]/g, ' ').trim();
      const items: RawNewsItem[] = [
        {
          url: `https://news.example/${encodeURIComponent(words)}/${dayOf(this.now())}`,
          title: `Latest on ${words}`,
          source: 'news.example',
          publishedAt: at,
          snippet: null,
          lang: 'English',
          origin: 'gdelt',
        },
      ];
      return this.snap('gdelt.doc', items, 'https://fake.gdelt/artlist');
    },
  };

  readonly feeds: FeedPort = {
    fetchFeed: async (feed: FeedRef) => {
      const f = this.fail('feeds', 'rss', feed.id);
      if (f) return f;
      const day = dayOf(this.now());
      const at = new Date(this.now() - 3_600_000).toISOString();
      const base: RawNewsItem[] = [
        { title: 'Strong earthquake shakes coastal towns', snippet: 'A magnitude 6.6 quake struck offshore.' },
        { title: 'Geomagnetic storm could bring auroras tonight', snippet: 'Forecasters expect a G1 storm.' },
        { title: 'GitHub outage disrupts pull requests', snippet: 'GitHub said Actions and pull requests were degraded.' },
        { title: 'Node.js release brings faster startup', snippet: 'The new Node.js version ships today.' },
        { title: 'Rupee slips against the dollar', snippet: 'The rupee weakened as oil prices rose.' },
      ].map((x, i) => ({ url: `https://${feed.id}.example/${day}/${i}`, source: feed.name, publishedAt: at, lang: 'en', origin: 'rss' as const, ...x }));
      const items = [...base, ...this.headlines];
      return ok({
        notModified: false,
        snapshot: {
          sourceId: 'rss',
          fetchedAt: this.clock.now().toISOString(),
          requestUrl: feed.url,
          raw: '<rss/>',
          parsed: items,
          contentType: 'application/rss+xml',
        },
        etag: `"${day}"`,
        lastModified: null,
      });
    },
  };

  readonly hackerNews: HackerNewsPort = {
    frontPage: async () => {
      const f = this.fail('hn', 'hackernews', 'front');
      if (f) return f;
      const at = new Date(this.now() - 1_800_000).toISOString();
      return this.snap(
        'hackernews',
        [
          {
            url: `https://blog.example/vite-${dayOf(this.now())}`,
            title: 'Vite release notes: what changed',
            source: 'blog.example',
            publishedAt: at,
            snippet: null,
            lang: null,
            origin: 'hn' as const,
          },
        ],
        'https://fake.hn/front',
      );
    },
  };
}

/** A push service that records what it would have delivered. */
export class FakePushSender implements PushSender {
  readonly publicKey = 'BFakeVapidPublicKeyForTestsOnly';
  sent: { endpoint: string; payload: PushPayload }[] = [];
  gone = new Set<string>();
  async send(s: PushSubscription, payload: PushPayload): Promise<Result<void, PushError>> {
    if (this.gone.has(s.endpoint)) return { ok: false, error: { code: 'gone' } };
    this.sent.push({ endpoint: s.endpoint, payload });
    return ok(undefined);
  }
}
