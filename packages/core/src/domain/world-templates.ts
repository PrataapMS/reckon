import { type Criteria, canonicalJson } from './criteria';
import { addDays, daysBetween, humanDate, isoWithOffset, localDate, zonedTimeToUtc } from './dates';
import { type ForecasterId, lockFor, type QuestionSpec, RETRY_UNTIL_HOURS, type TemplateInfo, type WorldQuestionMeta } from './templates';
import { selectThreshold } from './threshold';
import { gdeltQuery, type TopicRef } from './topics';
import {
  type FxRate,
  type GeomagDay,
  type GeomagForecast,
  INCIDENT_IMPACTS,
  type IncidentImpact,
  type IncidentList,
  type KpPoint,
  type Quake,
  type ReleaseList,
  type VolumePoint,
} from './world-data';
import { historyRate, MAX_HISTORY_WINDOWS, type WindowHistory, type WorldForecastInputs } from './world-forecasters';

/**
 * World templates (spec §3.2, Phase 2): questions about money, tech, space and the news, asked
 * once per user rather than per place. Each template is pure: it says which data it needs, then
 * turns that data into questions with frozen criteria plus the inputs its forecasters read. The
 * history of comparable past windows is worked out here, so `history.rate@1` and persistence
 * stay generic. Windows and thresholds are explained in ADR-0009.
 */

export interface WatchedRepo {
  readonly repo: string; // 'owner/name'
  readonly label: string;
  readonly keywords: readonly string[];
}

export interface WatchedService {
  readonly host: string; // Statuspage host
  readonly label: string;
  readonly keywords: readonly string[];
}

export interface WatchList {
  readonly repos: readonly WatchedRepo[];
  readonly services: readonly WatchedService[];
}

/** Repos and status pages whose weekly base rates were near 50% when checked (2026-10-05; ADR-0009). */
export const DEFAULT_WATCH: WatchList = {
  repos: [
    { repo: 'nodejs/node', label: 'Node.js', keywords: ['node.js', 'nodejs'] },
    { repo: 'denoland/deno', label: 'Deno', keywords: ['deno'] },
    { repo: 'vitejs/vite', label: 'Vite', keywords: ['vite'] },
    { repo: 'oven-sh/bun', label: 'Bun', keywords: ['bun.js', 'bun runtime', 'oven-sh/bun'] },
    { repo: 'kubernetes/kubernetes', label: 'Kubernetes', keywords: ['kubernetes', 'k8s'] },
    { repo: 'rust-lang/rust', label: 'Rust', keywords: ['rust-lang', 'rust compiler', 'rust 1.'] },
  ],
  services: [
    { host: 'www.githubstatus.com', label: 'GitHub', keywords: ['github'] },
    { host: 'www.netlifystatus.com', label: 'Netlify', keywords: ['netlify'] },
    { host: 'status.npmjs.org', label: 'npm', keywords: ['npm'] },
  ],
};

export interface WorldCtx {
  readonly now: Date;
  readonly today: string; // the user's local date
  readonly tz: string; // the user's timezone
  readonly briefMinutes: number;
  readonly topics: readonly TopicRef[];
  readonly watch: WatchList;
}

/** Data a world template asks for; the generate use case fetches each through its port. */
export type WorldNeed =
  | { readonly kind: 'fx'; readonly base: string; readonly quote: string; readonly start: string; readonly end: string }
  | { readonly kind: 'quakes'; readonly minMagnitude: number; readonly start: string; readonly end: string }
  | { readonly kind: 'kp.history'; readonly start: string; readonly end: string }
  | { readonly kind: 'kp.forecast' }
  | { readonly kind: 'releases'; readonly repo: string }
  | { readonly kind: 'incidents'; readonly host: string }
  | { readonly kind: 'news.volume'; readonly query: string; readonly start: string; readonly end: string };

export interface WorldNeedData {
  readonly fx: readonly FxRate[];
  readonly quakes: readonly Quake[];
  readonly 'kp.history': readonly KpPoint[];
  readonly 'kp.forecast': GeomagForecast;
  readonly releases: ReleaseList;
  readonly incidents: IncidentList;
  readonly 'news.volume': readonly VolumePoint[];
}

export type NeedKind = WorldNeed['kind'];
export type NeedOf<K extends NeedKind> = Extract<WorldNeed, { kind: K }>;

export interface WorldData {
  get<K extends NeedKind>(need: NeedOf<K>): WorldNeedData[K] | undefined;
}

export function needKey(need: WorldNeed): string {
  return canonicalJson(need);
}

export interface WorldCandidate {
  readonly spec: QuestionSpec<WorldQuestionMeta>;
  readonly inputs: WorldForecastInputs;
  /** Which fetched snapshots each kind of input came from, so every forecast cites its evidence. */
  readonly evidence: { readonly history: readonly WorldNeed[]; readonly provider: readonly WorldNeed[] };
}

export interface WorldTemplate extends TemplateInfo {
  readonly scope: 'world';
  appliesTo(ctx: WorldCtx): boolean;
  needs(ctx: WorldCtx): WorldNeed[];
  candidates(ctx: WorldCtx, data: WorldData): WorldCandidate[];
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MISSING = { retryUntilHours: RETRY_UNTIL_HOURS, thenOutcome: 'annul' as const };

interface Span {
  readonly start: Date;
  readonly end: Date;
}

const isMonday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay() === 1;
const utcDate = (at: Date) => at.toISOString().slice(0, 10);
const briefInstant = (ctx: WorldCtx) => zonedTimeToUtc(ctx.today, ctx.briefMinutes, ctx.tz);

/**
 * "This week": from Monday's brief until the end of Sunday, local time. The start is the brief
 * time itself, so the window is the same however often generation runs; a generation after the
 * brief skips the week rather than shifting it.
 */
function weekWindow(ctx: WorldCtx): (Span & { readonly target: string }) | undefined {
  if (!isMonday(ctx.today)) return undefined;
  return { start: briefInstant(ctx), end: zonedTimeToUtc(addDays(ctx.today, 7), 0, ctx.tz), target: addDays(ctx.today, 6) };
}

/** The `count` windows before `w`, shifted by whole steps, oldest first. */
function pastWindows(w: Span, step: number, count = MAX_HISTORY_WINDOWS): Span[] {
  const out: Span[] = [];
  for (let k = count; k >= 1; k--) out.push({ start: new Date(w.start.getTime() - k * step), end: new Date(w.end.getTime() - k * step) });
  return out;
}

const within = (iso: string, w: Span) => {
  const t = Date.parse(iso);
  return t >= w.start.getTime() && t < w.end.getTime();
};

function criteriaWindow(w: Span, tz: string) {
  return { start: isoWithOffset(w.start, tz), end: isoWithOffset(w.end, tz), tz };
}

/** Monday of the UTC week containing a date: the cluster for questions about that week. */
function weekOf(date: string): string {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDays(date, -((day + 6) % 7));
}

interface SpecArgs {
  readonly title: string;
  readonly subject: string;
  readonly placeName: string;
  readonly unit: string;
  readonly tags: readonly string[];
  readonly slot: string;
  readonly criteria: Criteria;
  readonly window: Span;
  readonly target: string;
  readonly group: string;
  readonly baseRate: number;
}

function spec(t: TemplateInfo, ctx: WorldCtx, a: SpecArgs): QuestionSpec<WorldQuestionMeta> | undefined {
  const lockAt = lockFor(ctx, a.window.start);
  if (!lockAt) return undefined;
  return {
    templateId: t.id,
    templateVersion: t.version,
    domain: t.domain,
    title: a.title,
    criteria: a.criteria,
    horizonDays: daysBetween(ctx.today, a.target),
    targetDate: a.target,
    correlationGroup: a.group,
    lockAt,
    windowStart: a.window.start,
    windowEnd: a.window.end,
    meta: { scope: 'world', subject: a.subject, placeName: a.placeName, class: t.class, unit: a.unit, tags: a.tags, slot: a.slot, baseRate: a.baseRate },
  };
}

/** Pick the rung whose recent base rate is nearest 50% within [25%, 75%] (spec §3.2), ties to the higher rung. */
function chooseRung(histories: readonly { readonly value: number; readonly history: WindowHistory }[]) {
  const rated = histories.flatMap((h) => {
    const r = historyRate(h.history);
    return r ? [{ value: h.value, baseRate: r.rate, decisionWeight: h.value, history: h.history }] : [];
  });
  const pick = selectThreshold(rated);
  return pick ? rated.find((r) => r.value === pick.value) : undefined;
}

const HISTORY_FORECASTERS: readonly ForecasterId[] = ['history.rate@1', 'persistence@1'];

const base = {
  scope: 'world' as const,
  class: 'informative' as const,
  champion: 'history.rate@1' as const,
  forecasters: HISTORY_FORECASTERS,
};

// ---------------------------------------------------------------------------
// fx.usdinr_week — the efficient-market control (spec §3.5)
// ---------------------------------------------------------------------------

const FX = { base: 'USD', quote: 'INR', label: 'USD/INR' };
/** ECB rates are set around 14:10 CET and published around 16:00 CET (ADR-0009). */
const ECB_SET_UTC_HOUR = 12;
const ECB_PUBLISHED_UTC_HOUR = 16;

function fxNeed(ctx: WorldCtx): NeedOf<'fx'> {
  return { kind: 'fx', base: FX.base, quote: FX.quote, start: addDays(ctx.today, -7 * (MAX_HISTORY_WINDOWS + 1)), end: addDays(ctx.today, -1) };
}

export const fxUsdInrWeek: WorldTemplate = {
  ...base,
  id: 'fx.usdinr_week',
  version: 1,
  domain: 'money',
  horizons: [4],
  resolver: 'frankfurter.compare@1',
  dailyBudget: 1,
  description: 'Is the USD/INR reference rate higher on Friday than on Monday? A control: nobody should beat a coin flip here for long.',
  appliesTo: (ctx) => isMonday(ctx.today),
  needs: (ctx) => (isMonday(ctx.today) ? [fxNeed(ctx)] : []),
  candidates(ctx, data) {
    if (!isMonday(ctx.today)) return [];
    const need = fxNeed(ctx);
    const rates = data.get(need);
    if (!rates) return [];
    const byDate = new Map(rates.map((r) => [r.date, r.rate]));
    const outcomes: boolean[] = [];
    for (let k = MAX_HISTORY_WINDOWS; k >= 1; k--) {
      const mon = addDays(ctx.today, -7 * k);
      const a = byDate.get(mon);
      const b = byDate.get(addDays(mon, 4));
      if (a != null && b != null) outcomes.push(b > a);
    }
    const history: WindowHistory = { outcomes, unit: 'weeks' };
    const rate = historyRate(history);
    if (!rate) return [];
    const friday = addDays(ctx.today, 4);
    const window = {
      start: new Date(`${ctx.today}T${String(ECB_SET_UTC_HOUR).padStart(2, '0')}:00:00Z`),
      end: new Date(`${friday}T${ECB_PUBLISHED_UTC_HOUR}:00:00Z`),
    };
    const s = spec(this, ctx, {
      title: `${FX.label} reference rate higher on ${humanDate(friday)} than on ${humanDate(ctx.today)}`,
      subject: `${FX.label} higher Friday than Monday`,
      placeName: 'ECB reference rate',
      unit: 'INR change',
      tags: ['fx:usdinr'],
      slot: `fx:${ctx.today}`,
      criteria: {
        kind: 'compare',
        source: { id: 'frankfurter', version: '1' },
        missingPolicy: MISSING,
        metric: FX.label,
        a: { at: ctx.today },
        b: { at: friday },
        comparator: '>',
      },
      window,
      target: friday,
      group: `fx:${ctx.today}`,
      baseRate: rate.rate,
    });
    return s ? [{ spec: s, inputs: { history }, evidence: { history: [need], provider: [] } }] : [];
  },
};

// ---------------------------------------------------------------------------
// world.quake_m6_week — strong earthquakes anywhere
// ---------------------------------------------------------------------------

/** M6+ happens in about 90% of weeks, so the rung is chosen by base rate (ADR-0009). */
const QUAKE_LADDER = [6, 6.5, 7];

function quakeNeed(w: Span, ctx: WorldCtx): NeedOf<'quakes'> {
  return {
    kind: 'quakes',
    minMagnitude: QUAKE_LADDER[0] as number,
    start: new Date(w.start.getTime() - (MAX_HISTORY_WINDOWS + 1) * WEEK).toISOString(),
    end: ctx.now.toISOString(),
  };
}

export const worldQuakeWeek: WorldTemplate = {
  ...base,
  id: 'world.quake_m6_week',
  version: 1,
  domain: 'world',
  horizons: [6],
  resolver: 'usgs.count@1',
  dailyBudget: 1,
  description: 'Will the USGS record at least one strong earthquake anywhere this week? The magnitude is chosen so it happens about half the time.',
  appliesTo: (ctx) => isMonday(ctx.today),
  needs(ctx) {
    const w = weekWindow(ctx);
    return w ? [quakeNeed(w, ctx)] : [];
  },
  candidates(ctx, data) {
    const w = weekWindow(ctx);
    if (!w) return [];
    const need = quakeNeed(w, ctx);
    const quakes = data.get(need);
    if (!quakes) return [];
    const windows = pastWindows(w, WEEK);
    const pick = chooseRung(
      QUAKE_LADDER.map((m) => ({
        value: m,
        history: { outcomes: windows.map((pw) => quakes.some((q) => q.magnitude >= m && within(q.time, pw))), unit: 'weeks' },
      })),
    );
    if (!pick) return [];
    const s = spec(this, ctx, {
      title: `At least one M${pick.value}+ earthquake worldwide by ${humanDate(w.target)}`,
      subject: `An M${pick.value}+ earthquake somewhere`,
      placeName: 'Worldwide',
      unit: 'quakes',
      tags: ['quake'],
      slot: `quake:${ctx.today}`,
      criteria: {
        kind: 'count',
        source: { id: 'usgs.earthquake', version: '1' },
        missingPolicy: MISSING,
        filter: { minMagnitude: pick.value, region: 'worldwide', eventType: 'earthquake' },
        comparator: '>=',
        threshold: 1,
        window: criteriaWindow(w, ctx.tz),
      },
      window: w,
      target: w.target,
      group: `quake:${ctx.today}`,
      baseRate: pick.baseRate,
    });
    return s ? [{ spec: s, inputs: { history: pick.history }, evidence: { history: [need], provider: [] } }] : [];
  },
};

// ---------------------------------------------------------------------------
// space.kp_storm_3d — geomagnetic activity in the next three days
// ---------------------------------------------------------------------------

/** Kp ≥ 5 is a G1 storm. In quieter seasons the rung drops to 4 so the question stays informative. */
const KP_LADDER = [4, 5, 6];
const KP_WINDOW = 72 * HOUR;
const KP_SLOT = 3 * HOUR;
/** A window counts only if most of its 24 three-hour slots were reported. */
const KP_MIN_SLOTS = 20;
const KP_LABEL: Record<number, string> = { 4: 'Kp reaches 4 (active)', 5: 'Kp reaches 5 (G1 storm)', 6: 'Kp reaches 6 (G2 storm)' };

/** The 72 hours from the first 3-hour UT slot at or after the brief. */
function kpWindow(ctx: WorldCtx): Span {
  const t = briefInstant(ctx).getTime();
  const start = Math.ceil(t / KP_SLOT) * KP_SLOT;
  return { start: new Date(start), end: new Date(start + KP_WINDOW) };
}

function kpHistoryNeed(w: Span, ctx: WorldCtx): NeedOf<'kp.history'> {
  return { kind: 'kp.history', start: new Date(w.start.getTime() - (MAX_HISTORY_WINDOWS + 2) * KP_WINDOW).toISOString(), end: ctx.now.toISOString() };
}
const KP_FORECAST: NeedOf<'kp.forecast'> = { kind: 'kp.forecast' };

/** Highest Kp in a window, or undefined when too few slots were reported. */
export function kpMax(points: readonly KpPoint[], w: Span): number | undefined {
  const inside = points.filter((p) => within(p.time, w));
  if (inside.length < KP_MIN_SLOTS) return undefined;
  return Math.max(...inside.map((p) => p.kp));
}

/** Chance that a day's highest level is at least Kp `t`: SWPC's categories are separate, so they add up. */
function dayChance(d: GeomagDay, t: number): number {
  const p =
    t <= 4 ? d.pActive + d.pMinor + d.pModerate + d.pStrong : t === 5 ? d.pMinor + d.pModerate + d.pStrong : t === 6 ? d.pModerate + d.pStrong : d.pStrong;
  return Math.min(0.99, p);
}

/**
 * NOAA's daily probabilities combined over the window, weighting each UT day by how much of it
 * falls inside and treating days as independent. Needs the forecast to cover half the window.
 */
export function swpcWindowChance(f: GeomagForecast, w: Span, t: number): { readonly p: number; readonly rationale: string } | undefined {
  let miss = 1;
  let covered = 0;
  const parts: string[] = [];
  for (const d of f.days) {
    const dayStart = Date.parse(`${d.date}T00:00:00Z`);
    const overlap = Math.max(0, Math.min(w.end.getTime(), dayStart + DAY) - Math.max(w.start.getTime(), dayStart)) / DAY;
    if (overlap <= 0) continue;
    const p = dayChance(d, t);
    miss *= 1 - p * overlap;
    covered += overlap * DAY;
    parts.push(`${Math.round(p * 100)}% on ${humanDate(d.date)}`);
  }
  if (covered < (w.end.getTime() - w.start.getTime()) / 2) return undefined;
  return {
    p: 1 - miss,
    rationale: `NOAA SWPC's forecast issued ${f.issuedAt.slice(0, 16).replace('T', ' ')} UTC gives Kp ${t}+ chances of ${parts.join(', ')}; combined over the window.`,
  };
}

export const spaceKpStorm3d: WorldTemplate = {
  ...base,
  id: 'space.kp_storm_3d',
  version: 1,
  domain: 'world',
  horizons: [3],
  resolver: 'swpc.kp_max@1',
  forecasters: [...HISTORY_FORECASTERS, 'provider.swpc@1'],
  dailyBudget: 1,
  description: 'Will the planetary Kp index reach a storm level in the next three days? NOAA publishes its own probabilities, scored here too.',
  appliesTo: () => true,
  needs(ctx) {
    return [kpHistoryNeed(kpWindow(ctx), ctx), KP_FORECAST];
  },
  candidates(ctx, data) {
    const w = kpWindow(ctx);
    const need = kpHistoryNeed(w, ctx);
    const points = data.get(need);
    if (!points?.length) return [];
    const lastSlotEnd = Math.max(...points.map((p) => Date.parse(p.time))) + KP_SLOT;
    const windows = pastWindows(w, KP_WINDOW, MAX_HISTORY_WINDOWS + 2).filter((pw) => pw.end.getTime() <= lastSlotEnd);
    const maxima = windows.map((pw) => kpMax(points, pw)).filter((m): m is number => m !== undefined);
    const pick = chooseRung(KP_LADDER.map((t) => ({ value: t, history: { outcomes: maxima.map((m) => m >= t), unit: '3-day windows' } })));
    if (!pick) return [];
    const forecast = data.get(KP_FORECAST);
    const provider = forecast ? swpcWindowChance(forecast, w, pick.value) : undefined;
    const target = localDate(new Date(w.end.getTime() - 1), ctx.tz);
    const subject = KP_LABEL[pick.value] ?? `Kp reaches ${pick.value}`;
    const s = spec(this, ctx, {
      title: `${subject} between ${w.start.toISOString().slice(0, 16).replace('T', ' ')} and ${w.end.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
      subject,
      placeName: 'Planetary',
      unit: 'Kp',
      tags: ['space-weather'],
      slot: `kp:${w.start.toISOString()}`,
      criteria: {
        kind: 'threshold',
        source: { id: 'swpc.kp', version: '1' },
        missingPolicy: MISSING,
        metric: 'kp',
        unit: 'Kp',
        aggregation: 'max_over_window',
        comparator: '>=',
        threshold: pick.value,
        window: criteriaWindow(w, 'UTC'),
      },
      window: w,
      target,
      group: `kp:${weekOf(utcDate(w.start))}`,
      baseRate: pick.baseRate,
    });
    return s ? [{ spec: s, inputs: { history: pick.history, ...(provider ? { provider } : {}) }, evidence: { history: [need], provider: [KP_FORECAST] } }] : [];
  },
};

// ---------------------------------------------------------------------------
// tech.release_week — watched repos shipping a stable release
// ---------------------------------------------------------------------------

/** Only windows the listing fully covers count: a full page hides anything older than its last entry. */
function covered(list: { readonly complete: boolean }, oldest: string | undefined, w: Span): boolean {
  return list.complete || (oldest !== undefined && Date.parse(oldest) <= w.start.getTime());
}

/** Keep subjects whose base rate is in [25%, 75%], nearest 50% first. */
function informative<T extends { readonly rate: number }>(xs: readonly T[], budget: number): T[] {
  return xs
    .filter((x) => x.rate >= 0.25 && x.rate <= 0.75)
    .sort((a, b) => Math.abs(a.rate - 0.5) - Math.abs(b.rate - 0.5))
    .slice(0, budget);
}

export const techReleaseWeek: WorldTemplate = {
  ...base,
  id: 'tech.release_week',
  version: 1,
  domain: 'tech',
  horizons: [6],
  resolver: 'github.releases@1',
  dailyBudget: 3,
  description: 'Will a watched open-source project publish a stable GitHub release this week? Projects are picked when they release about half the weeks.',
  appliesTo: (ctx) => isMonday(ctx.today),
  needs: (ctx) => (isMonday(ctx.today) ? ctx.watch.repos.map((r) => ({ kind: 'releases' as const, repo: r.repo })) : []),
  candidates(ctx, data) {
    const w = weekWindow(ctx);
    if (!w) return [];
    const rated = ctx.watch.repos.flatMap((r) => {
      const need: NeedOf<'releases'> = { kind: 'releases', repo: r.repo };
      const list = data.get(need);
      if (!list) return [];
      const stable = list.releases.filter((x) => !x.prerelease);
      const oldest = list.releases.at(-1)?.publishedAt;
      const outcomes = pastWindows(w, WEEK)
        .filter((pw) => covered(list, oldest, pw))
        .map((pw) => stable.some((x) => within(x.publishedAt, pw)));
      const history: WindowHistory = { outcomes, unit: 'weeks' };
      const rate = historyRate(history);
      return rate ? [{ r, need, history, rate: rate.rate }] : [];
    });
    return informative(rated, this.dailyBudget).flatMap(({ r, need, history, rate }) => {
      const s = spec(this, ctx, {
        title: `${r.repo} publishes a stable GitHub release by ${humanDate(w.target)}`,
        subject: `${r.label} ships a stable release`,
        placeName: r.repo,
        unit: 'releases',
        tags: [`repo:${r.repo}`],
        slot: `release:${r.repo}:${ctx.today}`,
        criteria: {
          kind: 'count',
          source: { id: 'github.releases', version: '1' },
          missingPolicy: MISSING,
          filter: { repo: r.repo, includePrereleases: false },
          comparator: '>=',
          threshold: 1,
          window: criteriaWindow(w, ctx.tz),
        },
        window: w,
        target: w.target,
        group: `release:${r.repo}:${ctx.today}`,
        baseRate: rate,
      });
      return s ? [{ spec: s, inputs: { history }, evidence: { history: [need], provider: [] } }] : [];
    });
  },
};

// ---------------------------------------------------------------------------
// tech.incident_week — status-page incidents
// ---------------------------------------------------------------------------

const IMPACT_RANK: Record<IncidentImpact, number> = { none: 0, minor: 1, major: 2, critical: 3 };
const IMPACT_TEXT: Record<IncidentImpact, string> = { none: 'an', minor: 'a minor-or-worse', major: 'a major-or-worse', critical: 'a critical' };

export const techIncidentWeek: WorldTemplate = {
  ...base,
  id: 'tech.incident_week',
  version: 1,
  domain: 'tech',
  horizons: [6],
  resolver: 'statuspage.incidents@1',
  dailyBudget: 2,
  description: "Will a watched service's status page report an incident this week? The severity is chosen so it happens about half the time.",
  appliesTo: (ctx) => isMonday(ctx.today),
  needs: (ctx) => (isMonday(ctx.today) ? ctx.watch.services.map((s) => ({ kind: 'incidents' as const, host: s.host })) : []),
  candidates(ctx, data) {
    const w = weekWindow(ctx);
    if (!w) return [];
    const rated = ctx.watch.services.flatMap((svc) => {
      const need: NeedOf<'incidents'> = { kind: 'incidents', host: svc.host };
      const list = data.get(need);
      if (!list) return [];
      const oldest = list.incidents.at(-1)?.createdAt;
      const windows = pastWindows(w, WEEK).filter((pw) => covered(list, oldest, pw));
      const pick = chooseRung(
        INCIDENT_IMPACTS.map((impact) => ({
          value: IMPACT_RANK[impact],
          history: {
            outcomes: windows.map((pw) => list.incidents.some((i) => IMPACT_RANK[i.impact] >= IMPACT_RANK[impact] && within(i.createdAt, pw))),
            unit: 'weeks',
          },
        })),
      );
      return pick ? [{ svc, need, pick, rate: pick.baseRate, pageName: list.pageName || svc.label }] : [];
    });
    return informative(rated, this.dailyBudget).flatMap(({ svc, need, pick, pageName }) => {
      const impact = INCIDENT_IMPACTS[pick.value] ?? 'none';
      const s = spec(this, ctx, {
        title: `${pageName}'s status page reports ${IMPACT_TEXT[impact]} incident by ${humanDate(w.target)}`,
        subject: `${pageName} reports ${IMPACT_TEXT[impact]} incident`,
        placeName: svc.host,
        unit: 'incidents',
        tags: [`status:${svc.host}`],
        slot: `incident:${svc.host}:${ctx.today}`,
        criteria: {
          kind: 'count',
          source: { id: 'statuspage', version: '1' },
          missingPolicy: MISSING,
          filter: { host: svc.host, minImpact: impact },
          comparator: '>=',
          threshold: 1,
          window: criteriaWindow(w, ctx.tz),
        },
        window: w,
        target: w.target,
        group: `incident:${svc.host}:${ctx.today}`,
        baseRate: pick.baseRate,
      });
      return s ? [{ spec: s, inputs: { history: pick.history }, evidence: { history: [need], provider: [] } }] : [];
    });
  },
};

// ---------------------------------------------------------------------------
// news.topic_surge — a tracked topic's coverage tomorrow vs its recent median
// ---------------------------------------------------------------------------

/** "Surge" multipliers of the 30-day median; spec §3.2 names 2×, which is rarer than 25% for most topics. */
const SURGE_LADDER = [1.1, 1.25, 1.5, 2, 3];
const MEDIAN_DAYS = 30;
/** GDELT searches about three months back; 30 days of median plus up to 52 scored days fits. */
const VOLUME_DAYS = MEDIAN_DAYS + MAX_HISTORY_WINDOWS;
/** Topics with fewer articles than this on a median day are too noisy to ask about. */
const MIN_MEDIAN_ARTICLES = 5;
/** Rotation epoch: the topic of the day is the next one in a fixed order. */
const ROTATION_EPOCH = '2026-01-05';

export function median(xs: readonly number[]): number {
  if (!xs.length) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** More than `mult` × median, as a whole-article threshold for a `>=` count. */
export const surgeThreshold = (mult: number, med: number) => Math.floor(mult * med) + 1;

export function topicOfTheDay(ctx: WorldCtx): TopicRef | undefined {
  const searchable = ctx.topics.filter((t) => t.query).sort((a, b) => a.id.localeCompare(b.id));
  if (!searchable.length) return undefined;
  const i = ((daysBetween(ROTATION_EPOCH, ctx.today) % searchable.length) + searchable.length) % searchable.length;
  return searchable[i];
}

function volumeNeed(ctx: WorldCtx, topic: TopicRef): NeedOf<'news.volume'> {
  // The UTC day in progress is incomplete, so history ends the day before.
  const last = addDays(utcDate(ctx.now), -1);
  return { kind: 'news.volume', query: gdeltQuery(topic.query ?? topic.label), start: addDays(last, -(VOLUME_DAYS - 1)), end: last };
}

export const newsTopicSurge: WorldTemplate = {
  ...base,
  id: 'news.topic_surge',
  version: 1,
  domain: 'world',
  horizons: [1],
  resolver: 'gdelt.volume@1',
  dailyBudget: 1,
  description: 'Will coverage of one of your topics tomorrow run above its 30-day median by a set factor? One topic a day, in rotation.',
  appliesTo: (ctx) => topicOfTheDay(ctx) !== undefined,
  needs(ctx) {
    const topic = topicOfTheDay(ctx);
    return topic ? [volumeNeed(ctx, topic)] : [];
  },
  candidates(ctx, data) {
    const topic = topicOfTheDay(ctx);
    if (!topic) return [];
    const need = volumeNeed(ctx, topic);
    const points = data.get(need);
    if (!points) return [];
    const byDate = new Map(points.map((p) => [p.date, p.count]));
    const counts: number[] = [];
    for (let d = need.start; d <= need.end; d = addDays(d, 1)) {
      const c = byDate.get(d);
      if (c === undefined) return []; // a gap would bias every median after it
      counts.push(c);
    }
    const recent = median(counts.slice(-MEDIAN_DAYS));
    if (!(recent >= MIN_MEDIAN_ARTICLES)) return [];
    const scored = counts
      .map((c, i) => ({ c, med: i >= MEDIAN_DAYS ? median(counts.slice(i - MEDIAN_DAYS, i)) : Number.NaN }))
      .filter((x) => Number.isFinite(x.med));
    const pick = chooseRung(SURGE_LADDER.map((m) => ({ value: m, history: { outcomes: scored.map((x) => x.c >= surgeThreshold(m, x.med)), unit: 'days' } })));
    if (!pick) return [];
    const target = addDays(ctx.today, 1);
    const window = { start: new Date(`${target}T00:00:00Z`), end: new Date(`${addDays(target, 1)}T00:00:00Z`) };
    const threshold = surgeThreshold(pick.value, recent);
    const s = spec(this, ctx, {
      title: `More than ${pick.value}× the usual ${topic.label} coverage on ${humanDate(target)} (UTC day): at least ${threshold} articles`,
      subject: `${topic.label} news above ${pick.value}× usual`,
      placeName: 'News coverage',
      unit: 'articles',
      tags: [`topic:${topic.id}`],
      slot: `news:${target}`,
      criteria: {
        kind: 'count',
        source: { id: 'gdelt.doc', version: '1' },
        missingPolicy: MISSING,
        filter: { query: need.query, measure: 'articles_per_utc_day', topic: topic.label, median30: recent, multiplier: pick.value },
        comparator: '>=',
        threshold,
        window: criteriaWindow(window, 'UTC'),
      },
      window,
      target,
      group: `news:${topic.id}:${target}`,
      baseRate: pick.baseRate,
    });
    return s ? [{ spec: s, inputs: { history: pick.history }, evidence: { history: [need], provider: [] } }] : [];
  },
};

export const WORLD_TEMPLATES: readonly WorldTemplate[] = [fxUsdInrWeek, worldQuakeWeek, spaceKpStorm3d, techReleaseWeek, techIncidentWeek, newsTopicSurge];
