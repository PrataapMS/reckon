import { describe, expect, it } from 'vitest';
import { Criteria } from '../src/domain/criteria';
import type { DailySeries } from '../src/domain/data';
import { addDays } from '../src/domain/dates';
import { correlationGroup, type GenerationCtx, lockTime, TEMPLATES } from '../src/domain/templates';

const templateById = (id: string) => TEMPLATES.find((t) => t.id === id);

/** 12 years of synthetic history: rain on alternate days with growing amounts; mild temperatures. */
function series(start: string, years: number, f: (i: number, date: string) => number): DailySeries {
  const values: number[] = [];
  for (let i = 0, d = start; i < years * 365; i++, d = addDays(d, 1)) values.push(f(i, d));
  return { start, values };
}

const place = { id: 'loc-1', name: 'Home', lat: 12.9716, lon: 77.5946, tz: 'Asia/Kolkata' };
const now = new Date('2026-10-05T23:15:00Z'); // 04:45 on 6 Oct in Bengaluru

function ctx(over: Partial<GenerationCtx> = {}): GenerationCtx {
  return {
    now,
    today: '2026-10-06',
    place,
    briefMinutes: 6 * 60 + 30,
    climatology: {
      precipitation_sum: series('2014-01-01', 12, (i) => (i % 2 === 0 ? 0 : (i % 7) * 2)),
      temperature_2m_max: series('2014-01-01', 12, (i) => 26 + (i % 9)),
      us_aqi: series('2022-08-01', 4, (i) => 40 + (i % 10) * 20),
    },
    ...over,
  };
}

describe('question templates', () => {
  it('produce valid, frozen threshold criteria for every horizon', () => {
    const qs = TEMPLATES.flatMap((t) => t.candidates(ctx()));
    expect(qs.length).toBeGreaterThanOrEqual(8);
    for (const q of qs) {
      expect(Criteria.safeParse(q.criteria).success).toBe(true);
      expect(q.lockAt.getTime()).toBeLessThanOrEqual(q.windowStart.getTime());
      expect(q.windowStart.getTime()).toBeLessThan(q.windowEnd.getTime());
      expect(q.targetDate).toBe(addDays('2026-10-06', q.horizonDays));
      expect(q.criteria.lat).toBe(12.97); // coordinates rounded to ~1 km
    }
  });

  it('lock at the brief time so the brief shows exactly what is scored', () => {
    const [q] = templateById('wx.rain_any')?.candidates(ctx()) ?? [];
    expect(q?.lockAt.toISOString()).toBe('2026-10-06T01:00:00.000Z'); // 06:30 IST
    expect(q?.criteria.window).toEqual({ start: '2026-10-07T00:00:00+05:30', end: '2026-10-08T00:00:00+05:30', tz: 'Asia/Kolkata' });
  });

  it('lock shortly after a late generation, and never after the window opens', () => {
    const late = ctx({ now: new Date('2026-10-06T10:00:00Z') });
    expect(lockTime(late, new Date('2026-10-07T00:00:00Z'))?.toISOString()).toBe('2026-10-06T10:15:00.000Z');
    expect(lockTime(late, new Date('2026-10-06T10:05:00Z'))).toBeUndefined();
  });

  it('use the fixed, human-meaningful threshold for decisions', () => {
    const rain = templateById('wx.rain_any')?.candidates(ctx()) ?? [];
    expect(rain.map((q) => [q.horizonDays, q.criteria.threshold, q.criteria.comparator])).toEqual([
      [1, 1, '>='],
      [3, 1, '>='],
    ]);
    const aqi = templateById('air.aqi_decision')?.candidates(ctx()) ?? [];
    expect(aqi.map((q) => [q.criteria.threshold, q.criteria.comparator, q.criteria.source.id])).toEqual([[150, '>', 'openmeteo.air_quality']]);
  });

  it('pick informative thresholds with a base rate near 50%, excluding the decision threshold', () => {
    const [rain] = templateById('wx.rain_adaptive')?.candidates(ctx()) ?? [];
    expect(rain?.criteria.threshold).not.toBe(1);
    expect(rain?.meta.baseRate).toBeGreaterThanOrEqual(0.25);
    expect(rain?.meta.baseRate).toBeLessThanOrEqual(0.75);
    const [t] = templateById('wx.tmax_adaptive')?.candidates(ctx()) ?? [];
    expect(Math.abs((t?.meta.baseRate ?? 0) - 0.5)).toBeLessThan(0.12);
  });

  it('skip adaptive templates when no climatology exists (spec §3.2 step 4)', () => {
    const noClim = ctx({ climatology: {} });
    expect(templateById('wx.rain_adaptive')?.candidates(noClim)).toEqual([]);
    expect(templateById('wx.rain_any')?.candidates(noClim)).toHaveLength(2);
  });

  it('cluster by date and region, so same-day questions are scored as one', () => {
    expect(correlationGroup('2026-10-07', 12.97, 77.59)).toBe('2026-10-07:13:78');
    const qs = TEMPLATES.flatMap((t) => t.candidates(ctx())).filter((q) => q.targetDate === '2026-10-07');
    expect(new Set(qs.map((q) => q.correlationGroup)).size).toBe(1);
  });

  it('turn probabilities into actions with tunable thresholds', () => {
    const rain = templateById('wx.rain_any');
    expect(rain?.action?.(0.55, {})).toBe('Take an umbrella');
    expect(rain?.action?.(0.55, { actionThresholds: { rain: 0.7 } })).toBe('No umbrella needed');
    expect(templateById('wx.tmax_adaptive')?.action).toBeUndefined();
  });
});
