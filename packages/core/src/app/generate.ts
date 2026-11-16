import type { DailyMetric } from '../domain/data';
import { addDays, localDate, localMinutes, timeToMinutes } from '../domain/dates';
import { FORECASTERS, type ForecastInputs, type InputKind } from '../domain/forecasters';
import { acceptsForecastAt } from '../domain/question';
import type { Result } from '../domain/result';
import { type GenerationCtx, TEMPLATES } from '../domain/templates';
import type {
  AirQualityPort,
  Clock,
  EnsemblePort,
  ForecastRepo,
  LocationRepo,
  QuestionRepo,
  SourceError,
  SourceSnapshot,
  UserRepo,
  WeatherPort,
  WorkQueue,
} from '../ports';
import { type ClimatologyDeps, ensureClimatology } from './climatology';
import { saveSnapshot } from './evidence';

export interface GenerateDeps extends ClimatologyDeps {
  readonly weather: WeatherPort;
  readonly air: AirQualityPort;
  readonly ensemble: EnsemblePort;
  readonly users: UserRepo;
  readonly locations: LocationRepo;
  readonly questions: QuestionRepo;
  readonly forecasts: ForecastRepo;
}

export interface GenerateStats {
  readonly questionsCreated: number;
  readonly questionsSeen: number;
  readonly forecastsWritten: number;
  readonly sourceErrors: readonly string[];
}

export type GenerateError = { readonly code: 'location_not_found' | 'user_not_found' };

/** Ensemble horizon must cover the longest template horizon (7 days ahead = 8 days incl. today). */
const FORECAST_DAYS = 8;
const AIR_FORECAST_DAYS = 5;

/**
 * Generate today's questions for one location and collect every applicable forecaster's
 * probability before lock (spec §1.3, 05:00). Idempotent: re-running adds only what is missing,
 * so a partial run (a source was down) is completed by the retry.
 */
export function generateForLocation(deps: GenerateDeps) {
  const climatology = ensureClimatology(deps);
  return async (locationId: string): Promise<Result<GenerateStats, GenerateError>> => {
    const location = await deps.locations.get(locationId);
    if (!location) return { ok: false, error: { code: 'location_not_found' } };
    const user = await deps.users.byId(location.userId);
    if (!user) return { ok: false, error: { code: 'user_not_found' } };

    const now = deps.clock.now();
    const today = localDate(now, location.tz);
    const base = { lat: location.lat, lon: location.lon, tz: location.tz };

    const [clim, wx, aq, ens] = await Promise.all([
      climatology(location),
      deps.weather.dailyForecast({ ...base, days: FORECAST_DAYS, pastDays: 1 }),
      deps.air.dailyForecast({ ...base, days: AIR_FORECAST_DAYS, pastDays: 1 }),
      deps.ensemble.dailyMembers({ ...base, days: FORECAST_DAYS }),
    ]);

    const sourceErrors: string[] = [];
    const evidenceIds: Partial<Record<InputKind, string[]>> = {};
    const keep = async <T>(kind: InputKind, r: Result<SourceSnapshot<T>, SourceError>): Promise<T | null> => {
      if (!r.ok) {
        sourceErrors.push(`${r.error.sourceId}:${r.error.code}`);
        deps.logger.warn('generate.source_failed', { locationId, source: r.error.sourceId, code: r.error.code });
        return null;
      }
      const id = await saveSnapshot(deps, r.value, { purpose: 'forecast', locationId });
      evidenceIds[kind] = [id];
      return r.value.parsed;
    };
    const weather = await keep('forecast', wx);
    const air = await keep('air', aq);
    const ensemble = await keep('ensemble', ens);
    const climIds = Object.values(clim.evidenceIds);
    if (climIds.length) evidenceIds.climatology = climIds;

    const yesterday = addDays(today, -1);
    const observed: Partial<Record<DailyMetric, number>> = {};
    const wy = weather?.find((d) => d.date === yesterday);
    if (wy?.precipSumMm != null) observed.precipitation_sum = wy.precipSumMm;
    if (wy?.tempMaxC != null) observed.temperature_2m_max = wy.tempMaxC;
    const ay = air?.find((d) => d.date === yesterday);
    if (ay?.usAqiMax != null) observed.us_aqi = ay.usAqiMax;
    // Yesterday's values come from the same snapshots as today's forecasts.
    evidenceIds.observed = [...(evidenceIds.forecast ?? []), ...(evidenceIds.air ?? [])];

    const ctx: GenerationCtx = { now, today, place: location, briefMinutes: timeToMinutes(user.briefTime), climatology: clim.series };
    const inputs: ForecastInputs = { weather, air, ensemble, climatology: clim.series, observed };

    let questionsCreated = 0;
    let questionsSeen = 0;
    let forecastsWritten = 0;
    for (const template of TEMPLATES) {
      for (const spec of template.candidates(ctx)) {
        const { id, created } = await deps.questions.insertIfAbsent({ ...spec, userId: user.id, locationId: location.id });
        questionsSeen++;
        if (created) questionsCreated++;
        const already = created ? new Set<string>() : new Set((await deps.forecasts.forQuestions([id])).map((f) => f.forecasterId));
        const linked = new Set<string>();
        for (const fid of template.forecasters) {
          if (already.has(fid)) continue;
          const forecaster = FORECASTERS.find((f) => f.id === fid);
          const out = forecaster?.forecast({ targetDate: spec.targetDate, meta: spec.meta }, inputs);
          if (!out) continue;
          const madeAt = deps.clock.now();
          if (!acceptsForecastAt(spec.lockAt, madeAt)) continue;
          const ids = out.uses.flatMap((k) => evidenceIds[k] ?? []);
          for (const e of ids) linked.add(e);
          await deps.forecasts.insert({ questionId: id, forecasterId: fid, p: out.p, madeAt, rationale: out.rationale, evidenceIds: ids });
          forecastsWritten++;
        }
        if (linked.size) await deps.questions.linkEvidence(id, [...linked]);
      }
    }

    const stats = { questionsCreated, questionsSeen, forecastsWritten, sourceErrors };
    deps.logger.info('generate.done', { locationId, today, ...stats });
    return { ok: true, value: stats };
  };
}

/** Generation runs from two hours before the user's brief time (spec: 05:00 for a 06:30 brief). */
export const GENERATE_LEAD_MINUTES = 120;

/**
 * Enqueue one `generate` work item per location once its local day's generation is due. The
 * dedupe key makes this safe to call from every tick and from the dedicated `generate` job.
 */
export function enqueueDueGeneration(deps: { clock: Clock; users: UserRepo; locations: LocationRepo; queue: WorkQueue }) {
  return async (): Promise<number> => {
    const now = deps.clock.now();
    const users = new Map((await deps.users.all()).map((u) => [u.id, u]));
    let enqueued = 0;
    for (const loc of await deps.locations.all()) {
      const user = users.get(loc.userId);
      if (!user) continue;
      if (localMinutes(now, loc.tz) < timeToMinutes(user.briefTime) - GENERATE_LEAD_MINUTES) continue;
      const today = localDate(now, loc.tz);
      await deps.queue.enqueue('generate', { locationId: loc.id }, { dedupeKey: `generate:${loc.id}:${today}`, maxAttempts: 4 });
      enqueued++;
    }
    return enqueued;
  };
}
