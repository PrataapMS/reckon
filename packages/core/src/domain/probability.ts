/** Probabilities are clipped so log scores stay finite (spec §8). */
export const P_MIN = 0.01;
export const P_MAX = 0.99;

export function clipProbability(p: number): number {
  if (!Number.isFinite(p)) throw new RangeError(`probability must be finite, got ${p}`);
  return Math.min(P_MAX, Math.max(P_MIN, p));
}

export type VerbalLabel = 'Very unlikely' | 'Unlikely' | 'Toss-up' | 'Likely' | 'Very likely';

/** Display bands from spec §12 ("Probability display rules"). */
export function verbalLabel(p: number): VerbalLabel {
  if (p < 0.1) return 'Very unlikely';
  if (p < 0.35) return 'Unlikely';
  if (p <= 0.65) return 'Toss-up';
  if (p <= 0.9) return 'Likely';
  return 'Very likely';
}

/** Percent for display: whole numbers, never 0% or 100%. */
export function displayPercent(p: number): number {
  return Math.round(clipProbability(p) * 100);
}

/**
 * ADR-0007: before a template has history, a deterministic value becomes a probability via a
 * bounded logistic on its distance to the threshold. The [0.2, 0.8] bounds stop Reckon from
 * sounding confident before it has earned it. A fitted mapping will be a new forecaster version.
 */
export function provisionalProbability(value: number, threshold: number, scale: number): number {
  const z = (value - threshold) / Math.max(scale, 1e-9);
  const p = 1 / (1 + Math.exp(-z));
  return Math.min(0.8, Math.max(0.2, p));
}
