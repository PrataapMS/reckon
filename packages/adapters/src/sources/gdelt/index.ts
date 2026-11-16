import {
  err,
  type NewsSearchPort,
  type NewsVolumePort,
  ok,
  type RawNewsItem,
  type Result,
  type SourceError,
  type SourceSnapshot,
  type VolumePoint,
} from '@reckon/core';
import { z } from 'zod';
import { type FetchLike, httpGet } from '../http';
import { parse } from '../parse';

/** GDELT DOC 2.0 API adapter. Endpoint, limits and terms are recorded in SOURCE.md. */

const BASE = 'https://api.gdeltproject.org/api/v2/doc/doc';
/** GDELT asks for at most one request every 5 seconds per client. */
export const GDELT_MIN_INTERVAL_MS = 5_000;
const MAX_RECORDS = 250;
const DAY_MS = 86_400_000;

export interface GdeltOptions {
  readonly userAgent: string;
  readonly fetchImpl?: FetchLike;
  readonly now?: () => Date;
  readonly base?: string;
  /** Minimum gap between this instance's requests (defaults to GDELT's 5 s). */
  readonly minIntervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** GDELT queries over months can take longer than the usual 8 s. */
  readonly timeoutMs?: number;
}

/** Long timelines are slow to compute; still well inside a 25 s function budget. */
export const GDELT_TIMEOUT_MS = 12_000;

const Timeline = z.object({
  timeline: z
    .array(
      z.object({
        series: z.string().optional(),
        data: z.array(z.object({ date: z.string().regex(/^\d{8}T/), value: z.number() })),
      }),
    )
    .optional(),
});

const ArtList = z.object({
  articles: z
    .array(
      z.object({
        url: z.string(),
        title: z.string(),
        seendate: z.string(),
        domain: z.string(),
        language: z.string().optional(),
      }),
    )
    .optional(),
});

/** '20261005T103000Z' -> '2026-10-05T10:30:00.000Z'; null if GDELT's compact form changes. */
export function gdeltInstant(s: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s);
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function datesBetween(start: string, end: string): string[] {
  const out: string[] = [];
  const last = Date.parse(`${end}T00:00:00Z`);
  for (let t = Date.parse(`${start}T00:00:00Z`); t <= last; t += DAY_MS) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

export class GdeltAdapter implements NewsVolumePort, NewsSearchPort {
  static readonly id = 'gdelt.doc';
  /** Epoch ms before which the next request must not start; reserved synchronously so concurrent calls queue up. */
  private nextSlot = 0;

  constructor(private readonly o: GdeltOptions) {}

  volumeUrl(q: { readonly query: string; readonly start: string; readonly end: string }): string {
    const u = new URL(this.o.base ?? BASE);
    u.searchParams.set('mode', 'timelinevolraw');
    u.searchParams.set('format', 'json');
    u.searchParams.set('startdatetime', `${q.start.replaceAll('-', '')}000000`);
    u.searchParams.set('enddatetime', `${q.end.replaceAll('-', '')}235959`);
    u.searchParams.set('query', q.query);
    return u.toString();
  }

  articlesUrl(q: { readonly query: string; readonly hours: number; readonly max: number }): string {
    const u = new URL(this.o.base ?? BASE);
    u.searchParams.set('mode', 'artlist');
    u.searchParams.set('format', 'json');
    u.searchParams.set('maxrecords', String(Math.min(MAX_RECORDS, Math.max(1, Math.floor(q.max)))));
    u.searchParams.set('timespan', `${Math.max(1, Math.round(q.hours))}h`);
    u.searchParams.set('sort', 'datedesc');
    u.searchParams.set('query', q.query);
    return u.toString();
  }

  /** Matching articles per UTC day. Sub-daily buckets (15 min or hourly for short spans) are summed. */
  async dailyVolume(q: { readonly query: string; readonly start: string; readonly end: string }): Promise<Result<SourceSnapshot<VolumePoint[]>, SourceError>> {
    const url = this.volumeUrl(q);
    const body = await this.getJson(url);
    if (!body.ok) return body;
    if (body.value.trim() === '') return ok(this.snapshot(url, body.value, []));
    const parsed = parse(Timeline, body.value, GdeltAdapter.id);
    if (!parsed.ok) return parsed;
    const data = parsed.value.timeline?.[0]?.data ?? [];
    // No buckets at all means GDELT has nothing for the query (or the range is outside its ~3 months), not zero coverage.
    if (data.length === 0) return ok(this.snapshot(url, body.value, []));
    const byDay = new Map<string, number>();
    for (const { date, value } of data) {
      const day = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
      byDay.set(day, (byDay.get(day) ?? 0) + value);
    }
    const points = datesBetween(q.start, q.end).map((date) => ({ date, count: byDay.get(date) ?? 0 }));
    return ok(this.snapshot(url, body.value, points));
  }

  async articles(q: { readonly query: string; readonly hours: number; readonly max: number }): Promise<Result<SourceSnapshot<RawNewsItem[]>, SourceError>> {
    const url = this.articlesUrl(q);
    const body = await this.getJson(url);
    if (!body.ok) return body;
    // With no matches GDELT may send an empty body instead of {}.
    if (body.value.trim() === '') return ok(this.snapshot(url, body.value, []));
    const parsed = parse(ArtList, body.value, GdeltAdapter.id);
    if (!parsed.ok) return parsed;
    const items: RawNewsItem[] = [];
    for (const a of parsed.value.articles ?? []) {
      const title = a.title.trim();
      if (!title || !/^https?:\/\//i.test(a.url)) continue;
      items.push({
        url: a.url,
        title,
        source: a.domain,
        publishedAt: gdeltInstant(a.seendate),
        snippet: null,
        lang: a.language ?? null,
        origin: 'gdelt',
      });
    }
    return ok(this.snapshot(url, body.value, items));
  }

  /** Polite GET of a JSON body (possibly empty), or schema_changed for GDELT's plain-text errors. */
  private async getJson(url: string): Promise<Result<string, SourceError>> {
    await this.waitTurn();
    const res = await httpGet(url, {
      sourceId: GdeltAdapter.id,
      userAgent: this.o.userAgent,
      timeoutMs: this.o.timeoutMs ?? GDELT_TIMEOUT_MS,
      ...(this.o.fetchImpl ? { fetchImpl: this.o.fetchImpl } : {}),
    });
    if (!res.ok) return res;
    const text = res.value.text.trim();
    // Bad queries come back as HTTP 200 with a plain-text message instead of JSON.
    if (text !== '' && !text.startsWith('{')) return err({ code: 'schema_changed', sourceId: GdeltAdapter.id, detail: text.slice(0, 300) });
    return ok(res.value.text);
  }

  private async waitTurn(): Promise<void> {
    const now = (this.o.now?.() ?? new Date()).getTime();
    const at = Math.max(now, this.nextSlot);
    this.nextSlot = at + (this.o.minIntervalMs ?? GDELT_MIN_INTERVAL_MS);
    if (at > now) await (this.o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))))(at - now);
  }

  private snapshot<T>(url: string, raw: string, parsed: T): SourceSnapshot<T> {
    return { sourceId: GdeltAdapter.id, fetchedAt: (this.o.now?.() ?? new Date()).toISOString(), requestUrl: url, raw, parsed };
  }
}
