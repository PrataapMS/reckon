import {
  err,
  type GeomagDay,
  type GeomagForecast,
  type KpPoint,
  ok,
  type Result,
  type SourceError,
  type SourceSnapshot,
  type SpaceWeatherPort,
} from '@reckon/core';
import { z } from 'zod';
import { type FetchLike, httpGetText } from '../http';
import { parse } from '../parse';

/** NOAA SWPC data service (public domain). Endpoints, terms and quirks are in SOURCE.md. */

export interface SwpcOptions {
  readonly userAgent: string;
  readonly fetchImpl?: FetchLike;
  readonly now?: () => Date;
  /** Service root (default https://services.swpc.noaa.gov); product paths are appended. */
  readonly base?: string;
}

const BASE = 'https://services.swpc.noaa.gov';
const KP_PATH = '/products/noaa-planetary-k-index.json';
const FORECAST_PATH = '/text/3-day-geomag-forecast.txt';

const KpObjects = z.array(z.object({ time_tag: z.string(), Kp: z.number().nullable() }));
/** The pre-2025 product: a header row, then rows of strings. */
const KpTable = z.array(z.array(z.union([z.string(), z.number(), z.null()]))).min(1);

/** SWPC time tags are UTC without a zone ('2026-09-28T00:00:00', or '2026-09-28 00:00:00.000' in the old table). */
function utcInstant(tag: string): string | null {
  const iso = tag.trim().replace(' ', 'T');
  const ms = Date.parse(/(Z|[+-]\d\d:?\d\d)$/i.test(iso) ? iso : `${iso}Z`);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

type KpPayload = z.infer<typeof KpObjects> | z.infer<typeof KpTable>;
const isTable = (d: KpPayload): d is z.infer<typeof KpTable> => Array.isArray(d[0]);

function kpRows(data: KpPayload): { tag: string; kp: number | null }[] | string {
  if (!isTable(data)) return data.map((r) => ({ tag: r.time_tag, kp: r.Kp }));
  const [header = [], ...rows] = data;
  const ti = header.indexOf('time_tag');
  const ki = header.indexOf('Kp');
  if (ti < 0 || ki < 0) return 'legacy table header lacks time_tag or Kp';
  return rows.map((r) => {
    const v = r[ki];
    return { tag: String(r[ti] ?? ''), kp: v === null || v === undefined || v === '' ? null : Number(v) };
  });
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'Oct 05' has no year: take the one that puts it nearest the issue time (so Dec issues roll into Jan). */
function resolveDay(issued: number, mon: string, day: number): string | null {
  const m = MONTHS.indexOf(mon);
  if (m < 0) return null;
  const year = new Date(issued).getUTCFullYear();
  const candidates = [year - 1, year, year + 1].map((y) => Date.UTC(y, m, day));
  const best = candidates.reduce((a, b) => (Math.abs(b - issued) < Math.abs(a - issued) ? b : a));
  const d = new Date(best);
  return d.getUTCDate() === day ? d.toISOString().slice(0, 10) : null;
}

const PROBABILITY_ROWS = { pActive: 'Active', pMinor: 'Minor storm', pModerate: 'Moderate storm', pStrong: 'Strong-Extreme storm' } as const;
type ProbabilityKey = keyof typeof PROBABILITY_ROWS;

/** Parses the 3-day geomagnetic forecast text product; a string result is the schema_changed detail. */
export function parseGeomagForecast(text: string): GeomagForecast | string {
  const issued = /^:Issued:\s+(\d{4})\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2})(\d{2})\s+UTC/m.exec(text);
  if (!issued) return 'no :Issued: line';
  const [, y, mon, d, hh, mm] = issued;
  const month = MONTHS.indexOf(mon ?? '');
  if (month < 0) return `bad issue month ${mon}`;
  const issuedMs = Date.UTC(Number(y), month, Number(d), Number(hh), Number(mm));

  const header = /^NOAA Geomagnetic Activity Probabilities\s+(\d{1,2})\s+([A-Z][a-z]{2})\b/m.exec(text);
  if (!header) return 'no probabilities header';
  const first = resolveDay(issuedMs, header[2] ?? '', Number(header[1]));
  if (first === null) return `bad first day ${header[1]} ${header[2]}`;
  const dates = [0, 1, 2].map((i) => new Date(Date.parse(first) + i * 86_400_000).toISOString().slice(0, 10));

  const probs = {} as Record<ProbabilityKey, number[]>;
  for (const [key, label] of Object.entries(PROBABILITY_ROWS) as [ProbabilityKey, string][]) {
    const row = new RegExp(`^${label}\\s+(\\d{1,3})/(\\d{1,3})/(\\d{1,3})\\s*$`, 'm').exec(text);
    if (!row) return `no "${label}" probability row`;
    const pcts = row.slice(1, 4).map(Number);
    if (pcts.some((p) => p > 100)) return `"${label}" probability over 100%`;
    probs[key] = pcts.map((p) => p / 100);
  }

  const kpMax = parseKpTable(text, issuedMs);
  if (typeof kpMax === 'string') return kpMax;

  const days: GeomagDay[] = dates.map((date, i) => ({
    date,
    pActive: probs.pActive[i] ?? 0,
    pMinor: probs.pMinor[i] ?? 0,
    pModerate: probs.pModerate[i] ?? 0,
    pStrong: probs.pStrong[i] ?? 0,
    kpMax: kpMax.get(date) ?? null,
  }));
  return { issuedAt: new Date(issuedMs).toISOString(), days };
}

/** Max Kp per date from the 3-hourly table; empty if the product omits the table. */
function parseKpTable(text: string, issuedMs: number): Map<string, number> | string {
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => /^NOAA Kp index forecast/.test(l));
  const out = new Map<string, number>();
  if (at < 0) return out;
  const columns = [...(lines[at + 1] ?? '').matchAll(/([A-Z][a-z]{2})\s+(\d{1,2})/g)].map((m) => resolveDay(issuedMs, m[1] ?? '', Number(m[2])));
  if (columns.length === 0 || columns.some((c) => c === null)) return 'unreadable Kp table header';
  for (const line of lines.slice(at + 2)) {
    if (out.size === 0 && line.trim() === '') continue;
    if (!/^\d{2}-\d{2}UT/.test(line)) break;
    // Storm slots carry a NOAA scale tag, e.g. '5.33 (G1)'.
    const values = line
      .replace(/\(G\d\)/g, '')
      .trim()
      .split(/\s+/)
      .slice(1)
      .map(Number);
    if (values.length !== columns.length || values.some((v) => Number.isNaN(v))) return `unreadable Kp row "${line.trim()}"`;
    values.forEach((v, i) => {
      const date = columns[i];
      if (date) out.set(date, Math.max(out.get(date) ?? v, v));
    });
  }
  if (out.size === 0) return 'Kp table has no rows';
  return out;
}

export class SwpcSpaceWeatherAdapter implements SpaceWeatherPort {
  static readonly kpId = 'swpc.kp';
  static readonly forecastId = 'swpc.geomag_forecast';
  constructor(private readonly o: SwpcOptions) {}

  private url(path: string): string {
    return `${(this.o.base ?? BASE).replace(/\/+$/, '')}${path}`;
  }

  private get(url: string, sourceId: string, accept?: string): Promise<Result<string, SourceError>> {
    return httpGetText(url, {
      sourceId,
      userAgent: this.o.userAgent,
      ...(accept ? { accept } : {}),
      ...(this.o.fetchImpl ? { fetchImpl: this.o.fetchImpl } : {}),
    });
  }

  private fetchedAt(): string {
    return (this.o.now?.() ?? new Date()).toISOString();
  }

  async observedKp(): Promise<Result<SourceSnapshot<KpPoint[]>, SourceError>> {
    const id = SwpcSpaceWeatherAdapter.kpId;
    const url = this.url(KP_PATH);
    const raw = await this.get(url, id);
    if (!raw.ok) return raw;
    const parsed = parse(z.union([KpObjects, KpTable]), raw.value, id);
    if (!parsed.ok) return parsed;
    const rows = kpRows(parsed.value);
    if (typeof rows === 'string') return err({ code: 'schema_changed', sourceId: id, detail: rows });
    const points: KpPoint[] = [];
    for (const r of rows) {
      const time = utcInstant(r.tag);
      if (time === null || (r.kp !== null && Number.isNaN(r.kp))) return err({ code: 'schema_changed', sourceId: id, detail: `bad row ${r.tag} ${r.kp}` });
      if (r.kp !== null) points.push({ time, kp: r.kp });
    }
    return ok({ sourceId: id, fetchedAt: this.fetchedAt(), requestUrl: url, raw: raw.value, parsed: points });
  }

  async geomagForecast(): Promise<Result<SourceSnapshot<GeomagForecast>, SourceError>> {
    const id = SwpcSpaceWeatherAdapter.forecastId;
    const url = this.url(FORECAST_PATH);
    const raw = await this.get(url, id, 'text/plain');
    if (!raw.ok) return raw;
    const parsed = parseGeomagForecast(raw.value);
    if (typeof parsed === 'string') return err({ code: 'schema_changed', sourceId: id, detail: parsed });
    return ok({ sourceId: id, fetchedAt: this.fetchedAt(), requestUrl: url, raw: raw.value, parsed, contentType: 'text/plain' });
  }
}
