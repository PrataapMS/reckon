import type { DailySeries } from './data';
import { addDays, calendarDistance } from './dates';

/** Spec §3.2: base rates use values within ±7 calendar days of the target date. */
export const CLIMATOLOGY_WINDOW_DAYS = 7;

/**
 * Fewer samples than this and a base rate is too noisy to choose thresholds or forecast with.
 * 45 = three seasons of ±7 days: the air-quality history only starts in Aug 2022 (ADR-0008).
 */
export const MIN_CLIMATOLOGY_SAMPLES = 45;

/** Historical values within ±windowDays of the target's calendar day, across every year in the series. */
export function seasonalSample(series: DailySeries, targetDate: string, windowDays = CLIMATOLOGY_WINDOW_DAYS): number[] {
  const out: number[] = [];
  series.values.forEach((v, i) => {
    if (v == null) return;
    const date = addDays(series.start, i);
    if (calendarDistance(date, targetDate) <= windowDays) out.push(v);
  });
  return out;
}

/** Number of distinct years with data in a series (shown in "How this is judged"). */
export function seriesYears(series: DailySeries): number {
  const years = new Set<string>();
  series.values.forEach((v, i) => {
    if (v != null) years.add(addDays(series.start, i).slice(0, 4));
  });
  return years.size;
}
