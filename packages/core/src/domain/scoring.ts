import { clipProbability } from './probability';
import type { Rng } from './rng';

export type Outcome = 0 | 1;

/** Brier score: (p - o)^2. Lower is better; range [0, 1]. */
export function brier(p: number, o: Outcome): number {
  return (p - o) ** 2;
}

/** Log score: -[o ln p + (1 - o) ln(1 - p)], with p clipped to [0.01, 0.99]. Lower is better. */
export function logScore(p: number, o: Outcome): number {
  const q = clipProbability(p);
  return -(o * Math.log(q) + (1 - o) * Math.log(1 - q));
}

export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** One scored pair: the forecaster's p and the reference (climatology) p on the SAME question. */
export interface PairedForecast {
  readonly cluster: string; // correlation_group
  readonly p: number;
  readonly pRef: number;
  readonly o: Outcome;
}

/** Brier skill score vs the reference: 1 - mean(Brier_f) / mean(Brier_ref). */
export function brierSkillScore(items: readonly PairedForecast[]): number {
  const bf = mean(items.map((i) => brier(i.p, i.o)));
  const br = mean(items.map((i) => brier(i.pRef, i.o)));
  if (!Number.isFinite(bf) || !Number.isFinite(br)) return Number.NaN;
  if (br === 0) return bf === 0 ? 0 : Number.NEGATIVE_INFINITY;
  return 1 - bf / br;
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] as number;
  const b = sorted[hi] as number;
  return a + (b - a) * (pos - lo);
}

export interface BootstrapResult {
  readonly bss: number;
  readonly ci: readonly [number, number];
  readonly clusters: number;
}

/**
 * Cluster bootstrap of BSS (spec §10). Resamples whole correlation groups so that
 * five correlated questions on one stormy day do not count as five independent wins.
 */
export function clusterBootstrapBss(items: readonly PairedForecast[], rng: Rng, iterations = 2000, level = 0.95): BootstrapResult {
  const byCluster = new Map<string, PairedForecast[]>();
  for (const it of items) {
    const list = byCluster.get(it.cluster);
    if (list) list.push(it);
    else byCluster.set(it.cluster, [it]);
  }
  const clusters = [...byCluster.values()];
  const bss = brierSkillScore(items);
  if (clusters.length < 2) return { bss, ci: [Number.NaN, Number.NaN], clusters: clusters.length };

  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const draw: PairedForecast[] = [];
    for (let k = 0; k < clusters.length; k++) {
      const c = clusters[Math.floor(rng.next() * clusters.length)] as PairedForecast[];
      draw.push(...c);
    }
    const s = brierSkillScore(draw);
    if (Number.isFinite(s)) samples.push(s);
  }
  samples.sort((a, b) => a - b);
  const alpha = (1 - level) / 2;
  return { bss, ci: [quantile(samples, alpha), quantile(samples, 1 - alpha)], clusters: clusters.length };
}

export type TrustStatus = 'learning' | 'proven' | 'no_edge' | 'worse';

/** Trust labels shown on every probability (spec §10). */
export function trustStatus(result: BootstrapResult, minClusters = 30): TrustStatus {
  if (result.clusters < minClusters || !Number.isFinite(result.ci[0])) return 'learning';
  if (result.ci[0] > 0) return 'proven';
  if (result.ci[1] < 0) return 'worse';
  return 'no_edge';
}

export interface ReliabilityBin {
  readonly lower: number;
  readonly upper: number;
  readonly count: number;
  readonly meanForecast: number;
  readonly observedFrequency: number;
  readonly ci: readonly [number, number]; // Wilson 95%
}

/** Wilson score interval for a binomial proportion. */
export function wilsonInterval(successes: number, n: number, z = 1.96): readonly [number, number] {
  if (n === 0) return [Number.NaN, Number.NaN];
  const phat = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = (phat + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((phat * (1 - phat)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/** Reliability diagram bins (5 bins until a template has 500 forecasts, then 10). */
export function reliabilityBins(forecasts: readonly { readonly p: number; readonly o: Outcome }[], nBins = 5): ReliabilityBin[] {
  const bins: ReliabilityBin[] = [];
  for (let b = 0; b < nBins; b++) {
    const lower = b / nBins;
    const upper = (b + 1) / nBins;
    const inBin = forecasts.filter((f) => f.p >= lower && (b === nBins - 1 ? f.p <= upper : f.p < upper));
    const hits = inBin.filter((f) => f.o === 1).length;
    bins.push({
      lower,
      upper,
      count: inBin.length,
      meanForecast: mean(inBin.map((f) => f.p)),
      observedFrequency: inBin.length ? hits / inBin.length : Number.NaN,
      ci: wilsonInterval(hits, inBin.length),
    });
  }
  return bins;
}

/** Expected calibration error: count-weighted mean |forecast - observed| over non-empty bins. */
export function expectedCalibrationError(bins: readonly ReliabilityBin[]): number {
  const total = bins.reduce((s, b) => s + b.count, 0);
  if (total === 0) return Number.NaN;
  return bins.reduce((s, b) => (b.count ? s + (b.count / total) * Math.abs(b.meanForecast - b.observedFrequency) : s), 0);
}
