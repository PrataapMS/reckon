import { describe, expect, it } from 'vitest';
import { acceptsForecastAt, selectThreshold, transition } from '../src';

describe('question lifecycle', () => {
  it('follows the happy path', () => {
    expect(transition('open', 'lock')).toEqual({ ok: true, value: 'locked' });
    expect(transition('locked', 'start_resolving')).toEqual({ ok: true, value: 'resolving' });
    expect(transition('resolving', 'resolve')).toEqual({ ok: true, value: 'resolved' });
  });
  it('makes illegal transitions impossible', () => {
    expect(transition('open', 'resolve').ok).toBe(false);
    expect(transition('annulled', 'lock').ok).toBe(false);
  });
  it('accepts forecasts only before lock', () => {
    const lock = new Date('2026-10-06T00:00:00Z');
    expect(acceptsForecastAt(lock, new Date('2026-10-05T23:59:59Z'))).toBe(true);
    expect(acceptsForecastAt(lock, lock)).toBe(false);
  });
});

describe('selectThreshold', () => {
  it('picks the ladder value whose base rate is closest to 0.5', () => {
    const pick = selectThreshold([
      { value: 0.2, baseRate: 0.82 },
      { value: 1, baseRate: 0.61 },
      { value: 5, baseRate: 0.46 },
      { value: 10, baseRate: 0.2 },
    ]);
    expect(pick?.value).toBe(5);
  });
  it('skips the day rather than forcing a degenerate question', () => {
    expect(selectThreshold([{ value: 1, baseRate: 0.03 }])).toBeUndefined();
  });
});
