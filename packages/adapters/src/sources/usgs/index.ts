import { err, ok, type Quake, type QuakePort, type Result, type SourceError, type SourceSnapshot } from '@reckon/core';
import { z } from 'zod';
import { type FetchLike, httpGetText } from '../http';
import { parse } from '../parse';

/** USGS FDSN event service (GeoJSON). Endpoint, terms and limits are in SOURCE.md. */

export interface UsgsEarthquakeOptions {
  readonly userAgent: string;
  readonly fetchImpl?: FetchLike;
  readonly now?: () => Date;
  /** Query endpoint (default https://earthquake.usgs.gov/fdsnws/event/1/query). */
  readonly base?: string;
}

const BASE = 'https://earthquake.usgs.gov/fdsnws/event/1/query';

const EventCollection = z.object({
  type: z.literal('FeatureCollection'),
  features: z.array(
    z.object({
      id: z.string(),
      properties: z.object({
        mag: z.number().nullable(),
        time: z.number(),
        place: z.string().nullable(),
        url: z.string(),
        type: z.string(),
      }),
    }),
  ),
});

export class UsgsEarthquakeAdapter implements QuakePort {
  static readonly id = 'usgs.earthquake';
  constructor(private readonly o: UsgsEarthquakeOptions) {}

  url(q: { readonly minMagnitude: number; readonly start: string; readonly end: string }): string {
    const u = new URL(this.o.base ?? BASE);
    u.searchParams.set('format', 'geojson');
    u.searchParams.set('starttime', q.start);
    u.searchParams.set('endtime', q.end);
    u.searchParams.set('minmagnitude', String(q.minMagnitude));
    u.searchParams.set('orderby', 'time-asc');
    return u.toString();
  }

  async events(q: { readonly minMagnitude: number; readonly start: string; readonly end: string }): Promise<Result<SourceSnapshot<Quake[]>, SourceError>> {
    const id = UsgsEarthquakeAdapter.id;
    const startMs = Date.parse(q.start);
    const endMs = Date.parse(q.end);
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) return err({ code: 'schema_changed', sourceId: id, detail: `invalid window ${q.start}..${q.end}` });
    const url = this.url(q);
    const raw = await httpGetText(url, { sourceId: id, userAgent: this.o.userAgent, ...(this.o.fetchImpl ? { fetchImpl: this.o.fetchImpl } : {}) });
    if (!raw.ok) return raw;
    const parsed = parse(EventCollection, raw.value, id);
    if (!parsed.ok) return parsed;
    const quakes: Quake[] = parsed.value.features
      .flatMap(({ id: eventId, properties: p }) => {
        // Explosions, quarry blasts and unsized events do not count as earthquakes here.
        if (p.type !== 'earthquake' || p.mag === null || p.mag < q.minMagnitude) return [];
        // The API's endtime is inclusive; the port's window is [start, end).
        if (p.time < startMs || p.time >= endMs) return [];
        return [{ id: eventId, time: new Date(p.time).toISOString(), magnitude: p.mag, place: p.place ?? '', url: p.url }];
      })
      .sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
    return ok({ sourceId: id, fetchedAt: (this.o.now?.() ?? new Date()).toISOString(), requestUrl: url, raw: raw.value, parsed: quakes });
  }
}
