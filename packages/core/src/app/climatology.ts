import { DAILY_METRICS, type DailyMetric, type DailySeries, type Place } from '../domain/data';
import { addDays, localDate } from '../domain/dates';
import type { ClimatologyRepo, Clock, HistoryPort, Logger } from '../ports';
import { type EvidenceDeps, saveSnapshot } from './evidence';

/** Spec §3.1: climatology is cached and refreshed monthly. */
export const CLIMATOLOGY_MAX_AGE_DAYS = 30;
/** Spec §3.2: 10+ years of history. ERA5 reaches back far further; the air dataset does not (ADR-0008). */
export const CLIMATOLOGY_YEARS = 12;
/** ERA5 lags real time by about five days. */
const HISTORY_LAG_DAYS = 7;

export interface ClimatologyDeps extends EvidenceDeps {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly history: HistoryPort;
  readonly climatology: ClimatologyRepo;
}

export interface ClimatologyBundle {
  readonly series: Partial<Record<DailyMetric, DailySeries>>;
  readonly evidenceIds: Partial<Record<DailyMetric, string>>;
}

/** Grid key for the cache: ~1 km, matching how question criteria round coordinates. */
const key = (v: number) => Math.round(v * 100) / 100;

/**
 * Returns each metric's daily history for a place, refreshing anything older than a month.
 * A failed refresh keeps serving the stale copy; with no copy at all the metric is left out and
 * adaptive templates skip that day (spec §3.2 step 4).
 */
export function ensureClimatology(deps: ClimatologyDeps) {
  return async (place: Place): Promise<ClimatologyBundle> => {
    const now = deps.clock.now();
    const lat = key(place.lat);
    const lon = key(place.lon);
    const series: Partial<Record<DailyMetric, DailySeries>> = {};
    const evidenceIds: Partial<Record<DailyMetric, string>> = {};

    await Promise.all(
      DAILY_METRICS.map(async (metric) => {
        const cached = await deps.climatology.get(lat, lon, metric);
        const fresh = cached && now.getTime() - cached.refreshedAt.getTime() < CLIMATOLOGY_MAX_AGE_DAYS * 86_400_000;
        if (cached && fresh) {
          series[metric] = cached.series;
          if (cached.evidenceId) evidenceIds[metric] = cached.evidenceId;
          return;
        }
        const today = localDate(now, place.tz);
        const r = await deps.history.dailyHistory(
          { lat, lon, tz: place.tz, start: `${Number(today.slice(0, 4)) - CLIMATOLOGY_YEARS}-01-01`, end: addDays(today, -HISTORY_LAG_DAYS) },
          metric,
        );
        if (!r.ok) {
          deps.logger.warn('climatology.refresh_failed', { metric, lat, lon, code: r.error.code, stale: Boolean(cached) });
          if (cached) {
            series[metric] = cached.series;
            if (cached.evidenceId) evidenceIds[metric] = cached.evidenceId;
          }
          return;
        }
        const evidenceId = await saveSnapshot(deps, r.value, { purpose: 'climatology', metric, lat, lon });
        await deps.climatology.put(lat, lon, metric, { sourceId: r.value.sourceId, evidenceId, series: r.value.parsed });
        series[metric] = r.value.parsed;
        evidenceIds[metric] = evidenceId;
        deps.logger.info('climatology.refreshed', { metric, lat, lon, days: r.value.parsed.values.length });
      }),
    );
    return { series, evidenceIds };
  };
}
