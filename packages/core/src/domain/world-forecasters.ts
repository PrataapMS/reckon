import { clipProbability } from './probability';
import type { ForecasterId } from './templates';

/**
 * Forecasters for world questions (spec §3.3). A world template works out, from the source's
 * history, whether its condition held in each of the last comparable windows; these strategies
 * turn that (and a provider's own probability, where one exists) into p.
 */

/** Below this many comparable windows a base rate is too noisy to state. */
export const MIN_HISTORY_WINDOWS = 8;
/** Spec §3.3: the last 52 comparable windows. */
export const MAX_HISTORY_WINDOWS = 52;

export interface WindowHistory {
  /** Outcome of each comparable past window, oldest first. */
  readonly outcomes: readonly boolean[];
  /** Plural noun for one window: 'weeks', '3-day windows', 'days'. */
  readonly unit: string;
}

export interface WorldForecastInputs {
  readonly history?: WindowHistory;
  /** A probability the source itself publishes (e.g. NOAA's storm probabilities). */
  readonly provider?: { readonly p: number; readonly rationale: string };
}

export interface WorldForecastOutput {
  readonly p: number;
  readonly rationale: string;
  readonly uses: 'history' | 'provider';
}

export interface WorldForecaster {
  readonly id: ForecasterId;
  readonly kind: 'history' | 'persistence' | 'provider';
  readonly displayName: string;
  forecast(inputs: WorldForecastInputs): WorldForecastOutput | null;
}

/** The share of recent comparable windows in which the condition held. */
export function historyRate(h: WindowHistory): { readonly k: number; readonly n: number; readonly rate: number } | null {
  const recent = h.outcomes.slice(-MAX_HISTORY_WINDOWS);
  if (recent.length < MIN_HISTORY_WINDOWS) return null;
  const k = recent.filter(Boolean).length;
  return { k, n: recent.length, rate: k / recent.length };
}

export const historyRateForecaster: WorldForecaster = {
  id: 'history.rate@1',
  kind: 'history',
  displayName: 'Recent base rate',
  forecast(inputs) {
    const r = inputs.history && historyRate(inputs.history);
    if (!r || !inputs.history) return null;
    return {
      p: clipProbability(r.rate),
      rationale: `Happened in ${r.k} of the last ${r.n} comparable ${inputs.history.unit}.`,
      uses: 'history',
    };
  },
};

/** Spec §3.3 persistence, for windows: 0.7 if the condition held in the last complete window, else 0.3. */
export const worldPersistenceForecaster: WorldForecaster = {
  id: 'persistence@1',
  kind: 'persistence',
  displayName: 'Persistence',
  forecast(inputs) {
    const last = inputs.history?.outcomes.at(-1);
    if (last === undefined || !inputs.history) return null;
    return {
      p: last ? 0.7 : 0.3,
      rationale: `It ${last ? 'happened' : 'did not happen'} in the most recent comparable window; persistence assumes the next looks the same.`,
      uses: 'history',
    };
  },
};

export const swpcProviderForecaster: WorldForecaster = {
  id: 'provider.swpc@1',
  kind: 'provider',
  displayName: 'NOAA SWPC forecast',
  forecast(inputs) {
    if (!inputs.provider) return null;
    return { p: clipProbability(inputs.provider.p), rationale: inputs.provider.rationale, uses: 'provider' };
  },
};

export const WORLD_FORECASTERS: readonly WorldForecaster[] = [historyRateForecaster, worldPersistenceForecaster, swpcProviderForecaster];
