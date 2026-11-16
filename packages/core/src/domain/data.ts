/**
 * Plain data shapes that adapters produce and pure domain code consumes. Ports re-export these;
 * they live in the domain so templates and forecasters can use them without touching ports.
 */

export interface DailyWeather {
  readonly date: string; // YYYY-MM-DD in the location's timezone
  readonly precipProbabilityMax: number | null; // 0..100
  readonly precipSumMm: number | null;
  readonly tempMaxC: number | null;
}

export interface DailyAirQuality {
  readonly date: string;
  readonly usAqiMax: number | null;
}

/** One day of an ensemble run: every member's value for each metric (nulls dropped). */
export interface EnsembleDay {
  readonly date: string;
  readonly precipSumMm: readonly number[];
  readonly tempMaxC: readonly number[];
}

/** Metrics Reckon asks daily questions about. Names match the Open-Meteo variables. */
export type DailyMetric = 'precipitation_sum' | 'temperature_2m_max' | 'us_aqi';
export const DAILY_METRICS: readonly DailyMetric[] = ['precipitation_sum', 'temperature_2m_max', 'us_aqi'];

/** A consecutive daily series starting at `start` (one value per day; null = missing). */
export interface DailySeries {
  readonly start: string;
  readonly values: readonly (number | null)[];
}

export interface Place {
  readonly id: string;
  readonly name: string;
  readonly lat: number;
  readonly lon: number;
  readonly tz: string;
}

/** Read a metric's value for a date out of the provider's daily forecast. */
export function forecastValue(
  metric: DailyMetric,
  date: string,
  weather: readonly DailyWeather[] | null,
  air: readonly DailyAirQuality[] | null,
): number | null {
  if (metric === 'us_aqi') return air?.find((d) => d.date === date)?.usAqiMax ?? null;
  const day = weather?.find((d) => d.date === date);
  if (!day) return null;
  return metric === 'precipitation_sum' ? day.precipSumMm : day.tempMaxC;
}

export function ensembleMembers(metric: DailyMetric, date: string, ensemble: readonly EnsembleDay[] | null): readonly number[] | null {
  if (metric === 'us_aqi') return null;
  const day = ensemble?.find((d) => d.date === date);
  if (!day) return null;
  const members = metric === 'precipitation_sum' ? day.precipSumMm : day.tempMaxC;
  return members.length > 0 ? members : null;
}
