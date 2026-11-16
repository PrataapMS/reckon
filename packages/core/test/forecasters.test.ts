import { describe, expect, it } from 'vitest';
import {
  climatologyForecaster,
  ensembleForecaster,
  type ForecastInputs,
  type ForecastQuestion,
  persistenceForecaster,
  providerForecaster,
} from '../src/domain/forecasters';
import type { DailyQuestionMeta } from '../src/domain/templates';

const meta = (over: Partial<DailyQuestionMeta> = {}): DailyQuestionMeta => ({
  metric: 'precipitation_sum',
  comparator: '>=',
  threshold: 1,
  unit: 'mm',
  subject: 'Rain ≥ 1 mm',
  placeName: 'Home',
  class: 'decision',
  ...over,
});
const q = (m: Partial<DailyQuestionMeta> = {}): ForecastQuestion => ({ targetDate: '2026-10-07', meta: meta(m) });

const inputs: ForecastInputs = {
  weather: [{ date: '2026-10-07', precipProbabilityMax: 72, precipSumMm: 4.3, tempMaxC: 31.2 }],
  air: [{ date: '2026-10-07', usAqiMax: 180 }],
  ensemble: [{ date: '2026-10-07', precipSumMm: [0, 0.5, 1, 2, 3, 4, 5, 6, 0, 0], tempMaxC: [30, 31, 32, 33] }],
  climatology: {
    // Every 6 Oct–ish day for 10 years: rain on 40% of them.
    precipitation_sum: { start: '2016-09-30', values: Array.from({ length: 3650 }, (_, i) => (i % 5 < 2 ? 3 : 0)) },
  },
  observed: { precipitation_sum: 0.2, temperature_2m_max: 33 },
};

describe('forecasters', () => {
  it('provider: uses the precipitation probability for "any rain"', () => {
    expect(providerForecaster.forecast(q(), inputs)?.p).toBeCloseTo(0.72);
  });

  it('provider: uses the bounded provisional mapping elsewhere (ADR-0007)', () => {
    const hot = providerForecaster.forecast(q({ metric: 'temperature_2m_max', threshold: 31, unit: '°C' }), inputs);
    expect(hot?.p).toBeGreaterThan(0.5);
    expect(hot?.p).toBeLessThanOrEqual(0.8);
    const aqi = providerForecaster.forecast(q({ metric: 'us_aqi', comparator: '>', threshold: 150, unit: 'US AQI' }), inputs);
    expect(aqi?.p).toBe(0.8);
    expect(aqi?.uses).toEqual(['air']);
  });

  it('ensemble: share of members with (k + 1) / (n + 2) shrinkage', () => {
    // members >= 1 mm: 1,2,3,4,5,6 -> k = 6 of n = 10
    expect(ensembleForecaster.forecast(q(), inputs)?.p).toBeCloseTo(7 / 12);
    expect(ensembleForecaster.forecast(q({ metric: 'us_aqi' }), inputs)).toBeNull();
  });

  it('climatology: the seasonal base rate', () => {
    expect(climatologyForecaster.forecast(q(), inputs)?.p).toBeCloseTo(0.4, 1);
    expect(climatologyForecaster.forecast(q({ metric: 'temperature_2m_max' }), inputs)).toBeNull();
  });

  it('persistence: 0.7 if the condition held yesterday, else 0.3', () => {
    expect(persistenceForecaster.forecast(q(), inputs)?.p).toBe(0.3);
    expect(persistenceForecaster.forecast(q({ metric: 'temperature_2m_max', threshold: 32, unit: '°C' }), inputs)?.p).toBe(0.7);
    expect(persistenceForecaster.forecast(q({ metric: 'us_aqi' }), inputs)).toBeNull();
  });

  it('never return certainty', () => {
    const allWet: ForecastInputs = { ...inputs, ensemble: [{ date: '2026-10-07', precipSumMm: Array(51).fill(9), tempMaxC: [] }] };
    const p = ensembleForecaster.forecast(q(), allWet)?.p ?? 1;
    expect(p).toBeLessThan(0.99);
  });
});
