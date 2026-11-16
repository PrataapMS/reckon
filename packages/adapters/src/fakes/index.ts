import {
  type AirQualityPort,
  addDays,
  type DailyAirQuality,
  type DailyMetric,
  type DailyObservationPort,
  type DailySeries,
  type DailyWeather,
  type DayQuery,
  type EnsembleDay,
  type EnsemblePort,
  type GeocodingPort,
  type HistoryPort,
  type HistoryQuery,
  type LocationQuery,
  localDate,
  ok,
  type Result,
  type SourceError,
  type SourceSnapshot,
  seededRng,
  type WeatherPort,
} from '@reckon/core';

/**
 * Deterministic fake Open-Meteo for tests and the E2E stack (fake clock). "Truth" for any date
 * is a pure function of the date, so climatology, forecasts and resolutions agree with each
 * other; forecasts add horizon-dependent noise so forecasters are not trivially perfect.
 */

export type FakeSourceName = 'weather' | 'air' | 'ensemble' | 'history' | 'observations';

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

/** The value the fake world "observes" for a local date. */
export function fakeTruth(metric: DailyMetric, date: string): number {
  const v = hash(`${metric}:${date}`);
  const season = Math.sin(((Number(date.slice(5, 7)) - 1) / 12) * 2 * Math.PI);
  switch (metric) {
    case 'precipitation_sum':
      return v < 0.45 ? 0 : Math.round((v - 0.45) * 30 * 10) / 10;
    case 'temperature_2m_max':
      return Math.round((29 + 3 * season + (v - 0.5) * 6) * 10) / 10;
    case 'us_aqi':
      return Math.round(70 + 40 * season + v * 110);
  }
}

function noisy(metric: DailyMetric, date: string, horizon: number, salt = ''): number {
  const n = (hash(`noise:${metric}:${date}:${horizon}:${salt}`) - 0.5) * (1 + horizon);
  const truth = fakeTruth(metric, date);
  const scale = metric === 'precipitation_sum' ? 2 : metric === 'temperature_2m_max' ? 0.8 : 12;
  return Math.max(0, Math.round((truth + n * scale) * 10) / 10);
}

export class FakeOpenMeteo {
  /** Sources listed here fail with `upstream_5xx` until removed. */
  readonly failing = new Set<FakeSourceName>();
  calls: { source: FakeSourceName; detail: string }[] = [];

  constructor(private readonly clock: { now(): Date }) {}

  private snap<T>(sourceId: string, parsed: T, url: string): Result<SourceSnapshot<T>, SourceError> {
    return ok({ sourceId, fetchedAt: this.clock.now().toISOString(), requestUrl: url, raw: JSON.stringify(parsed), parsed });
  }

  private fail(name: FakeSourceName, sourceId: string): Result<never, SourceError> | null {
    return this.failing.has(name) ? { ok: false, error: { code: 'upstream_5xx', sourceId, detail: 'fake failure' } } : null;
  }

  private days(q: LocationQuery): string[] {
    const today = localDate(this.clock.now(), q.tz);
    const out: string[] = [];
    for (let i = -(q.pastDays ?? 0); i < q.days; i++) out.push(addDays(today, i));
    return out;
  }

  readonly weather: WeatherPort = {
    dailyForecast: async (q) => {
      this.calls.push({ source: 'weather', detail: `${q.days}` });
      const f = this.fail('weather', 'openmeteo.forecast');
      if (f) return f;
      const today = localDate(this.clock.now(), q.tz);
      const days: DailyWeather[] = this.days(q).map((date) => {
        const h = Math.max(0, Math.round((Date.parse(date) - Date.parse(today)) / 86_400_000));
        const rain = noisy('precipitation_sum', date, h);
        return {
          date,
          precipProbabilityMax: Math.min(100, Math.round(rain > 0 ? 55 + rain * 4 : 15 + hash(`pp:${date}`) * 25)),
          precipSumMm: rain,
          tempMaxC: noisy('temperature_2m_max', date, h),
        };
      });
      return this.snap('openmeteo.forecast', days, `https://fake.open-meteo/forecast?lat=${q.lat}&lon=${q.lon}`);
    },
  };

  readonly air: AirQualityPort = {
    dailyForecast: async (q) => {
      this.calls.push({ source: 'air', detail: `${q.days}` });
      const f = this.fail('air', 'openmeteo.air_quality');
      if (f) return f;
      const today = localDate(this.clock.now(), q.tz);
      const days: DailyAirQuality[] = this.days(q).map((date) => ({
        date,
        usAqiMax: noisy('us_aqi', date, Math.max(0, Math.round((Date.parse(date) - Date.parse(today)) / 86_400_000))),
      }));
      return this.snap('openmeteo.air_quality', days, `https://fake.open-meteo/air?lat=${q.lat}&lon=${q.lon}`);
    },
  };

  readonly ensemble: EnsemblePort = {
    dailyMembers: async (q) => {
      this.calls.push({ source: 'ensemble', detail: `${q.days}` });
      const f = this.fail('ensemble', 'openmeteo.ensemble');
      if (f) return f;
      const today = localDate(this.clock.now(), q.tz);
      const days: EnsembleDay[] = this.days(q).map((date) => {
        const h = Math.max(0, Math.round((Date.parse(date) - Date.parse(today)) / 86_400_000));
        const rng = seededRng(Math.floor(hash(`ens:${date}`) * 1e9));
        const members = (metric: DailyMetric, spread: number) =>
          Array.from({ length: 51 }, () => Math.max(0, Math.round((noisy(metric, date, h) + (rng.next() - 0.5) * spread * (1 + h / 3)) * 10) / 10));
        return { date, precipSumMm: members('precipitation_sum', 6), tempMaxC: members('temperature_2m_max', 2.5) };
      });
      return this.snap('openmeteo.ensemble', days, `https://fake.open-meteo/ensemble?lat=${q.lat}&lon=${q.lon}`);
    },
  };

  readonly history: HistoryPort = {
    dailyHistory: async (q: HistoryQuery, metric: DailyMetric) => {
      this.calls.push({ source: 'history', detail: metric });
      const sourceId = metric === 'us_aqi' ? 'openmeteo.air_quality' : 'openmeteo.archive';
      const f = this.fail('history', sourceId);
      if (f) return f;
      const start = metric === 'us_aqi' && q.start < '2022-08-01' ? '2022-08-01' : q.start;
      const values: number[] = [];
      for (let d = start; d <= q.end; d = addDays(d, 1)) values.push(fakeTruth(metric, d));
      const series: DailySeries = { start, values };
      return this.snap(sourceId, series, `https://fake.open-meteo/history/${metric}`);
    },
  };

  readonly observations: DailyObservationPort = {
    observeDay: async (q: DayQuery) => {
      this.calls.push({ source: 'observations', detail: `${q.metric}:${q.date}` });
      const sourceId = q.metric === 'us_aqi' ? 'openmeteo.air_quality' : 'openmeteo.forecast';
      const f = this.fail('observations', sourceId);
      if (f) return f;
      return this.snap(sourceId, { value: fakeTruth(q.metric, q.date) }, `https://fake.open-meteo/day/${q.metric}/${q.date}`);
    },
  };

  readonly geocoding: GeocodingPort = {
    search: async (name: string) =>
      ok(
        [
          { name: 'Bengaluru', region: 'Karnataka', country: 'India', lat: 12.97, lon: 77.59, tz: 'Asia/Kolkata' },
          { name: 'Delhi', region: 'Delhi', country: 'India', lat: 28.61, lon: 77.21, tz: 'Asia/Kolkata' },
          { name: 'London', region: 'England', country: 'United Kingdom', lat: 51.51, lon: -0.13, tz: 'Europe/London' },
        ].filter((p) => p.name.toLowerCase().startsWith(name.toLowerCase().slice(0, 3))),
      ),
  };
}

/** A messenger that records what it would have sent. */
export class FakeMessenger {
  readonly channel = 'telegram' as const;
  sent: { chatId: string; text: string; buttons?: readonly { text: string; url: string }[] }[] = [];
  blocked = new Set<string>();
  async send(chatId: string, msg: { text: string; buttons?: readonly { text: string; url: string }[] }) {
    if (this.blocked.has(chatId)) return { ok: false as const, error: { code: 'blocked' as const } };
    this.sent.push({ chatId, ...msg });
    return { ok: true as const, value: undefined };
  }
}
export * from './world';
