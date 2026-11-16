import {
  type DailyMetric,
  type DailyObservationPort,
  type DailySeries,
  type DayQuery,
  type EnsembleDay,
  type EnsemblePort,
  type GeocodingPort,
  type GeoPlace,
  type HistoryPort,
  type HistoryQuery,
  type LocationQuery,
  ok,
  type Result,
  type SourceError,
  type SourceSnapshot,
} from '@reckon/core';
import { z } from 'zod';
import { httpGetText } from '../http';
import { hourlyToDailyMax, nums, type OpenMeteoOptions, parse } from './shared';

/** Phase 1 Open-Meteo adapters. Endpoints and limits are recorded in SOURCE.md. */

export interface OpenMeteoPhase1Options extends OpenMeteoOptions {
  readonly ensembleBase?: string;
  readonly archiveBase?: string;
  readonly geocodingBase?: string;
}

const FORECAST_BASE = 'https://api.open-meteo.com/v1/forecast';
const AIR_BASE = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const ENSEMBLE_BASE = 'https://ensemble-api.open-meteo.com/v1/ensemble';
const ARCHIVE_BASE = 'https://archive-api.open-meteo.com/v1/archive';
const GEOCODING_BASE = 'https://geocoding-api.open-meteo.com/v1/search';

/** ECMWF IFS 0.25° ensemble: control + 50 members, 15 days. */
export const ENSEMBLE_MODEL = 'ecmwf_ifs025';
/** The CAMS global air-quality history behind the API starts here (checked 2026-10-05; ADR-0008). */
export const AIR_HISTORY_START = '2022-08-01';
/** A past day's AQI needs most of its hours, or the day counts as missing (and is retried). */
const MIN_AQI_HOURS = 20;

async function get(o: OpenMeteoOptions, url: string, sourceId: string): Promise<Result<string, SourceError>> {
  return httpGetText(url, { sourceId, userAgent: o.userAgent, ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}) });
}

function snapshot<T>(o: OpenMeteoOptions, sourceId: string, url: string, raw: string, parsed: T): SourceSnapshot<T> {
  return { sourceId, fetchedAt: (o.now?.() ?? new Date()).toISOString(), requestUrl: url, raw, parsed };
}

function coords(u: URL, lat: number, lon: number, tz: string): void {
  u.searchParams.set('latitude', lat.toFixed(2));
  u.searchParams.set('longitude', lon.toFixed(2));
  u.searchParams.set('timezone', tz);
}

const EnsembleResponse = z.object({
  daily: z.object({ time: z.array(z.string()) }).catchall(z.union([nums, z.array(z.string())])),
});

export class OpenMeteoEnsembleAdapter implements EnsemblePort {
  static readonly id = 'openmeteo.ensemble';
  constructor(private readonly o: OpenMeteoPhase1Options) {}

  url(q: LocationQuery): string {
    const u = new URL(this.o.ensembleBase ?? ENSEMBLE_BASE);
    coords(u, q.lat, q.lon, q.tz);
    u.searchParams.set('daily', 'precipitation_sum,temperature_2m_max');
    u.searchParams.set('models', ENSEMBLE_MODEL);
    u.searchParams.set('forecast_days', String(q.days));
    return u.toString();
  }

  async dailyMembers(q: LocationQuery): Promise<Result<SourceSnapshot<EnsembleDay[]>, SourceError>> {
    const id = OpenMeteoEnsembleAdapter.id;
    const url = this.url(q);
    const raw = await get(this.o, url, id);
    if (!raw.ok) return raw;
    const parsed = parse(EnsembleResponse, raw.value, id);
    if (!parsed.ok) return parsed;
    const daily = parsed.value.daily as Record<string, readonly (number | null | string)[]>;
    // The control run is `<var>`; perturbed members are `<var>_memberNN`. All count as members.
    const columns = (variable: string) => Object.keys(daily).filter((k) => k === variable || k.startsWith(`${variable}_member`));
    const precipCols = columns('precipitation_sum');
    const tempCols = columns('temperature_2m_max');
    if (precipCols.length === 0 || tempCols.length === 0)
      return { ok: false, error: { code: 'schema_changed', sourceId: id, detail: 'no ensemble member columns' } };
    const pick = (cols: string[], i: number) => cols.map((c) => daily[c]?.[i]).filter((v): v is number => typeof v === 'number');
    const days = parsed.value.daily.time.map((date, i) => ({ date, precipSumMm: pick(precipCols, i), tempMaxC: pick(tempCols, i) }));
    return ok(snapshot(this.o, id, url, raw.value, days));
  }
}

const DailyResponse = z.object({ daily: z.object({ time: z.array(z.string()) }).catchall(nums) });
const HourlyAqiResponse = z.object({ hourly: z.object({ time: z.array(z.string()), us_aqi: nums }) });

/**
 * Long daily history for climatology: ERA5 via the archive API for weather, and the CAMS air
 * quality history (hourly, reduced to a daily maximum) for US AQI.
 */
export class OpenMeteoHistoryAdapter implements HistoryPort {
  static readonly archiveId = 'openmeteo.archive';
  static readonly airId = 'openmeteo.air_quality';
  constructor(private readonly o: OpenMeteoPhase1Options) {}

  url(q: HistoryQuery, metric: DailyMetric): string {
    if (metric === 'us_aqi') {
      const u = new URL(this.o.airBase ?? AIR_BASE);
      coords(u, q.lat, q.lon, q.tz);
      u.searchParams.set('hourly', 'us_aqi');
      u.searchParams.set('start_date', q.start < AIR_HISTORY_START ? AIR_HISTORY_START : q.start);
      u.searchParams.set('end_date', q.end);
      return u.toString();
    }
    const u = new URL(this.o.archiveBase ?? ARCHIVE_BASE);
    coords(u, q.lat, q.lon, q.tz);
    u.searchParams.set('daily', metric);
    u.searchParams.set('start_date', q.start);
    u.searchParams.set('end_date', q.end);
    return u.toString();
  }

  async dailyHistory(q: HistoryQuery, metric: DailyMetric): Promise<Result<SourceSnapshot<DailySeries>, SourceError>> {
    const id = metric === 'us_aqi' ? OpenMeteoHistoryAdapter.airId : OpenMeteoHistoryAdapter.archiveId;
    const url = this.url(q, metric);
    const raw = await get(this.o, url, id);
    if (!raw.ok) return raw;
    if (metric === 'us_aqi') {
      const parsed = parse(HourlyAqiResponse, raw.value, id);
      if (!parsed.ok) return parsed;
      const days = hourlyToDailyMax(parsed.value.hourly.time, parsed.value.hourly.us_aqi);
      // Leading days before the dataset begins are all null; trim them so the series starts with data.
      const first = days.findIndex(([, v]) => v != null);
      const kept = first < 0 ? [] : days.slice(first);
      return ok(snapshot(this.o, id, url, raw.value, { start: kept[0]?.[0] ?? q.start, values: kept.map(([, v]) => v) }));
    }
    const parsed = parse(DailyResponse, raw.value, id);
    if (!parsed.ok) return parsed;
    const values = parsed.value.daily[metric];
    if (!Array.isArray(values)) return { ok: false, error: { code: 'schema_changed', sourceId: id, detail: `missing daily.${metric}` } };
    return ok(snapshot(this.o, id, url, raw.value, { start: parsed.value.daily.time[0] ?? q.start, values }));
  }
}

/**
 * Resolution reads: what the declared dataset reports for one past local day. Weather uses the
 * forecast API's past-day values (start_date = end_date = the day); air uses the CAMS hourly
 * series reduced to the day's maximum.
 */
export class OpenMeteoPastDayAdapter implements DailyObservationPort {
  constructor(private readonly o: OpenMeteoPhase1Options) {}

  url(q: DayQuery): string {
    const u = new URL(q.metric === 'us_aqi' ? (this.o.airBase ?? AIR_BASE) : (this.o.forecastBase ?? FORECAST_BASE));
    coords(u, q.lat, q.lon, q.tz);
    if (q.metric === 'us_aqi') u.searchParams.set('hourly', 'us_aqi');
    else u.searchParams.set('daily', q.metric);
    u.searchParams.set('start_date', q.date);
    u.searchParams.set('end_date', q.date);
    return u.toString();
  }

  async observeDay(q: DayQuery): Promise<Result<SourceSnapshot<{ value: number | null }>, SourceError>> {
    const id = q.metric === 'us_aqi' ? 'openmeteo.air_quality' : 'openmeteo.forecast';
    const url = this.url(q);
    const raw = await get(this.o, url, id);
    if (!raw.ok) return raw;
    if (q.metric === 'us_aqi') {
      const parsed = parse(HourlyAqiResponse, raw.value, id);
      if (!parsed.ok) return parsed;
      const hours = parsed.value.hourly.us_aqi.filter((v): v is number => v != null);
      const value = hours.length >= MIN_AQI_HOURS ? Math.max(...hours) : null;
      return ok(snapshot(this.o, id, url, raw.value, { value }));
    }
    const parsed = parse(DailyResponse, raw.value, id);
    if (!parsed.ok) return parsed;
    const i = parsed.value.daily.time.indexOf(q.date);
    const value = i >= 0 ? (parsed.value.daily[q.metric]?.[i] ?? null) : null;
    return ok(snapshot(this.o, id, url, raw.value, { value }));
  }
}

const GeocodingResponse = z.object({
  results: z
    .array(
      z.object({
        name: z.string(),
        latitude: z.number(),
        longitude: z.number(),
        timezone: z.string().optional(),
        country: z.string().optional(),
        admin1: z.string().optional(),
      }),
    )
    .optional(),
});

export class OpenMeteoGeocodingAdapter implements GeocodingPort {
  static readonly id = 'openmeteo.geocoding';
  constructor(private readonly o: OpenMeteoPhase1Options) {}

  async search(name: string): Promise<Result<GeoPlace[], SourceError>> {
    const u = new URL(this.o.geocodingBase ?? GEOCODING_BASE);
    u.searchParams.set('name', name);
    u.searchParams.set('count', '6');
    u.searchParams.set('language', 'en');
    u.searchParams.set('format', 'json');
    const raw = await get(this.o, u.toString(), OpenMeteoGeocodingAdapter.id);
    if (!raw.ok) return raw;
    const parsed = parse(GeocodingResponse, raw.value, OpenMeteoGeocodingAdapter.id);
    if (!parsed.ok) return parsed;
    return ok(
      (parsed.value.results ?? [])
        .filter((r) => r.timezone)
        .map((r) => ({ name: r.name, region: r.admin1 ?? '', country: r.country ?? '', lat: r.latitude, lon: r.longitude, tz: r.timezone as string })),
    );
  }
}
