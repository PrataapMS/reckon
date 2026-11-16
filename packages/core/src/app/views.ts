import { addDays, localDate, relativeDay, timeToMinutes, zonedTimeToUtc } from '../domain/dates';
import { type CriteriaDescription, describeCriteria } from '../domain/describe';
import { displayPercent, type VerbalLabel, verbalLabel } from '../domain/probability';
import { forecasterName, templateById } from '../domain/registry';
import { brier, type Outcome } from '../domain/scoring';
import { type Domain, isWorldMeta, type TemplateClass, type TemplateInfo } from '../domain/templates';
import type {
  Clock,
  EvidenceRecord,
  EvidenceRepo,
  EvidenceStore,
  ForecastRecord,
  ForecastRepo,
  LinkedNews,
  NewsRepo,
  QuestionRecord,
  QuestionRepo,
  ResolutionRecord,
  ResolutionRepo,
  ScoreReader,
  User,
  UserRepo,
} from '../ports';
import { computeTrust, type TrustInfo, type TrustTable, trustText } from './trust';

export interface ViewDeps {
  readonly clock: Clock;
  readonly users: UserRepo;
  readonly questions: QuestionRepo;
  readonly forecasts: ForecastRepo;
  readonly resolutions: ResolutionRepo;
  readonly evidence: EvidenceRepo;
  readonly evidenceStore: EvidenceStore;
  readonly scores: ScoreReader;
  readonly news: NewsRepo;
}

/** The last forecast each forecaster made before lock: exactly what the `scores` view scores. */
export function lastBeforeLock(forecasts: readonly ForecastRecord[], lockAt: Date): Map<string, ForecastRecord> {
  const out = new Map<string, ForecastRecord>();
  for (const f of forecasts) {
    if (f.madeAt.getTime() >= lockAt.getTime()) continue;
    const prev = out.get(f.forecasterId);
    if (!prev || prev.madeAt.getTime() < f.madeAt.getTime()) out.set(f.forecasterId, f);
  }
  return out;
}

const FALLBACK_ORDER = ['provider.openmeteo@1', 'ensemble.openmeteo@1', 'climatology@1', 'history.rate@1', 'provider.swpc@1'];

/** Who speaks for a template: its champion, then the fallbacks in order. */
export function championOrder(template: TemplateInfo | undefined): readonly string[] {
  return template ? [template.champion, ...FALLBACK_ORDER] : FALLBACK_ORDER;
}

/** The template's champion if it forecast this question, else the next best available. */
export function championForecast(template: TemplateInfo | undefined, latest: Map<string, ForecastRecord>): ForecastRecord | undefined {
  for (const id of championOrder(template)) {
    const f = latest.get(id);
    if (f) return f;
  }
  return undefined;
}

function groupBy<T>(xs: readonly T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    const list = m.get(k) ?? [];
    list.push(x);
    m.set(k, list);
  }
  return m;
}

/** For one claim asked at several horizons, keep the freshest (shortest-horizon) question. */
function freshestPerClaim(qs: readonly QuestionRecord[]): QuestionRecord[] {
  const best = new Map<string, QuestionRecord>();
  for (const q of qs) {
    const k = `${q.templateId}|${q.locationId}|${q.targetDate}|${q.criteriaHash}`;
    const prev = best.get(k);
    if (!prev || q.horizonDays < prev.horizonDays) best.set(k, q);
  }
  return [...best.values()];
}

const DOMAIN_ORDER: Record<string, number> = { weather: 0, air: 1, money: 2, tech: 3, world: 4, life: 5 };
const byImportance = (a: { class: TemplateClass; domain: string }, b: { class: TemplateClass; domain: string }) =>
  (a.class === 'decision' ? 0 : 1) - (b.class === 'decision' ? 0 : 1) || (DOMAIN_ORDER[a.domain] ?? 9) - (DOMAIN_ORDER[b.domain] ?? 9);

// ---------------------------------------------------------------------------
// Today's brief
// ---------------------------------------------------------------------------

export interface TrustView extends TrustInfo {
  readonly text: string;
}

export type Scope = 'place' | 'world';
const scopeOf = (q: QuestionRecord): Scope => (isWorldMeta(q.meta) ? 'world' : 'place');

export interface BriefItemView {
  readonly questionId: string;
  readonly templateId: string | null;
  readonly scope: Scope;
  readonly domain: Domain;
  readonly class: TemplateClass;
  readonly subject: string;
  readonly placeName: string;
  readonly title: string;
  readonly targetDate: string;
  readonly when: string;
  readonly horizonDays: number;
  readonly status: QuestionRecord['status'];
  readonly lockAt: string;
  readonly p: number;
  readonly percent: number;
  readonly label: VerbalLabel;
  readonly action: string | null;
  readonly forecaster: { readonly id: string; readonly name: string };
  readonly basis: string;
  readonly trust: TrustView;
}

export interface BriefView {
  readonly date: string;
  readonly tz: string;
  readonly generatedAt: string;
  readonly today: readonly BriefItemView[];
  readonly tomorrow: readonly BriefItemView[];
  readonly later: readonly BriefItemView[];
  /** World Pulse: money, tech, space and news claims still waiting on reality. */
  readonly world: readonly BriefItemView[];
}

function briefItem(q: QuestionRecord, f: ForecastRecord, user: User, trust: TrustTable, today: string): BriefItemView {
  const template = templateById(q.templateId);
  const t = trust.get(q.templateId, f.forecasterId);
  const name = forecasterName(f.forecasterId);
  return {
    questionId: q.id,
    templateId: q.templateId,
    scope: scopeOf(q),
    domain: q.domain,
    class: q.meta.class,
    subject: q.meta.subject,
    placeName: q.meta.placeName,
    title: q.title,
    targetDate: q.targetDate,
    when: relativeDay(q.targetDate, today),
    horizonDays: q.horizonDays,
    status: q.status,
    lockAt: q.lockAt.toISOString(),
    p: f.p,
    percent: displayPercent(f.p),
    label: verbalLabel(f.p),
    action: template?.action?.(f.p, user.settings) ?? null,
    forecaster: { id: f.forecasterId, name },
    basis: f.rationale ?? '',
    trust: { ...t, text: trustText(t, name) },
  };
}

/** GET /brief/today: the locked (or about to lock) claims for today, tomorrow and this week. */
export function getTodayBrief(deps: ViewDeps) {
  const trustFor = computeTrust(deps);
  return async (userId: string): Promise<BriefView | null> => {
    const user = await deps.users.byId(userId);
    if (!user) return null;
    const now = deps.clock.now();
    const today = localDate(now, user.tz);
    const qs = freshestPerClaim((await deps.questions.listByTargetDates(userId, today, addDays(today, 7))).filter((q) => q.status !== 'annulled'));
    const forecasts = groupBy(await deps.forecasts.forQuestions(qs.map((q) => q.id)), (f) => f.questionId);
    const trust = await trustFor(userId);

    const items: BriefItemView[] = [];
    for (const q of qs) {
      const f = championForecast(templateById(q.templateId), lastBeforeLock(forecasts.get(q.id) ?? [], q.lockAt));
      if (f) items.push(briefItem(q, f, user, trust, today));
    }
    items.sort((a, b) => a.targetDate.localeCompare(b.targetDate) || byImportance(a, b) || a.placeName.localeCompare(b.placeName));
    const tomorrow = addDays(today, 1);
    const place = items.filter((i) => i.scope === 'place');
    return {
      date: today,
      tz: user.tz,
      generatedAt: now.toISOString(),
      today: place.filter((i) => i.targetDate === today),
      tomorrow: place.filter((i) => i.targetDate === tomorrow),
      later: place.filter((i) => i.targetDate > tomorrow),
      world: items.filter((i) => i.scope === 'world'),
    };
  };
}

// ---------------------------------------------------------------------------
// The Reveal
// ---------------------------------------------------------------------------

/**
 * The Reveal ritual (spec §1.3): a day's claims open at the user's reveal time on the following
 * day, once the source has published the observed values.
 */
export function revealOpensAt(user: User, date: string): Date {
  return zonedTimeToUtc(addDays(date, 1), timeToMinutes(user.revealTime), user.tz);
}

export function isSealed(user: User, date: string, now: Date): boolean {
  return now.getTime() < revealOpensAt(user, date).getTime();
}

/**
 * The reveal the user is waiting for or has just seen: yesterday's claims, sealed until today's
 * reveal time and open after it. Earlier reveals are reached by date.
 */
export function currentRevealDate(user: User, now: Date): string {
  return addDays(localDate(now, user.tz), -1);
}

export interface ForecastScoreView {
  readonly forecasterId: string;
  readonly name: string;
  readonly p: number;
  readonly percent: number;
  readonly madeAt: string;
  readonly rationale: string | null;
  readonly brier: number | null;
  readonly champion: boolean;
}

export interface RevealCardView {
  readonly questionId: string;
  readonly scope: Scope;
  readonly domain: Domain;
  readonly subject: string;
  readonly placeName: string;
  readonly title: string;
  readonly status: QuestionRecord['status'];
  readonly percent: number | null;
  readonly outcome: Outcome | null;
  readonly observed: string | null;
  readonly annulReason: string | null;
  readonly hit: boolean | null;
  readonly brier: number | null;
  readonly forecasts: readonly ForecastScoreView[];
}

export interface RevealView {
  readonly date: string;
  readonly sealed: boolean;
  readonly opensAt: string;
  readonly total: number;
  readonly cards: readonly RevealCardView[];
  readonly summary: { readonly hits: number; readonly misses: number; readonly pending: number; readonly annulled: number; readonly meanBrier: number | null };
}

const COUNT_UNITS = new Set(['quakes', 'releases', 'incidents', 'articles']);

export function formatObserved(value: number | null, unit: string | null): string | null {
  if (value == null) return null;
  if (unit === 'US AQI') return `US AQI ${Math.round(value)}`;
  if (unit === 'Kp') return `Kp ${Math.round(value * 100) / 100}`;
  if (unit?.endsWith(' change')) return `${value > 0 ? '+' : value < 0 ? '−' : '±'}${Math.abs(value).toFixed(2)} ${unit.slice(0, -' change'.length)}`;
  if (unit && COUNT_UNITS.has(unit)) return `${value} ${value === 1 ? unit.slice(0, -1) : unit}`;
  return `${Math.round(value * 10) / 10} ${unit ?? ''}`.trim();
}

function forecastScores(latest: Map<string, ForecastRecord>, champion: ForecastRecord | undefined, outcome: Outcome | null): ForecastScoreView[] {
  return [...latest.values()]
    .map((f) => ({
      forecasterId: f.forecasterId,
      name: forecasterName(f.forecasterId),
      p: f.p,
      percent: displayPercent(f.p),
      madeAt: f.madeAt.toISOString(),
      rationale: f.rationale,
      brier: outcome == null ? null : brier(f.p, outcome),
      champion: f === champion,
    }))
    .sort((a, b) => Number(b.champion) - Number(a.champion) || a.name.localeCompare(b.name));
}

/** GET /reveal/:date. Before the reveal opens only the count is shown: the cards stay sealed. */
export function getReveal(deps: ViewDeps) {
  return async (userId: string, dateOrLatest: string, opts: { ignoreSeal?: boolean } = {}): Promise<RevealView | null> => {
    const user = await deps.users.byId(userId);
    if (!user) return null;
    const now = deps.clock.now();
    const date = dateOrLatest === 'latest' ? currentRevealDate(user, now) : dateOrLatest;
    const qs = freshestPerClaim(await deps.questions.listByTargetDates(userId, date, date));
    const sealed = !opts.ignoreSeal && isSealed(user, date, now);
    const opensAt = revealOpensAt(user, date).toISOString();
    if (sealed) return { date, sealed, opensAt, total: qs.length, cards: [], summary: { hits: 0, misses: 0, pending: 0, annulled: 0, meanBrier: null } };

    const ids = qs.map((q) => q.id);
    const forecasts = groupBy(await deps.forecasts.forQuestions(ids), (f) => f.questionId);
    const resolutions = new Map((await deps.resolutions.latestFor(ids)).map((r) => [r.questionId, r]));
    const cards: RevealCardView[] = qs.map((q) => {
      const latest = lastBeforeLock(forecasts.get(q.id) ?? [], q.lockAt);
      const champ = championForecast(templateById(q.templateId), latest);
      const r = resolutions.get(q.id);
      const outcome = q.status === 'resolved' ? (r?.outcome ?? null) : null;
      return {
        questionId: q.id,
        scope: scopeOf(q),
        domain: q.domain,
        subject: q.meta.subject,
        placeName: q.meta.placeName,
        title: q.title,
        status: q.status,
        percent: champ ? displayPercent(champ.p) : null,
        outcome,
        observed: formatObserved(r?.observedValue ?? null, r?.observedUnit ?? null),
        annulReason: q.annulReason,
        hit: champ && outcome != null ? champ.p >= 0.5 === (outcome === 1) : null,
        brier: champ && outcome != null ? brier(champ.p, outcome) : null,
        forecasts: forecastScores(latest, champ, outcome),
      };
    });
    cards.sort((a, b) => byImportance({ class: classOf(qs, a), domain: a.domain }, { class: classOf(qs, b), domain: b.domain }));
    const scored = cards.filter((c) => c.brier != null);
    return {
      date,
      sealed,
      opensAt,
      total: cards.length,
      cards,
      summary: {
        hits: cards.filter((c) => c.hit === true).length,
        misses: cards.filter((c) => c.hit === false).length,
        pending: cards.filter((c) => c.status === 'open' || c.status === 'locked' || c.status === 'resolving').length,
        annulled: cards.filter((c) => c.status === 'annulled').length,
        meanBrier: scored.length ? scored.reduce((s, c) => s + (c.brier ?? 0), 0) / scored.length : null,
      },
    };
  };
}

function classOf(qs: readonly QuestionRecord[], c: RevealCardView): TemplateClass {
  return qs.find((q) => q.id === c.questionId)?.meta.class ?? 'informative';
}

// ---------------------------------------------------------------------------
// Question detail
// ---------------------------------------------------------------------------

export interface EvidenceView {
  readonly id: string;
  readonly sourceId: string;
  readonly fetchedAt: string;
  readonly url: string | null;
  readonly sha256: string;
  readonly purpose: string | null;
  readonly downloadPath: string;
}

export interface QuestionDetailView {
  readonly id: string;
  readonly scope: Scope;
  readonly title: string;
  readonly subject: string;
  readonly placeName: string;
  readonly domain: Domain;
  readonly class: TemplateClass;
  readonly templateId: string | null;
  readonly templateDescription: string | null;
  readonly targetDate: string;
  readonly when: string;
  readonly horizonDays: number;
  readonly status: QuestionRecord['status'];
  readonly lockAt: string;
  readonly sealed: boolean;
  readonly opensAt: string;
  readonly judged: CriteriaDescription;
  readonly criteria: unknown;
  readonly criteriaHash: string;
  readonly baseRate: number | null;
  readonly forecasts: readonly ForecastScoreView[];
  readonly resolution: {
    readonly outcome: Outcome | null;
    readonly observed: string | null;
    readonly resolvedAt: string;
    readonly resolver: string;
    readonly annulReason: string | null;
  } | null;
  readonly evidence: readonly EvidenceView[];
  /** "Why we believe this": headlines linked to the question (spec §3.6). Context only; never used to judge. */
  readonly news: readonly LinkedNews[];
}

export function evidenceView(questionId: string, e: EvidenceRecord): EvidenceView {
  return {
    id: e.id,
    sourceId: e.sourceId,
    fetchedAt: e.fetchedAt,
    url: e.url,
    sha256: e.sha256,
    purpose: typeof e.meta.purpose === 'string' ? e.meta.purpose : null,
    downloadPath: `/api/v1/questions/${questionId}/evidence/${e.id}/raw`,
  };
}

export function getQuestionDetail(deps: ViewDeps) {
  return async (userId: string, questionId: string): Promise<QuestionDetailView | null> => {
    const [user, q] = await Promise.all([deps.users.byId(userId), deps.questions.get(questionId)]);
    if (!user || !q || q.userId !== userId) return null;
    const now = deps.clock.now();
    const sealed = isSealed(user, q.targetDate, now);
    const template = templateById(q.templateId);
    const latest = lastBeforeLock(await deps.forecasts.forQuestions([q.id]), q.lockAt);
    const champ = championForecast(template, latest);
    const r: ResolutionRecord | undefined = sealed ? undefined : (await deps.resolutions.latestFor([q.id]))[0];
    const outcome = !sealed && q.status === 'resolved' ? (r?.outcome ?? null) : null;
    const evidence = (await deps.questions.evidenceFor(q.id))
      // A sealed question's resolution snapshot would give the outcome away; headlines are listed separately.
      .filter((e) => e.kind === 'snapshot' && (!sealed || e.meta.purpose !== 'resolution'))
      .map((e) => evidenceView(q.id, e));
    const news = await deps.news.forQuestion(q.id);
    return {
      id: q.id,
      scope: scopeOf(q),
      title: q.title,
      subject: q.meta.subject,
      placeName: q.meta.placeName,
      domain: q.domain,
      class: q.meta.class,
      templateId: q.templateId,
      templateDescription: template?.description ?? null,
      targetDate: q.targetDate,
      when: relativeDay(q.targetDate, localDate(now, user.tz)),
      horizonDays: q.horizonDays,
      status: sealed && (q.status === 'resolved' || q.status === 'annulled') ? 'resolving' : q.status,
      lockAt: q.lockAt.toISOString(),
      sealed,
      opensAt: revealOpensAt(user, q.targetDate).toISOString(),
      judged: describeCriteria(q.criteria),
      criteria: q.criteria,
      criteriaHash: q.criteriaHash,
      baseRate: q.meta.baseRate ?? null,
      forecasts: forecastScores(latest, champ, outcome),
      resolution:
        r && !sealed
          ? {
              outcome: r.outcome,
              observed: formatObserved(r.observedValue, r.observedUnit),
              resolvedAt: r.resolvedAt.toISOString(),
              resolver: r.resolverVersion,
              annulReason: q.annulReason,
            }
          : null,
      evidence,
      news,
    };
  };
}

/** GET /questions/:id/evidence/:eid/raw — only evidence linked to that question, never sealed outcomes. */
export function getEvidenceRaw(deps: ViewDeps) {
  return async (userId: string, questionId: string, evidenceId: string): Promise<{ body: string; contentType: string; filename: string } | null> => {
    const [user, q] = await Promise.all([deps.users.byId(userId), deps.questions.get(questionId)]);
    if (!user || !q || q.userId !== userId) return null;
    const linked = (await deps.questions.evidenceFor(q.id)).find((e) => e.id === evidenceId);
    if (!linked?.blobKey) return null;
    if (linked.meta.purpose === 'resolution' && isSealed(user, q.targetDate, deps.clock.now())) return null;
    const blob = await deps.evidenceStore.get(linked.blobKey);
    if (!blob) return null;
    const ext = blob.contentType.includes('json') ? 'json' : blob.contentType.includes('xml') ? 'xml' : 'txt';
    return { ...blob, filename: `${linked.sourceId}-${linked.fetchedAt.slice(0, 10)}-${linked.sha256.slice(0, 12)}.${ext}` };
  };
}

// ---------------------------------------------------------------------------
// Question list
// ---------------------------------------------------------------------------

export interface QuestionSummaryView {
  readonly id: string;
  readonly scope: Scope;
  readonly title: string;
  readonly subject: string;
  readonly placeName: string;
  readonly domain: Domain;
  readonly templateId: string | null;
  readonly targetDate: string;
  readonly horizonDays: number;
  readonly status: QuestionRecord['status'];
}

/** Longest range one request may ask for; the client pages backwards by date. */
export const MAX_LIST_DAYS = 31;

/** GET /questions?from&to: every question about a date range, sealed outcomes withheld. */
export function listQuestions(deps: ViewDeps) {
  return async (userId: string, from: string, to: string): Promise<QuestionSummaryView[] | null> => {
    const user = await deps.users.byId(userId);
    if (!user) return null;
    const now = deps.clock.now();
    const qs = await deps.questions.listByTargetDates(userId, from, to);
    return qs.map((q) => ({
      id: q.id,
      scope: scopeOf(q),
      title: q.title,
      subject: q.meta.subject,
      placeName: q.meta.placeName,
      domain: q.domain,
      templateId: q.templateId,
      targetDate: q.targetDate,
      horizonDays: q.horizonDays,
      status: isSealed(user, q.targetDate, now) && (q.status === 'resolved' || q.status === 'annulled') ? 'resolving' : q.status,
    }));
  };
}
