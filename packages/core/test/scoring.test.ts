import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  brier,
  brierSkillScore,
  clusterBootstrapBss,
  expectedCalibrationError,
  logScore,
  type PairedForecast,
  reliabilityBins,
  seededRng,
  trustStatus,
  wilsonInterval,
} from '../src';

const outcome = fc.constantFrom<0 | 1>(0, 1);
const prob = fc.double({ min: 0, max: 1, noNaN: true });

describe('brier', () => {
  it('is always within [0, 1]', () => {
    fc.assert(fc.property(prob, outcome, (p, o) => brier(p, o) >= 0 && brier(p, o) <= 1));
  });
  it('is 0 for a perfect forecast and 1 for a perfectly wrong one', () => {
    expect(brier(1, 1)).toBe(0);
    expect(brier(0, 1)).toBe(1);
  });
});

describe('logScore', () => {
  it('is finite even at p = 0 or 1 because probabilities are clipped', () => {
    fc.assert(fc.property(prob, outcome, (p, o) => Number.isFinite(logScore(p, o))));
  });
  it('punishes a confident miss more than a hedged one', () => {
    expect(logScore(0.95, 0)).toBeGreaterThan(logScore(0.6, 0));
  });
});

describe('brierSkillScore', () => {
  it('is 0 when the forecaster equals the reference', () => {
    const items: PairedForecast[] = [
      { cluster: 'a', p: 0.3, pRef: 0.3, o: 1 },
      { cluster: 'b', p: 0.7, pRef: 0.7, o: 0 },
    ];
    expect(brierSkillScore(items)).toBeCloseTo(0);
  });
  it('is positive when the forecaster is sharper and right', () => {
    const items: PairedForecast[] = [
      { cluster: 'a', p: 0.9, pRef: 0.5, o: 1 },
      { cluster: 'b', p: 0.1, pRef: 0.5, o: 0 },
    ];
    expect(brierSkillScore(items)).toBeGreaterThan(0.9);
  });
});

describe('clusterBootstrapBss and trust labels', () => {
  const rng = seededRng(42);
  const make = (n: number, skilled: boolean): PairedForecast[] =>
    Array.from({ length: n }, (_, i) => {
      const o = (i % 2) as 0 | 1;
      return { cluster: `day-${i}`, p: skilled ? (o ? 0.8 : 0.2) : 0.5, pRef: 0.5, o };
    });

  it('labels a small sample as learning', () => {
    expect(trustStatus(clusterBootstrapBss(make(10, true), rng))).toBe('learning');
  });
  it('labels clear skill over many clusters as proven', () => {
    expect(trustStatus(clusterBootstrapBss(make(60, true), rng))).toBe('proven');
  });
  it('treats correlated questions in one cluster as one observation', () => {
    const correlated = make(60, true).map((f) => ({ ...f, cluster: 'same-storm' }));
    expect(clusterBootstrapBss(correlated, rng).clusters).toBe(1);
    expect(trustStatus(clusterBootstrapBss(correlated, rng))).toBe('learning');
  });
});

describe('calibration', () => {
  it('Wilson interval contains the observed proportion', () => {
    const [lo, hi] = wilsonInterval(7, 10);
    expect(lo).toBeLessThan(0.7);
    expect(hi).toBeGreaterThan(0.7);
  });
  it('a perfectly calibrated set has near-zero ECE', () => {
    const fs = [
      ...Array.from({ length: 10 }, (_, i) => ({ p: 0.3, o: (i < 3 ? 1 : 0) as 0 | 1 })),
      ...Array.from({ length: 10 }, (_, i) => ({ p: 0.9, o: (i < 9 ? 1 : 0) as 0 | 1 })),
    ];
    expect(expectedCalibrationError(reliabilityBins(fs))).toBeCloseTo(0, 5);
  });
});
