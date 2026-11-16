import { forecasterName, templateById } from '../domain/registry';
import { brier, expectedCalibrationError, mean, reliabilityBins } from '../domain/scoring';
import type { Domain } from '../domain/templates';
import type { ScoredForecast, ScoreReader } from '../ports';
import { MIN_CLUSTERS, pairWithReference, type TrustInfo, trustFor, trustText } from './trust';
import { championOrder } from './views';

export interface ForecasterScoreView {
  readonly forecasterId: string;
  readonly name: string;
  readonly n: number;
  readonly meanBrier: number;
  readonly champion: boolean;
  readonly trust: TrustInfo & { readonly text: string };
}

export interface TemplateScoreView {
  readonly templateId: string;
  readonly domain: Domain;
  readonly description: string;
  readonly questions: number;
  readonly forecasters: readonly ForecasterScoreView[];
}

export interface ScoreboardView {
  readonly resolvedQuestions: number;
  readonly resolvedClusters: number;
  readonly clustersNeeded: number;
  readonly templates: readonly TemplateScoreView[];
}

const byKey = <T>(xs: readonly T[], key: (x: T) => string) => {
  const m = new Map<string, T[]>();
  for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
  return m;
};

/**
 * Scoreboard v1 (spec §3.5): mean Brier per template and forecaster on resolved questions, with
 * the bootstrap trust label against that template's base rate. Lower Brier is better.
 */
export function getScoreboard(deps: { scores: ScoreReader }) {
  return async (userId: string): Promise<ScoreboardView> => {
    const [scored, resolvedClusters] = await Promise.all([deps.scores.scored(userId), deps.scores.resolvedClusterCount(userId)]);
    const pairs = pairWithReference(scored);
    const templates: TemplateScoreView[] = [...byKey(scored, (s) => s.templateId)].map(([templateId, rows]) => {
      const template = templateById(templateId);
      const forecasters = [...byKey(rows, (r) => r.forecasterId)].map(([forecasterId, fs]) => {
        const trust = trustFor(pairs.get(`${templateId}|${forecasterId}`) ?? [], forecasterId);
        const name = forecasterName(forecasterId);
        return {
          forecasterId,
          name,
          n: fs.length,
          meanBrier: mean(fs.map((f) => brier(f.p, f.o))),
          champion: template?.champion === forecasterId,
          trust: { ...trust, text: trustText(trust, name) },
        };
      });
      forecasters.sort((a, b) => a.meanBrier - b.meanBrier || a.name.localeCompare(b.name));
      return {
        templateId,
        domain: rows[0]?.domain ?? 'weather',
        description: template?.description ?? templateId,
        questions: new Set(rows.map((r) => r.questionId)).size,
        forecasters,
      };
    });
    templates.sort((a, b) => b.questions - a.questions || a.templateId.localeCompare(b.templateId));
    return { resolvedQuestions: new Set(scored.map((s) => s.questionId)).size, resolvedClusters, clustersNeeded: MIN_CLUSTERS, templates };
  };
}

export interface CalibrationBinView {
  readonly lower: number;
  readonly upper: number;
  readonly count: number;
  readonly meanForecast: number | null;
  readonly observed: number | null;
  readonly ci: readonly [number, number] | null;
}

export interface CalibrationView {
  /** 'shown' = the probability each question displayed (its champion); otherwise a forecaster id. */
  readonly forecaster: string;
  readonly name: string;
  readonly templateId: string | null;
  readonly n: number;
  readonly ece: number | null;
  readonly bins: readonly CalibrationBinView[];
  readonly forecasters: readonly { readonly id: string; readonly name: string }[];
}

/** Spec §3.5: 5 bins until 500 resolved forecasts, then 10. */
export const BINS_SWITCH_AT = 500;

/** The forecast each question displayed: its template's champion, else the first fallback that spoke. */
function shown(scored: readonly ScoredForecast[]): ScoredForecast[] {
  return [...byKey(scored, (s) => s.questionId).values()].flatMap((fs) => {
    const ids = new Map(fs.map((f) => [f.forecasterId, f]));
    const id = championOrder(templateById(fs[0]?.templateId)).find((x) => ids.has(x));
    const f = id ? ids.get(id) : undefined;
    return f ? [f] : [];
  });
}

const finite = (x: number) => (Number.isFinite(x) ? x : null);

export function getCalibration(deps: { scores: ScoreReader }) {
  return async (userId: string, opts: { readonly forecaster?: string; readonly templateId?: string } = {}): Promise<CalibrationView> => {
    const all = (await deps.scores.scored(userId)).filter((s) => !opts.templateId || s.templateId === opts.templateId);
    const forecaster = opts.forecaster ?? 'shown';
    const rows = forecaster === 'shown' ? shown(all) : all.filter((s) => s.forecasterId === forecaster);
    const bins = reliabilityBins(rows, rows.length >= BINS_SWITCH_AT ? 10 : 5);
    const lo = (b: (typeof bins)[number]) => finite(b.ci[0]);
    const hi = (b: (typeof bins)[number]) => finite(b.ci[1]);
    return {
      forecaster,
      name: forecaster === 'shown' ? 'What Reckon showed you' : forecasterName(forecaster),
      templateId: opts.templateId ?? null,
      n: rows.length,
      ece: rows.length ? finite(expectedCalibrationError(bins)) : null,
      bins: bins.map((b) => {
        const l = lo(b);
        const h = hi(b);
        return {
          lower: b.lower,
          upper: b.upper,
          count: b.count,
          meanForecast: finite(b.meanForecast),
          observed: finite(b.observedFrequency),
          ci: l != null && h != null ? [l, h] : null,
        };
      }),
      forecasters: [...new Set(all.map((s) => s.forecasterId))].sort().map((id) => ({ id, name: forecasterName(id) })),
    };
  };
}
