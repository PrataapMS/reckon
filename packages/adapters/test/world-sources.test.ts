import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FrankfurterAdapter } from '../src/sources/frankfurter';
import { GfzKpAdapter } from '../src/sources/gfz';
import type { FetchLike } from '../src/sources/http';
import { SwpcSpaceWeatherAdapter } from '../src/sources/swpc';
import { UsgsEarthquakeAdapter } from '../src/sources/usgs';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
function recording(body: string, status = 200) {
  const urls: string[] = [];
  const accepts: (string | null)[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    urls.push(url);
    accepts.push(new Headers(init?.headers).get('accept'));
    return new Response(body, { status });
  };
  return { urls, accepts, fetchImpl };
}
const now = () => new Date('2026-10-05T18:00:00Z');
const code = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? 'ok' : r.error?.code);

describe('FrankfurterAdapter (recorded fixture)', () => {
  const q = { base: 'USD', quote: 'INR', start: '2025-09-25', end: '2025-10-03' };

  it('reads the ECB working days in range, in date order', async () => {
    const rec = recording(fixture('frankfurter-range.json'));
    const r = await new FrankfurterAdapter({ userAgent: 'test', fetchImpl: rec.fetchImpl, now }).dailyRates(q);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(rec.urls[0]).toBe('https://api.frankfurter.dev/v1/2025-09-25..2025-10-03?base=USD&symbols=INR');
    expect(r.value.sourceId).toBe('frankfurter');
    expect(r.value.fetchedAt).toBe('2026-10-05T18:00:00.000Z');
    // The weekend of 27-28 Sep is simply absent.
    expect(r.value.parsed.map((x) => x.date)).toEqual(['2025-09-25', '2025-09-26', '2025-09-29', '2025-09-30', '2025-10-01', '2025-10-02', '2025-10-03']);
    expect(r.value.parsed[2]).toEqual({ date: '2025-09-29', rate: 88.75 });
  });

  it('drops the previous working day Frankfurter substitutes for a weekend-only range', async () => {
    // Live behaviour: asking for Sat..Sun returns Friday's rate.
    const rec = recording('{"amount":1.0,"base":"USD","start_date":"2025-10-03","end_date":"2025-10-03","rates":{"2025-10-03":{"INR":88.78}}}');
    const r = await new FrankfurterAdapter({ userAgent: 'test', fetchImpl: rec.fetchImpl }).dailyRates({ ...q, start: '2025-10-04', end: '2025-10-05' });
    expect(r.ok && r.value.parsed).toEqual([]);
  });

  it('honours a base URL override', async () => {
    const rec = recording(fixture('frankfurter-range.json'));
    await new FrankfurterAdapter({ userAgent: 'test', fetchImpl: rec.fetchImpl, base: 'http://fx.test/v1/' }).dailyRates(q);
    expect(rec.urls[0]).toBe('http://fx.test/v1/2025-09-25..2025-10-03?base=USD&symbols=INR');
  });

  it('reports schema_changed when the shape or currency is wrong', async () => {
    const shape = recording('{"base":"USD","rates":[88.7]}');
    expect(code(await new FrankfurterAdapter({ userAgent: 'test', fetchImpl: shape.fetchImpl }).dailyRates(q))).toBe('schema_changed');
    const quote = recording('{"base":"USD","rates":{"2025-09-25":{"EUR":0.85}}}');
    expect(code(await new FrankfurterAdapter({ userAgent: 'test', fetchImpl: quote.fetchImpl }).dailyRates(q))).toBe('schema_changed');
    const base = recording('{"base":"EUR","rates":{"2025-09-25":{"INR":103.1}}}');
    expect(code(await new FrankfurterAdapter({ userAgent: 'test', fetchImpl: base.fetchImpl }).dailyRates(q))).toBe('schema_changed');
  });

  it('maps an unknown currency (404) to not_found', async () => {
    const rec = recording('{"message":"not found"}', 404);
    expect(code(await new FrankfurterAdapter({ userAgent: 'test', fetchImpl: rec.fetchImpl }).dailyRates({ ...q, quote: 'XXX' }))).toBe('not_found');
  });
});

describe('UsgsEarthquakeAdapter (recorded fixture)', () => {
  const q = { minMagnitude: 5.5, start: '2026-09-28T00:00:00.000Z', end: '2026-10-05T00:00:00.000Z' };

  it('maps GeoJSON features to quakes with ISO UTC times', async () => {
    const rec = recording(fixture('usgs-events.json'));
    const r = await new UsgsEarthquakeAdapter({ userAgent: 'test', fetchImpl: rec.fetchImpl, now }).events(q);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const u = new URL(rec.urls[0] ?? '');
    expect(u.origin + u.pathname).toBe('https://earthquake.usgs.gov/fdsnws/event/1/query');
    expect(Object.fromEntries(u.searchParams)).toEqual({
      format: 'geojson',
      starttime: q.start,
      endtime: q.end,
      minmagnitude: '5.5',
      orderby: 'time-asc',
    });
    expect(r.value.sourceId).toBe('usgs.earthquake');
    expect(r.value.parsed).toHaveLength(3);
    expect(r.value.parsed[0]).toEqual({
      id: 'us6000tyc3',
      time: new Date(1790687169941).toISOString(),
      magnitude: 5.5,
      place: 'southern Mid-Atlantic Ridge',
      url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us6000tyc3',
    });
  });

  const feature = (id: string, time: string, mag: number | null, type = 'earthquake') => ({
    type: 'Feature',
    id,
    properties: { mag, time: Date.parse(time), place: null, url: `https://example.test/${id}`, type },
  });

  it('treats end as exclusive and skips non-earthquakes and unsized events', async () => {
    const body = JSON.stringify({
      type: 'FeatureCollection',
      features: [
        feature('first', '2026-09-28T00:00:00Z', 6),
        feature('blast', '2026-09-29T00:00:00Z', 5.6, 'quarry blast'),
        feature('unsized', '2026-09-30T00:00:00Z', null),
        feature('last-ms', '2026-10-04T23:59:59.999Z', 5.5),
        feature('at-end', '2026-10-05T00:00:00Z', 7),
      ],
    });
    const rec = recording(body);
    const r = await new UsgsEarthquakeAdapter({ userAgent: 'test', fetchImpl: rec.fetchImpl }).events(q);
    expect(r.ok && r.value.parsed.map((x) => x.id)).toEqual(['first', 'last-ms']);
    expect(r.ok && r.value.parsed[0]?.place).toBe('');
  });

  it('reports schema_changed when features lose their fields', async () => {
    const rec = recording('{"type":"FeatureCollection","features":[{"id":"x","properties":{"mag":"5.5","time":1}}]}');
    expect(code(await new UsgsEarthquakeAdapter({ userAgent: 'test', fetchImpl: rec.fetchImpl }).events(q))).toBe('schema_changed');
  });
});

describe('GfzKpAdapter (recorded fixture)', () => {
  it('zips the parallel Kp and datetime arrays', async () => {
    const rec = recording(fixture('gfz-kp.json'));
    const r = await new GfzKpAdapter({ userAgent: 'test', fetchImpl: rec.fetchImpl, now }).kpHistory({
      start: '2026-09-01T00:00:00.000Z',
      end: '2026-09-01T23:59:59Z',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // GFZ rejects milliseconds with HTTP 500, so they are stripped.
    expect(rec.urls[0]).toBe('https://kp.gfz.de/app/json/?start=2026-09-01T00%3A00%3A00Z&end=2026-09-01T23%3A59%3A59Z&index=Kp');
    expect(r.value.sourceId).toBe('gfz.kp');
    expect(r.value.parsed).toHaveLength(8);
    expect(r.value.parsed[0]).toEqual({ time: '2026-09-01T00:00:00.000Z', kp: 0.667 });
    expect(r.value.parsed[7]).toEqual({ time: '2026-09-01T21:00:00.000Z', kp: 1.333 });
  });

  it('accepts bare dates as the start of the UTC day', async () => {
    const rec = recording(fixture('gfz-kp.json'));
    await new GfzKpAdapter({ userAgent: 'test', fetchImpl: rec.fetchImpl }).kpHistory({ start: '2026-09-01', end: '2026-09-02' });
    expect(rec.urls[0]).toContain('start=2026-09-01T00%3A00%3A00Z&end=2026-09-02T00%3A00%3A00Z');
  });

  it('reports schema_changed when the arrays differ in length', async () => {
    const rec = recording('{"Kp":[1,2],"datetime":["2026-09-01T00:00:00Z"],"meta":{}}');
    const r = await new GfzKpAdapter({ userAgent: 'test', fetchImpl: rec.fetchImpl }).kpHistory({ start: '2026-09-01', end: '2026-09-02' });
    expect(code(r)).toBe('schema_changed');
  });

  it('reports schema_changed when Kp disappears', async () => {
    const rec = recording('{"ap":[1],"datetime":["2026-09-01T00:00:00Z"]}');
    const r = await new GfzKpAdapter({ userAgent: 'test', fetchImpl: rec.fetchImpl }).kpHistory({ start: '2026-09-01', end: '2026-09-02' });
    expect(code(r)).toBe('schema_changed');
  });
});

describe('SwpcSpaceWeatherAdapter.observedKp (recorded fixture)', () => {
  it('reads the current object format and treats time tags as UTC', async () => {
    const rec = recording(fixture('swpc-kp.json'));
    const r = await new SwpcSpaceWeatherAdapter({ userAgent: 'test', fetchImpl: rec.fetchImpl, now }).observedKp();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(rec.urls[0]).toBe('https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json');
    expect(r.value.sourceId).toBe('swpc.kp');
    expect(r.value.contentType).toBeUndefined();
    expect(r.value.parsed).toHaveLength(8);
    expect(r.value.parsed[0]).toEqual({ time: '2026-09-28T00:00:00.000Z', kp: 0.67 });
    expect(r.value.parsed[1]).toEqual({ time: '2026-09-28T03:00:00.000Z', kp: 1.67 });
  });

  it('still reads the legacy array-of-arrays format', async () => {
    const legacy = JSON.stringify([
      ['time_tag', 'Kp', 'a_running', 'station_count'],
      ['2026-09-28 00:00:00.000', '0.67', '3', '8'],
      ['2026-09-28 03:00:00.000', '1.67', '6', '8'],
    ]);
    const rec = recording(legacy);
    const r = await new SwpcSpaceWeatherAdapter({ userAgent: 'test', fetchImpl: rec.fetchImpl }).observedKp();
    expect(r.ok && r.value.parsed).toEqual([
      { time: '2026-09-28T00:00:00.000Z', kp: 0.67 },
      { time: '2026-09-28T03:00:00.000Z', kp: 1.67 },
    ]);
  });

  it('reports schema_changed for an unrecognised payload', async () => {
    const objects = recording('[{"time":"2026-09-28T00:00:00","kp_index":1}]');
    expect(code(await new SwpcSpaceWeatherAdapter({ userAgent: 'test', fetchImpl: objects.fetchImpl }).observedKp())).toBe('schema_changed');
    const table = recording('[["when","index"],["2026-09-28 00:00:00.000","0.67"]]');
    expect(code(await new SwpcSpaceWeatherAdapter({ userAgent: 'test', fetchImpl: table.fetchImpl }).observedKp())).toBe('schema_changed');
  });
});

describe('SwpcSpaceWeatherAdapter.geomagForecast (recorded fixture)', () => {
  it('parses issue time, probabilities and the daily Kp maximum', async () => {
    const rec = recording(fixture('swpc-geomag-forecast.txt'));
    const r = await new SwpcSpaceWeatherAdapter({ userAgent: 'test', fetchImpl: rec.fetchImpl, now }).geomagForecast();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(rec.urls[0]).toBe('https://services.swpc.noaa.gov/text/3-day-geomag-forecast.txt');
    expect(rec.accepts[0]).toBe('text/plain');
    expect(r.value.sourceId).toBe('swpc.geomag_forecast');
    expect(r.value.contentType).toBe('text/plain');
    expect(r.value.parsed.issuedAt).toBe('2026-10-04T22:05:00.000Z');
    expect(r.value.parsed.days).toEqual([
      { date: '2026-10-05', pActive: 0.35, pMinor: 0.35, pModerate: 0.05, pStrong: 0.01, kpMax: 4.67 },
      { date: '2026-10-06', pActive: 0.35, pMinor: 0.2, pModerate: 0.05, pStrong: 0.01, kpMax: 3.67 },
      { date: '2026-10-07', pActive: 0.2, pMinor: 0.05, pModerate: 0.01, pStrong: 0.01, kpMax: 2.67 },
    ]);
  });

  const product = (issued: string, range: string, kpHeader: string | null) =>
    [
      ':Product: Geomagnetic Forecast',
      `:Issued: ${issued}`,
      '',
      `NOAA Geomagnetic Activity Probabilities ${range}`,
      'Active                15/10/10',
      'Minor storm           05/01/01',
      'Moderate storm        01/01/01',
      'Strong-Extreme storm  01/01/01',
      '',
      ...(kpHeader
        ? [
            'NOAA Kp index forecast',
            kpHeader,
            '00-03UT        2.00      3.33      2.33',
            '03-06UT        5.67 (G2) 3.67      2.67',
            '21-00UT        3.00      1.67      4.00 (G1)',
          ]
        : []),
    ].join('\n');

  it('rolls a late-December issue into January of the next year', async () => {
    const rec = recording(product('2026 Dec 31 2205 UTC', '01 Jan-03 Jan', '             Jan 01    Jan 02    Jan 03'));
    const r = await new SwpcSpaceWeatherAdapter({ userAgent: 'test', fetchImpl: rec.fetchImpl }).geomagForecast();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.parsed.issuedAt).toBe('2026-12-31T22:05:00.000Z');
    expect(r.value.parsed.days.map((d) => [d.date, d.kpMax])).toEqual([
      ['2027-01-01', 5.67],
      ['2027-01-02', 3.67],
      ['2027-01-03', 4],
    ]);
  });

  it('handles a forecast that spans the year boundary', async () => {
    const rec = recording(product('2026 Dec 30 2205 UTC', '31 Dec-02 Jan', '             Dec 31    Jan 01    Jan 02'));
    const r = await new SwpcSpaceWeatherAdapter({ userAgent: 'test', fetchImpl: rec.fetchImpl }).geomagForecast();
    expect(r.ok && r.value.parsed.days.map((d) => d.date)).toEqual(['2026-12-31', '2027-01-01', '2027-01-02']);
    expect(r.ok && r.value.parsed.days[1]?.kpMax).toBe(3.67);
  });

  it('leaves kpMax null when the Kp table is missing', async () => {
    const rec = recording(product('2026 Oct 04 2205 UTC', '05 Oct-07 Oct', null));
    const r = await new SwpcSpaceWeatherAdapter({ userAgent: 'test', fetchImpl: rec.fetchImpl }).geomagForecast();
    expect(r.ok && r.value.parsed.days.map((d) => d.kpMax)).toEqual([null, null, null]);
    expect(r.ok && r.value.parsed.days[0]?.pActive).toBe(0.15);
  });

  it('reports schema_changed when a probability row is missing', async () => {
    const text = fixture('swpc-geomag-forecast.txt').replace(/^Minor storm.*$/m, '');
    const rec = recording(text);
    const r = await new SwpcSpaceWeatherAdapter({ userAgent: 'test', fetchImpl: rec.fetchImpl }).geomagForecast();
    expect(code(r)).toBe('schema_changed');
    if (!r.ok) expect(r.error.detail).toContain('Minor storm');
  });

  it('reports schema_changed without an issue time', async () => {
    const rec = recording(fixture('swpc-geomag-forecast.txt').replace(/^:Issued:.*$/m, ''));
    expect(code(await new SwpcSpaceWeatherAdapter({ userAgent: 'test', fetchImpl: rec.fetchImpl }).geomagForecast())).toBe('schema_changed');
  });
});
