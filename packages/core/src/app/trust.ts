import { seededRng } from '../domain/rng';
import { clusterBootstrapBss, type PairedForecast, type TrustStatus, trustStatus } from '../domain/scoring';
import { REFERENCE_FORECASTERS } from '../domain/templates';
import type { ScoredForecast, ScoreReader } from '../ports';

/** Spec §3.5: no trust label until 30 independent clusters (days per region) are scored. */
export const MIN_CLUSTERS = 30;
const BOOTSTRAP_SEED = 20261005; // fixed so a label never flickers between requests

export type TrustLabel = TrustStatus | 'baseline';

export interface TrustInfo {
  readonly status: TrustLabel;
  readonly clusters: number;
  readonly needed: number;
  readonly bss: number | null;
  readonly ci: readonly [number, number] | null;
}

export interface TrustTable {
  get(templateId: string | null, forecasterId: string): TrustInfo;
}

const finite = (x: number) => (Number.isFinite(x) ? x : null);

/**
 * Trust labels read from the ledger (spec §3.5): BSS against climatology on the same questions,
 * with a cluster bootstrap, per template and forecaster. Climatology is the reference itself.
 */
const isReference = (id: string) => (REFERENCE_FORECASTERS as readonly string[]).includes(id);

/**
 * Pair every scored forecast with the reference forecaster's p on the same question
 * (climatology for weather and air, the recent base rate for world questions), grouped by
 * template and forecaster. Questions without a reference forecast are left out.
 */
export function pairWithReference(scored: readonly ScoredForecast[]): Map<string, PairedForecast[]> {
  const ref = new Map<string, number>();
  for (const s of scored) if (isReference(s.forecasterId)) ref.set(s.questionId, s.p);
  const groups = new Map<string, PairedForecast[]>();
  for (const s of scored) {
    const pRef = ref.get(s.questionId);
    if (pRef === undefined) continue;
    const k = `${s.templateId}|${s.forecasterId}`;
    const list = groups.get(k) ?? [];
    list.push({ cluster: s.cluster, p: s.p, pRef, o: s.o });
    groups.set(k, list);
  }
  return groups;
}

export function trustFor(items: readonly PairedForecast[], forecasterId: string): TrustInfo {
  const clusters = new Set(items.map((i) => i.cluster)).size;
  if (isReference(forecasterId)) return { status: 'baseline', clusters, needed: MIN_CLUSTERS, bss: 0, ci: null };
  if (clusters < MIN_CLUSTERS) return { status: 'learning', clusters, needed: MIN_CLUSTERS, bss: null, ci: null };
  const r = clusterBootstrapBss(items, seededRng(BOOTSTRAP_SEED));
  const lo = finite(r.ci[0]);
  const hi = finite(r.ci[1]);
  return { status: trustStatus(r, MIN_CLUSTERS), clusters, needed: MIN_CLUSTERS, bss: finite(r.bss), ci: lo != null && hi != null ? [lo, hi] : null };
}

export function computeTrust(deps: { scores: ScoreReader }) {
  return async (userId: string): Promise<TrustTable> => {
    const groups = pairWithReference(await deps.scores.scored(userId));
    const cache = new Map<string, TrustInfo>();
    return {
      get(templateId, forecasterId) {
        const k = `${templateId}|${forecasterId}`;
        const hit = cache.get(k);
        if (hit) return hit;
        const info = trustFor(groups.get(k) ?? [], forecasterId);
        cache.set(k, info);
        return info;
      },
    };
  };
}

export function trustText(t: TrustInfo, forecasterName: string): string {
  switch (t.status) {
    case 'learning':
      return `${forecasterName}: learning, ${t.clusters} of ${t.needed} days scored`;
    case 'baseline':
      return `${forecasterName}: the historical base rate`;
    case 'proven':
      return `${forecasterName}: proven skill over ${t.clusters} days`;
    case 'no_edge':
      return `${forecasterName}: no proven edge over ${t.clusters} days`;
    case 'worse':
      return `${forecasterName}: worse than the base rate over ${t.clusters} days`;
  }
}
