import { describe, expect, it } from 'vitest';
import { FrankfurterAdapter } from '../src/sources/frankfurter';
import { GfzKpAdapter } from '../src/sources/gfz';
import { SwpcSpaceWeatherAdapter } from '../src/sources/swpc';
import { UsgsEarthquakeAdapter } from '../src/sources/usgs';

/**
 * Live contract tests for the money, world and space sources: hit the real APIs. Run nightly in
 * CI (`pnpm test:contracts`), never in the normal unit run. See each source's SOURCE.md.
 */
const live = process.env.RECKON_LIVE === '1';
const ua = `Reckon/0.1 (contract test; ${process.env.CONTACT_EMAIL ?? 'unknown'})`;
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
const date = (d: Date) => d.toISOString().slice(0, 10);

describe.runIf(live)('World sources live contract', () => {
  it('Frankfurter still returns ECB USD/INR rates for a recent range', async () => {
    const r = await new FrankfurterAdapter({ userAgent: ua }).dailyRates({ base: 'USD', quote: 'INR', start: date(daysAgo(14)), end: date(daysAgo(1)) });
    expect(r.ok, r.ok ? '' : JSON.stringify(r.error)).toBe(true);
    if (r.ok) expect(r.value.parsed.length).toBeGreaterThanOrEqual(5);
  });

  it('USGS still returns M4.5+ events for the last week', async () => {
    const end = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);
    const r = await new UsgsEarthquakeAdapter({ userAgent: ua }).events({ minMagnitude: 4.5, start: daysAgo(7).toISOString(), end: end.toISOString() });
    expect(r.ok, r.ok ? '' : JSON.stringify(r.error)).toBe(true);
    // The world has dozens of M4.5+ quakes a week; zero means the query broke.
    if (r.ok) expect(r.value.parsed.length).toBeGreaterThan(0);
  });

  it('GFZ still returns 3-hourly Kp history', async () => {
    const r = await new GfzKpAdapter({ userAgent: ua }).kpHistory({ start: '2024-05-10T00:00:00Z', end: '2024-05-12T21:00:00Z' });
    expect(r.ok, r.ok ? '' : JSON.stringify(r.error)).toBe(true);
    if (r.ok) {
      expect(r.value.parsed).toHaveLength(24);
      // The May 2024 superstorm reached Kp 9.
      expect(Math.max(...r.value.parsed.map((p) => p.kp))).toBe(9);
    }
  });

  it('SWPC still publishes the observed planetary Kp', async () => {
    const r = await new SwpcSpaceWeatherAdapter({ userAgent: ua }).observedKp();
    expect(r.ok, r.ok ? '' : JSON.stringify(r.error)).toBe(true);
    if (r.ok) expect(r.value.parsed.length).toBeGreaterThanOrEqual(40);
  });

  it('SWPC still publishes the 3-day geomagnetic forecast in the expected layout', async () => {
    const r = await new SwpcSpaceWeatherAdapter({ userAgent: ua }).geomagForecast();
    expect(r.ok, r.ok ? '' : JSON.stringify(r.error)).toBe(true);
    if (r.ok) {
      expect(r.value.parsed.days).toHaveLength(3);
      expect(r.value.parsed.days.every((d) => d.kpMax !== null)).toBe(true);
      expect(Date.now() - Date.parse(r.value.parsed.issuedAt)).toBeLessThan(3 * 86_400_000);
    }
  });
});
