/**
 * Threshold selection for informative questions (spec §7):
 * keep ladder values whose climatological base rate is in [minRate, maxRate],
 * choose the one closest to 0.5, and break ties toward the more decision-relevant value.
 */
export interface ThresholdCandidate {
  readonly value: number;
  readonly baseRate: number;
  readonly decisionWeight?: number; // higher = more decision-relevant
}

export function selectThreshold(candidates: readonly ThresholdCandidate[], minRate = 0.25, maxRate = 0.75): ThresholdCandidate | undefined {
  const eligible = candidates.filter((c) => c.baseRate >= minRate && c.baseRate <= maxRate);
  let best: ThresholdCandidate | undefined;
  for (const c of eligible) {
    if (!best) {
      best = c;
      continue;
    }
    const d = Math.abs(c.baseRate - 0.5);
    const db = Math.abs(best.baseRate - 0.5);
    if (d < db - 1e-12 || (Math.abs(d - db) <= 1e-12 && (c.decisionWeight ?? 0) > (best.decisionWeight ?? 0))) best = c;
  }
  return best;
}

/** Base rate of a condition over historical daily values (e.g. share of days with rain >= t). */
export function baseRate(values: readonly number[], predicate: (v: number) => boolean): number {
  if (values.length === 0) return Number.NaN;
  return values.filter(predicate).length / values.length;
}
