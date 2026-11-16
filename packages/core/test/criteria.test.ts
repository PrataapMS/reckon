import { describe, expect, it } from 'vitest';
import { Criteria, canonicalJson, evaluate } from '../src';

const rain = Criteria.parse({
  kind: 'threshold',
  source: { id: 'openmeteo.forecast.past_days', version: '1' },
  missingPolicy: { retryUntilHours: 72, thenOutcome: 'annul' },
  metric: 'precipitation_sum',
  unit: 'mm',
  lat: 12.97,
  lon: 77.59,
  aggregation: 'daily_sum',
  comparator: '>=',
  threshold: 1,
  window: { start: '2026-10-06T00:00:00+05:30', end: '2026-10-07T00:00:00+05:30', tz: 'Asia/Kolkata' },
});

describe('Criteria', () => {
  it('rejects unknown kinds', () => {
    expect(Criteria.safeParse({ kind: 'vibes' }).success).toBe(false);
  });
  it('evaluates threshold criteria at the boundary', () => {
    expect(evaluate(rain, { kind: 'value', value: 1 })).toEqual({ ok: true, value: 1 });
    expect(evaluate(rain, { kind: 'value', value: 0.99 })).toEqual({ ok: true, value: 0 });
  });
  it('refuses an observation of the wrong shape instead of guessing', () => {
    const r = evaluate(rain, { kind: 'event', occurred: true });
    expect(r.ok).toBe(false);
  });
  it('produces the same canonical JSON regardless of key order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  });
});
