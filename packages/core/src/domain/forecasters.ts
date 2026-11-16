import { MIN_CLIMATOLOGY_SAMPLES, seasonalSample, seriesYears } from './climatology';
import { type DailyAirQuality, type DailyMetric, type DailySeries, type DailyWeather, type EnsembleDay, ensembleMembers, forecastValue } from './data';
import { humanDate } from './dates';
import { clipProbability, provisionalProbability } from './probability';
import { type DailyQuestionMeta, type ForecasterId, meets } from './templates';

/**
 * Forecasters (spec §3.3): named, versioned strategies that turn the same inputs into a
 * probability. They are pure, so the generate use case can run every applicable one on every
 * question and the scoreboard can compare them honestly.
 */

/** Input bundles a forecaster may read. Each maps to an evidence snapshot the forecast cites. */
export type InputKind = 'forecast' | 'air' | 'ensemble' | 'climatology' | 'observed';

export interface ForecastInputs {
  readonly weather: readonly DailyWeather[] | null;
  readonly air: readonly DailyAirQuality[] | null;
  readonly ensemble: readonly EnsembleDay[] | null;
  readonly climatology: Partial<Record<DailyMetric, DailySeries>>;
  /** The most recent complete local day's observed values (yesterday), for persistence. */
  readonly observed: Partial<Record<DailyMetric, number>>;
}

export interface ForecastQuestion {
  readonly targetDate: string;
  readonly meta: DailyQuestionMeta;
}

export interface ForecastOutput {
  readonly p: number;
  readonly rationale: string;
  readonly uses: readonly InputKind[];
}

export interface Forecaster {
  readonly id: ForecasterId;
  readonly kind: 'provider' | 'ensemble' | 'climatology' | 'persistence';
  readonly displayName: string;
  /** Returns null when it has nothing to say (missing data, unsupported metric). */
  forecast(q: ForecastQuestion, inputs: ForecastInputs): ForecastOutput | null;
}

/** ADR-0007 scales for the provisional mapping. Rain scales with the threshold (ADR-0008). */
export function provisionalScale(metric: DailyMetric, threshold: number): number {
  switch (metric) {
    case 'temperature_2m_max':
      return 1.5;
    case 'us_aqi':
      return 15;
    case 'precipitation_sum':
      return Math.max(1, threshold / 2);
  }
}

function fmt(v: number, unit: string): string {
  const rounded = unit === 'US AQI' ? Math.round(v) : Math.round(v * 10) / 10;
  return unit === 'US AQI' ? `US AQI ${rounded}` : `${rounded} ${unit}`;
}

/** Provider precipitation probability is the chance of measurable rain, so it answers "any rain". */
const RAIN_ANY_MAX_MM = 1;

export const providerForecaster: Forecaster = {
  id: 'provider.openmeteo@1',
  kind: 'provider',
  displayName: 'Open-Meteo provider',
  forecast(q, inputs) {
    const m = q.meta;
    const above = m.comparator === '>' || m.comparator === '>=';
    if (m.metric === 'precipitation_sum' && above && m.threshold <= RAIN_ANY_MAX_MM) {
      const day = inputs.weather?.find((d) => d.date === q.targetDate);
      if (day?.precipProbabilityMax != null) {
        return {
          p: clipProbability(day.precipProbabilityMax / 100),
          rationale: `Open-Meteo gives a ${Math.round(day.precipProbabilityMax)}% peak hourly chance of rain on ${humanDate(q.targetDate)}.`,
          uses: ['forecast'],
        };
      }
    }
    const value = forecastValue(m.metric, q.targetDate, inputs.weather, inputs.air);
    if (value == null) return null;
    const pAbove = provisionalProbability(value, m.threshold, provisionalScale(m.metric, m.threshold));
    return {
      p: clipProbability(above ? pAbove : 1 - pAbove),
      rationale: `Open-Meteo forecasts ${fmt(value, m.unit)} on ${humanDate(q.targetDate)}; turned into a probability with the provisional mapping (capped at 20–80%).`,
      uses: [m.metric === 'us_aqi' ? 'air' : 'forecast'],
    };
  },
};

export const ensembleForecaster: Forecaster = {
  id: 'ensemble.openmeteo@1',
  kind: 'ensemble',
  displayName: 'Open-Meteo ensemble',
  forecast(q, inputs) {
    const members = ensembleMembers(q.meta.metric, q.targetDate, inputs.ensemble);
    if (!members) return null;
    const k = members.filter((v) => meets(v, q.meta.comparator, q.meta.threshold)).length;
    const n = members.length;
    return {
      // Spec §3.3: shrink toward 50% with (k + 1) / (n + 2) so 51/51 never reads as certainty.
      p: clipProbability((k + 1) / (n + 2)),
      rationale: `${k} of ${n} ECMWF ensemble members meet the condition on ${humanDate(q.targetDate)}.`,
      uses: ['ensemble'],
    };
  },
};

export const climatologyForecaster: Forecaster = {
  id: 'climatology@1',
  kind: 'climatology',
  displayName: 'Climatology',
  forecast(q, inputs) {
    const series = inputs.climatology[q.meta.metric];
    if (!series) return null;
    const sample = seasonalSample(series, q.targetDate);
    if (sample.length < MIN_CLIMATOLOGY_SAMPLES) return null;
    const k = sample.filter((v) => meets(v, q.meta.comparator, q.meta.threshold)).length;
    const rate = k / sample.length;
    return {
      p: clipProbability(rate),
      rationale: `Happened on ${Math.round(rate * 100)}% of ${sample.length} days within a week of ${humanDate(q.targetDate).slice(4)} over ${seriesYears(series)} years.`,
      uses: ['climatology'],
    };
  },
};

/** Spec §3.3: 0.7 if the condition held on the last complete day, else 0.3 (tuned later). */
export const persistenceForecaster: Forecaster = {
  id: 'persistence@1',
  kind: 'persistence',
  displayName: 'Persistence',
  forecast(q, inputs) {
    const v = inputs.observed[q.meta.metric];
    if (v == null) return null;
    const held = meets(v, q.meta.comparator, q.meta.threshold);
    return {
      p: held ? 0.7 : 0.3,
      rationale: `Yesterday was ${fmt(v, q.meta.unit)}, so the condition ${held ? 'held' : 'did not hold'}; persistence assumes tomorrow looks like today.`,
      uses: ['observed'],
    };
  },
};

export const FORECASTERS: readonly Forecaster[] = [providerForecaster, ensembleForecaster, climatologyForecaster, persistenceForecaster];
