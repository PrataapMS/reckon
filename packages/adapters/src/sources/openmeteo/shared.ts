import { z } from 'zod';
import type { FetchLike } from '../http';

/**
 * Open-Meteo adapters. Free for non-commercial use; attribution "Weather data by Open-Meteo.com"
 * (CC BY 4.0) must appear in the UI. See SOURCE.md in this folder for verified endpoints.
 */
export const OPEN_METEO_ATTRIBUTION = 'Weather data by Open-Meteo.com (CC BY 4.0)';

export const nums = z.array(z.number().nullable());

export interface OpenMeteoOptions {
  readonly userAgent: string;
  readonly fetchImpl?: FetchLike;
  readonly now?: () => Date;
  readonly forecastBase?: string;
  readonly airBase?: string;
}

/** Hourly values to a per-local-day maximum (times are already local because `timezone` is set). */
export function hourlyToDailyMax(times: readonly string[], values: readonly (number | null)[]): [string, number | null][] {
  const byDay = new Map<string, number | null>();
  times.forEach((t, i) => {
    const day = t.slice(0, 10);
    const v = values[i] ?? null;
    const prev = byDay.get(day) ?? null;
    byDay.set(day, v == null ? prev : prev == null ? v : Math.max(prev, v));
  });
  return [...byDay.entries()];
}

export { parse } from '../parse';
