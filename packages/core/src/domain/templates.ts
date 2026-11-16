import { MIN_CLIMATOLOGY_SAMPLES, seasonalSample } from './climatology';
import type { Criteria, ThresholdCriteria } from './criteria';
import type { DailyMetric, DailySeries, Place } from './data';
import { addDays, humanDate, isoWithOffset, localDayWindow, zonedTimeToUtc } from './dates';
import { baseRate, selectThreshold, type ThresholdCandidate } from './threshold';

/**
 * Question templates (spec §3.2). A template is a pure recipe: given a location, the local date
 * and its climatology, it proposes questions with frozen criteria. Adding a topic means adding a
 * template here and an adapter, not changing use cases (G6).
 */

export type Domain = 'weather' | 'air' | 'money' | 'tech' | 'world' | 'life';
export type TemplateClass = 'decision' | 'informative';
export type ForecasterId = 'provider.openmeteo@1' | 'ensemble.openmeteo@1' | 'climatology@1' | 'persistence@1' | 'history.rate@1' | 'provider.swpc@1';
export type ResolverId =
  | 'openmeteo.daily@1'
  | 'frankfurter.compare@1'
  | 'usgs.count@1'
  | 'swpc.kp_max@1'
  | 'github.releases@1'
  | 'statuspage.incidents@1'
  | 'gdelt.volume@1';
export type Comparator = '>' | '>=' | '<' | '<=';

/** The base-rate forecasters every skill score is measured against (spec §3.5), one per question. */
export const REFERENCE_FORECASTERS: readonly ForecasterId[] = ['climatology@1', 'history.rate@1'];

export interface UserSettings {
  readonly actionThresholds?: { readonly rain?: number; readonly aqi?: number };
}

export interface GenerationCtx {
  readonly now: Date;
  readonly today: string; // local date at the location when generation runs
  readonly place: Place;
  readonly briefMinutes: number; // user's brief time, minutes after local midnight
  readonly climatology: Partial<Record<DailyMetric, DailySeries>>;
}

interface QuestionMetaBase {
  readonly subject: string; // 'Rain ≥ 1 mm'
  readonly placeName: string; // 'Home', or the subject's context for world questions ('Worldwide', 'nodejs/node')
  readonly class: TemplateClass;
  readonly baseRate?: number; // the historical rate used to pick the threshold
}

/** A daily question about a place: what weather and air forecasters need, also stored as `questions.meta`. */
export interface DailyQuestionMeta extends QuestionMetaBase {
  readonly metric: DailyMetric;
  readonly comparator: Comparator;
  readonly threshold: number;
  readonly unit: string;
}

/** A question about the wider world (money, tech, space, news); not tied to a location. */
export interface WorldQuestionMeta extends QuestionMetaBase {
  readonly scope: 'world';
  /** Unit of the observed value, plural ('quakes', 'releases', 'Kp'). */
  readonly unit: string;
  /** News tags that link headlines to this question (spec §3.6 step 5). */
  readonly tags: readonly string[];
  /** One question per slot (e.g. one repo per week), however often generation runs. */
  readonly slot: string;
}

export type QuestionMeta = DailyQuestionMeta | WorldQuestionMeta;

export function isWorldMeta(m: QuestionMeta): m is WorldQuestionMeta {
  return 'scope' in m && m.scope === 'world';
}

export interface QuestionSpec<M extends QuestionMeta = QuestionMeta, C extends Criteria = Criteria> {
  readonly templateId: string;
  readonly templateVersion: number;
  readonly domain: Domain;
  readonly title: string;
  readonly criteria: C;
  readonly horizonDays: number;
  readonly targetDate: string;
  readonly correlationGroup: string;
  readonly lockAt: Date;
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly meta: M;
}

/** What every template shares, whatever it is about (spec §3.2). */
export interface TemplateInfo {
  readonly id: string;
  readonly version: number;
  readonly domain: Domain;
  readonly class: TemplateClass;
  readonly horizons: readonly number[];
  readonly resolver: ResolverId;
  readonly forecasters: readonly ForecasterId[];
  /** Spec §3.3 defaults before champion selection: ensemble (weather), provider (air), history.rate (events). */
  readonly champion: ForecasterId;
  readonly dailyBudget: number;
  readonly description: string;
  /** The concrete action for a decision question, given the shown probability. */
  action?(p: number, settings: UserSettings): string;
}

/** A template about a place, run once per location per day. */
export interface QuestionTemplate extends TemplateInfo {
  candidates(ctx: GenerationCtx): QuestionSpec<DailyQuestionMeta, ThresholdCriteria>[];
}

/** Spec §3.4: give up and annul if the source has not answered 72 h after the window closes. */
export const RETRY_UNTIL_HOURS = 72;
/** Lock never earlier than this after generation, so all forecasters can write before lock. */
const MIN_LOCK_LEAD_MS = 15 * 60_000;

/** Same date and roughly the same region (~1° grid) share a cluster for the bootstrap. */
export function correlationGroup(date: string, lat: number, lon: number): string {
  return `${date}:${Math.round(lat)}:${Math.round(lon)}`;
}

/**
 * Lock at the user's brief time on the generation day, so the brief shows exactly what is scored.
 * If generation runs late, lock shortly after it. Returns undefined if the window would already
 * have started.
 */
export function lockTime(ctx: GenerationCtx, windowStart: Date): Date | undefined {
  return lockFor({ now: ctx.now, today: ctx.today, briefMinutes: ctx.briefMinutes, tz: ctx.place.tz }, windowStart);
}

export function lockFor(c: { now: Date; today: string; briefMinutes: number; tz: string }, windowStart: Date): Date | undefined {
  const brief = zonedTimeToUtc(c.today, c.briefMinutes, c.tz);
  const earliest = new Date(c.now.getTime() + MIN_LOCK_LEAD_MS);
  const lock = brief.getTime() > earliest.getTime() ? brief : earliest;
  return lock.getTime() <= windowStart.getTime() ? lock : undefined;
}

export const SYMBOL: Record<Comparator, string> = { '>': '>', '>=': '≥', '<': '<', '<=': '≤' };

export function meets(value: number, comparator: Comparator, threshold: number): boolean {
  switch (comparator) {
    case '>':
      return value > threshold;
    case '>=':
      return value >= threshold;
    case '<':
      return value < threshold;
    case '<=':
      return value <= threshold;
  }
}

interface MetricInfo {
  readonly unit: string;
  readonly sourceId: string;
  readonly aggregation: ThresholdCriteria['aggregation'];
  readonly subject: (comparator: Comparator, t: number) => string;
}

export const METRICS: Record<DailyMetric, MetricInfo> = {
  precipitation_sum: {
    unit: 'mm',
    sourceId: 'openmeteo.forecast',
    aggregation: 'daily_sum',
    subject: (c, t) => `Rain ${SYMBOL[c]} ${t} mm`,
  },
  temperature_2m_max: {
    unit: '°C',
    sourceId: 'openmeteo.forecast',
    aggregation: 'daily_max',
    subject: (c, t) => `High ${SYMBOL[c]} ${t} °C`,
  },
  us_aqi: {
    unit: 'US AQI',
    sourceId: 'openmeteo.air_quality',
    aggregation: 'daily_max',
    subject: (c, t) => `US AQI peak ${SYMBOL[c]} ${t}`,
  },
};

interface ThresholdTemplateDef {
  readonly id: string;
  readonly version: number;
  readonly domain: Domain;
  readonly class: TemplateClass;
  readonly horizons: readonly number[];
  readonly metric: DailyMetric;
  readonly comparator: Comparator;
  readonly forecasters: readonly ForecasterId[];
  readonly champion: ForecasterId;
  readonly description: string;
  /** Decision templates: one fixed, human-meaningful threshold. */
  readonly fixedThreshold?: number;
  /** Informative templates: the ladder to choose from by base rate (spec §3.2). */
  readonly ladder?: (sample: readonly number[]) => readonly number[];
  readonly action?: (p: number, settings: UserSettings) => string;
}

function chooseThreshold(def: ThresholdTemplateDef, ctx: GenerationCtx, targetDate: string): { threshold: number; baseRate?: number } | undefined {
  if (def.fixedThreshold !== undefined) return { threshold: def.fixedThreshold };
  const series = ctx.climatology[def.metric];
  if (!series || !def.ladder) return undefined;
  const sample = seasonalSample(series, targetDate);
  if (sample.length < MIN_CLIMATOLOGY_SAMPLES) return undefined;
  const candidates: ThresholdCandidate[] = def.ladder(sample).map((value) => ({
    value,
    baseRate: baseRate(sample, (v) => meets(v, def.comparator, value)),
    decisionWeight: value,
  }));
  const pick = selectThreshold(candidates);
  return pick ? { threshold: pick.value, baseRate: pick.baseRate } : undefined;
}

export function thresholdTemplate(def: ThresholdTemplateDef): QuestionTemplate {
  const info = METRICS[def.metric];
  return {
    id: def.id,
    version: def.version,
    domain: def.domain,
    class: def.class,
    horizons: def.horizons,
    resolver: 'openmeteo.daily@1',
    forecasters: def.forecasters,
    champion: def.champion,
    dailyBudget: def.horizons.length,
    description: def.description,
    ...(def.action ? { action: def.action } : {}),
    candidates(ctx) {
      const out: QuestionSpec<DailyQuestionMeta, ThresholdCriteria>[] = [];
      const lat = Math.round(ctx.place.lat * 100) / 100;
      const lon = Math.round(ctx.place.lon * 100) / 100;
      for (const h of def.horizons) {
        const targetDate = addDays(ctx.today, h);
        const { start, end } = localDayWindow(targetDate, ctx.place.tz);
        const lockAt = lockTime(ctx, start);
        if (!lockAt) continue;
        const chosen = chooseThreshold(def, ctx, targetDate);
        if (!chosen) continue; // spec §3.2 step 4: no threshold qualifies, skip today
        const subject = info.subject(def.comparator, chosen.threshold);
        out.push({
          templateId: def.id,
          templateVersion: def.version,
          domain: def.domain,
          title: `${subject} at ${ctx.place.name} on ${humanDate(targetDate)}`,
          criteria: {
            kind: 'threshold',
            source: { id: info.sourceId, version: '1' },
            missingPolicy: { retryUntilHours: RETRY_UNTIL_HOURS, thenOutcome: 'annul' },
            metric: def.metric,
            unit: info.unit,
            lat,
            lon,
            aggregation: info.aggregation,
            comparator: def.comparator,
            threshold: chosen.threshold,
            window: { start: isoWithOffset(start, ctx.place.tz), end: isoWithOffset(end, ctx.place.tz), tz: ctx.place.tz },
          },
          horizonDays: h,
          targetDate,
          correlationGroup: correlationGroup(targetDate, lat, lon),
          lockAt,
          windowStart: start,
          windowEnd: end,
          meta: {
            metric: def.metric,
            comparator: def.comparator,
            threshold: chosen.threshold,
            unit: info.unit,
            subject,
            placeName: ctx.place.name,
            class: def.class,
            ...(chosen.baseRate !== undefined ? { baseRate: chosen.baseRate } : {}),
          },
        });
      }
      return out;
    },
  };
}

const RAIN_LADDER = [0.2, 1, 2.5, 5, 10, 20, 50];
const AQI_LADDER = [50, 100, 150, 200, 300];
const RAIN_DECISION_MM = 1;
const AQI_DECISION = 150;
const DEFAULT_ACTION_AT = 0.5;

const WEATHER_FORECASTERS: readonly ForecasterId[] = ['provider.openmeteo@1', 'ensemble.openmeteo@1', 'climatology@1', 'persistence@1'];
const AIR_FORECASTERS: readonly ForecasterId[] = ['provider.openmeteo@1', 'climatology@1', 'persistence@1'];

export const TEMPLATES: readonly QuestionTemplate[] = [
  thresholdTemplate({
    id: 'wx.rain_any',
    version: 1,
    domain: 'weather',
    class: 'decision',
    horizons: [1, 3],
    metric: 'precipitation_sum',
    comparator: '>=',
    fixedThreshold: RAIN_DECISION_MM,
    forecasters: WEATHER_FORECASTERS,
    champion: 'ensemble.openmeteo@1',
    description: 'Will at least 1 mm of rain fall? Drives the umbrella tip.',
    action: (p, s) => (p >= (s.actionThresholds?.rain ?? DEFAULT_ACTION_AT) ? 'Take an umbrella' : 'No umbrella needed'),
  }),
  thresholdTemplate({
    id: 'wx.rain_adaptive',
    version: 1,
    domain: 'weather',
    class: 'informative',
    horizons: [1, 3, 7],
    metric: 'precipitation_sum',
    comparator: '>=',
    // The decision threshold is excluded so the same claim is not asked twice.
    ladder: () => RAIN_LADDER.filter((v) => v !== RAIN_DECISION_MM),
    forecasters: WEATHER_FORECASTERS,
    champion: 'ensemble.openmeteo@1',
    description: 'A rain amount chosen so it happens about half the time at this time of year.',
  }),
  thresholdTemplate({
    id: 'wx.tmax_adaptive',
    version: 1,
    domain: 'weather',
    class: 'informative',
    horizons: [1, 3, 7],
    metric: 'temperature_2m_max',
    comparator: '>=',
    ladder: (sample) => {
      const lo = Math.floor(Math.min(...sample));
      const hi = Math.ceil(Math.max(...sample));
      return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
    },
    forecasters: WEATHER_FORECASTERS,
    champion: 'ensemble.openmeteo@1',
    description: 'A whole-degree high temperature chosen so it is reached about half the time.',
  }),
  thresholdTemplate({
    id: 'air.aqi_decision',
    version: 1,
    domain: 'air',
    class: 'decision',
    horizons: [1],
    metric: 'us_aqi',
    comparator: '>',
    fixedThreshold: AQI_DECISION,
    forecasters: AIR_FORECASTERS,
    champion: 'provider.openmeteo@1',
    description: 'Will air quality be unhealthy (US AQI above 150) at some hour? Drives the mask tip.',
    action: (p, s) => (p >= (s.actionThresholds?.aqi ?? DEFAULT_ACTION_AT) ? 'Consider a mask outdoors' : 'Air looks fine for outdoor plans'),
  }),
  thresholdTemplate({
    id: 'air.aqi_adaptive',
    version: 1,
    domain: 'air',
    class: 'informative',
    horizons: [1, 3],
    metric: 'us_aqi',
    comparator: '>',
    ladder: () => AQI_LADDER.filter((v) => v !== AQI_DECISION),
    forecasters: AIR_FORECASTERS,
    champion: 'provider.openmeteo@1',
    description: 'A US AQI level chosen so it is exceeded about half the time at this time of year.',
  }),
];
