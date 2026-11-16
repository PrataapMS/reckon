import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type FetchLike, OpenMeteoAirQualityAdapter, OpenMeteoForecastAdapter } from '../src';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const fakeFetch =
  (body: string, status = 200): FetchLike =>
  async () =>
    new Response(body, { status });

const q = { lat: 12.97, lon: 77.59, tz: 'Asia/Kolkata', days: 3 };

describe('OpenMeteoForecastAdapter (recorded fixture)', () => {
  it('parses daily precipitation probability, rain and max temperature', async () => {
    const a = new OpenMeteoForecastAdapter({ userAgent: 'test', fetchImpl: fakeFetch(fixture('openmeteo-forecast.json')) });
    const r = await a.dailyForecast(q);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.parsed).toHaveLength(3);
    expect(r.value.parsed[0]).toMatchObject({ date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    expect(r.value.raw.length).toBeGreaterThan(0); // raw bytes kept as evidence
  });

  it('reports schema_changed instead of guessing when the payload shape changes', async () => {
    const a = new OpenMeteoForecastAdapter({ userAgent: 'test', fetchImpl: fakeFetch('{"daily":{"time":"oops"}}') });
    const r = await a.dailyForecast(q);
    expect(r.ok ? 'ok' : r.error.code).toBe('schema_changed');
  });

  it('maps HTTP 429 to rate_limited', async () => {
    const a = new OpenMeteoForecastAdapter({ userAgent: 'test', fetchImpl: fakeFetch('', 429) });
    const r = await a.dailyForecast(q);
    expect(r.ok ? 'ok' : r.error.code).toBe('rate_limited');
  });
});

describe('OpenMeteoAirQualityAdapter (recorded fixture)', () => {
  it('aggregates hourly US AQI into a daily maximum', async () => {
    const a = new OpenMeteoAirQualityAdapter({ userAgent: 'test', fetchImpl: fakeFetch(fixture('openmeteo-air.json')) });
    const r = await a.dailyForecast(q);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.parsed.length).toBeGreaterThanOrEqual(3);
    for (const d of r.value.parsed) if (d.usAqiMax != null) expect(d.usAqiMax).toBeGreaterThanOrEqual(0);
  });
});
