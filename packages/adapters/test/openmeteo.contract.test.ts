import { describe, expect, it } from 'vitest';
import {
  OpenMeteoAirQualityAdapter,
  OpenMeteoEnsembleAdapter,
  OpenMeteoForecastAdapter,
  OpenMeteoGeocodingAdapter,
  OpenMeteoHistoryAdapter,
  OpenMeteoPastDayAdapter,
} from '../src';

/**
 * Live contract tests: hit the real API. Run nightly in CI (`pnpm test:contracts`), never in the
 * normal unit run. A failure here means the provider changed something; see docs/runbooks.
 */
const live = process.env.RECKON_LIVE === '1';
const q = { lat: 12.97, lon: 77.59, tz: 'Asia/Kolkata', days: 3 };
const ua = `Reckon/0.1 (contract test; ${process.env.CONTACT_EMAIL ?? 'unknown'})`;

describe.runIf(live)('Open-Meteo live contract', () => {
  it('forecast endpoint still returns the fields Reckon depends on', async () => {
    const r = await new OpenMeteoForecastAdapter({ userAgent: ua }).dailyForecast(q);
    expect(r.ok, r.ok ? '' : JSON.stringify(r.error)).toBe(true);
  });
  it('air-quality endpoint still returns hourly US AQI', async () => {
    const r = await new OpenMeteoAirQualityAdapter({ userAgent: ua }).dailyForecast(q);
    expect(r.ok, r.ok ? '' : JSON.stringify(r.error)).toBe(true);
  });

  it('ensemble endpoint still returns per-member daily values', async () => {
    const r = await new OpenMeteoEnsembleAdapter({ userAgent: ua }).dailyMembers({ ...q, days: 8 });
    expect(r.ok, r.ok ? '' : JSON.stringify(r.error)).toBe(true);
    if (r.ok) expect(r.value.parsed[0]?.precipSumMm.length).toBeGreaterThanOrEqual(30);
  });
  it('archive (ERA5) endpoint still returns long daily history', async () => {
    const r = await new OpenMeteoHistoryAdapter({ userAgent: ua }).dailyHistory({ ...q, start: '2015-01-01', end: '2015-12-31' }, 'temperature_2m_max');
    expect(r.ok, r.ok ? '' : JSON.stringify(r.error)).toBe(true);
    if (r.ok) expect(r.value.parsed.values.length).toBe(365);
  });
  it('past-day reads still work for resolution', async () => {
    const yesterday = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
    const a = new OpenMeteoPastDayAdapter({ userAgent: ua });
    for (const metric of ['precipitation_sum', 'temperature_2m_max', 'us_aqi'] as const) {
      const r = await a.observeDay({ ...q, date: yesterday, metric });
      expect(r.ok, r.ok ? '' : JSON.stringify(r.error)).toBe(true);
      if (r.ok) expect(r.value.parsed.value, metric).not.toBeNull();
    }
  });
  it('geocoding still finds cities', async () => {
    const r = await new OpenMeteoGeocodingAdapter({ userAgent: ua }).search('Bengaluru');
    expect(r.ok && r.value.length).toBeGreaterThan(0);
  });
});
