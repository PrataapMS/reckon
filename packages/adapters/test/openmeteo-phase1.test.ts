import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type FetchLike, OpenMeteoEnsembleAdapter, OpenMeteoGeocodingAdapter, OpenMeteoHistoryAdapter, OpenMeteoPastDayAdapter } from '../src';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
function recording(body: string, status = 200) {
  const urls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    urls.push(url);
    return new Response(body, { status });
  };
  return { urls, fetchImpl };
}
const place = { lat: 12.97, lon: 77.59, tz: 'Asia/Kolkata' };

describe('OpenMeteoEnsembleAdapter (recorded ECMWF fixture)', () => {
  it('collects the control run and every member per day', async () => {
    const rec = recording(fixture('openmeteo-ensemble.json'));
    const r = await new OpenMeteoEnsembleAdapter({ userAgent: 'test', fetchImpl: rec.fetchImpl }).dailyMembers({ ...place, days: 8 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.parsed).toHaveLength(8);
    expect(r.value.parsed[0]?.precipSumMm).toHaveLength(51);
    expect(r.value.parsed[0]?.tempMaxC).toHaveLength(51);
    expect(rec.urls[0]).toContain('models=ecmwf_ifs025');
  });

  it('reports schema_changed when member columns disappear', async () => {
    const rec = recording('{"daily":{"time":["2026-10-05"],"precipitation_sum":[1]}}');
    const r = await new OpenMeteoEnsembleAdapter({ userAgent: 'test', fetchImpl: rec.fetchImpl }).dailyMembers({ ...place, days: 1 });
    expect(r.ok ? 'ok' : r.error.code).toBe('schema_changed');
  });
});

describe('OpenMeteoHistoryAdapter (recorded fixtures)', () => {
  it('reads ERA5 daily history as a consecutive series', async () => {
    const rec = recording(fixture('openmeteo-archive.json'));
    const r = await new OpenMeteoHistoryAdapter({ userAgent: 'test', fetchImpl: rec.fetchImpl }).dailyHistory(
      { ...place, start: '2015-01-01', end: '2016-12-31' },
      'precipitation_sum',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.parsed.start).toBe('2015-01-01');
    expect(r.value.parsed.values).toHaveLength(731);
    expect(rec.urls[0]).toContain('archive-api.open-meteo.com');
  });

  it('reduces hourly air quality history to daily maxima and clamps to the dataset start', async () => {
    const rec = recording(fixture('openmeteo-air-history.json'));
    const r = await new OpenMeteoHistoryAdapter({ userAgent: 'test', fetchImpl: rec.fetchImpl }).dailyHistory(
      { ...place, start: '2014-01-01', end: '2023-01-21' },
      'us_aqi',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.parsed.start).toBe('2023-01-01');
    expect(r.value.parsed.values).toHaveLength(21);
    expect(rec.urls[0]).toContain('start_date=2022-08-01');
  });
});

describe('OpenMeteoPastDayAdapter (recorded fixtures)', () => {
  it('reads a past day from the forecast API by date range', async () => {
    const rec = recording(fixture('openmeteo-forecast-range.json'));
    const r = await new OpenMeteoPastDayAdapter({ userAgent: 'test', fetchImpl: rec.fetchImpl }).observeDay({
      ...place,
      date: '2026-10-04',
      metric: 'precipitation_sum',
    });
    expect(r.ok && r.value.parsed.value).toBe(0.6);
    expect(rec.urls[0]).toContain('start_date=2026-10-04&end_date=2026-10-04');
  });

  it('takes the day maximum of hourly AQI and treats a mostly-empty day as missing', async () => {
    const full = recording(fixture('openmeteo-air-range.json'));
    const r = await new OpenMeteoPastDayAdapter({ userAgent: 'test', fetchImpl: full.fetchImpl }).observeDay({
      ...place,
      date: '2026-10-03',
      metric: 'us_aqi',
    });
    expect(r.ok && typeof r.value.parsed.value).toBe('number');

    const sparse = JSON.stringify({ hourly: { time: ['2026-10-03T00:00', '2026-10-03T01:00'], us_aqi: [80, null] } });
    const s = await new OpenMeteoPastDayAdapter({ userAgent: 'test', fetchImpl: recording(sparse).fetchImpl }).observeDay({
      ...place,
      date: '2026-10-03',
      metric: 'us_aqi',
    });
    expect(s.ok && s.value.parsed.value).toBeNull();
  });
});

describe('OpenMeteoGeocodingAdapter (recorded fixture)', () => {
  it('returns places with coordinates and timezones', async () => {
    const r = await new OpenMeteoGeocodingAdapter({ userAgent: 'test', fetchImpl: recording(fixture('openmeteo-geocoding.json')).fetchImpl }).search('Bengal');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value[0]).toMatchObject({ name: 'Bengal', tz: expect.any(String) });
  });

  it('returns an empty list when nothing matches', async () => {
    const r = await new OpenMeteoGeocodingAdapter({ userAgent: 'test', fetchImpl: recording('{"generationtime_ms":0.1}').fetchImpl }).search('zzzz');
    expect(r.ok && r.value).toEqual([]);
  });
});
