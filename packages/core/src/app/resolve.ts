import { type Criteria, evaluate, type Observation } from '../domain/criteria';
import type { DailyMetric } from '../domain/data';
import { err, ok, type Result } from '../domain/result';
import { isWorldMeta, type QuestionMeta } from '../domain/templates';
import type { Clock, DailyObservationPort, Logger, QuestionRepo, ResolutionRepo, Resolver, SourceError, SourceSnapshot, WorkItem, WorkQueue } from '../ports';
import { type HandlerOutcome, nextRunAfter } from './drain-work-queue';
import { type EvidenceDeps, saveSnapshot } from './evidence';

const DAILY_METRICS = new Set<string>(['precipitation_sum', 'temperature_2m_max', 'us_aqi']);

/**
 * `openmeteo.daily@1` (spec §3.4): asks "what did the declared Open-Meteo dataset report for
 * that local day?", never "what is it now?", so it gives the same answer late or twice.
 */
export function openMeteoDailyResolver(obs: DailyObservationPort): Resolver {
  return {
    id: 'openmeteo.daily@1',
    sourceIds: ['openmeteo.forecast', 'openmeteo.air_quality'],
    // Past-day values settle a few hours after local midnight as model runs assimilate the day.
    delayHours: 6,
    async observe(c: Criteria, targetDate: string): Promise<Result<SourceSnapshot<Observation | null>, SourceError>> {
      if (c.kind !== 'threshold' || !DAILY_METRICS.has(c.metric) || c.lat == null || c.lon == null) {
        return err({ code: 'schema_changed', sourceId: c.source.id, detail: `openmeteo.daily cannot judge ${c.kind}/${'metric' in c ? c.metric : ''}` });
      }
      const r = await obs.observeDay({ lat: c.lat, lon: c.lon, tz: c.window.tz, date: targetDate, metric: c.metric as DailyMetric });
      if (!r.ok) return r;
      const value = r.value.parsed.value;
      return ok({ ...r.value, parsed: value == null ? null : { kind: 'value', value } });
    },
  };
}

export interface ResolveDeps extends EvidenceDeps {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly questions: QuestionRepo;
  readonly resolutions: ResolutionRepo;
  readonly queue: WorkQueue;
  readonly resolvers: readonly Resolver[];
}

/** Which resolver judges a question is fixed by the dataset its criteria name (ADR-0005). */
export function resolverFor(resolvers: readonly Resolver[], c: Criteria): Resolver | undefined {
  return resolvers.find((r) => r.sourceIds.includes(c.source.id));
}

/** The number a resolution records: the value, the count, or (for a comparison) the change from a to b. */
export function observedValue(c: Criteria, meta: QuestionMeta, obs: Observation): { readonly value: number | null; readonly unit: string | null } {
  switch (obs.kind) {
    case 'value':
      return { value: obs.value, unit: c.kind === 'threshold' ? c.unit : null };
    case 'count':
      return { value: obs.count, unit: 'unit' in meta ? meta.unit : null };
    case 'pair':
      return { value: Math.round((obs.b - obs.a) * 1e6) / 1e6, unit: isWorldMeta(meta) ? meta.unit : null };
    case 'event':
      return { value: obs.occurred ? 1 : 0, unit: null };
  }
}

/** Shortest resolver delay, so one query finds every question that might be ready. */
const minDelay = (rs: readonly Resolver[]) => Math.min(...rs.map((r) => r.delayHours));

/**
 * Tick step (spec §3.4 step 1): lock questions whose lock time has passed, then queue one
 * `resolve` item per locked question whose window has closed plus the source delay.
 * Enqueue happens before the status change, so a crash in between never strands a question.
 */
export function lockAndEnqueueResolutions(deps: Pick<ResolveDeps, 'clock' | 'questions' | 'queue' | 'resolvers'>) {
  return async (): Promise<{ locked: number; enqueued: number }> => {
    const now = deps.clock.now();
    const locked = await deps.questions.lockDue(now);
    let enqueued = 0;
    for (const q of await deps.questions.dueForResolution(now, minDelay(deps.resolvers), 200)) {
      const resolver = resolverFor(deps.resolvers, q.criteria);
      if (!resolver || q.windowEnd.getTime() + resolver.delayHours * 3_600_000 > now.getTime()) continue;
      await deps.queue.enqueue('resolve', { questionId: q.id }, { dedupeKey: `resolve:${q.id}`, maxAttempts: 12 });
      await deps.questions.transition(q.id, 'locked', 'resolving');
      enqueued++;
    }
    return { locked, enqueued };
  };
}

function payloadQuestionId(item: WorkItem): string | undefined {
  const p = item.payload as { questionId?: unknown } | null;
  return typeof p?.questionId === 'string' ? p.questionId : undefined;
}

/**
 * Work handler for `resolve` (spec §3.4 steps 2–5). Retries follow the backoff schedule but never
 * past the criteria's deadline; at the deadline the question is annulled with the last error.
 */
export function resolveQuestion(deps: ResolveDeps) {
  return async (item: WorkItem): Promise<HandlerOutcome> => {
    const id = payloadQuestionId(item);
    if (!id) return { status: 'fail', error: 'payload has no questionId' };
    const q = await deps.questions.get(id);
    if (!q) return { status: 'fail', error: `question ${id} not found` };
    if (q.status === 'resolved' || q.status === 'annulled') return { status: 'done' };
    if (q.status === 'open') return { status: 'retry', error: 'question not locked yet' };
    if (q.status === 'locked') await deps.questions.transition(q.id, 'locked', 'resolving');

    const resolver = resolverFor(deps.resolvers, q.criteria);
    const now = deps.clock.now();
    const deadline = new Date(q.windowEnd.getTime() + q.criteria.missingPolicy.retryUntilHours * 3_600_000);

    const annul = async (reason: string): Promise<HandlerOutcome> => {
      await deps.resolutions.record({
        questionId: q.id,
        outcome: null,
        observedValue: null,
        observedUnit: null,
        evidenceId: null,
        resolverVersion: resolver?.id ?? 'none',
        annulReason: reason,
      });
      deps.logger.warn('resolve.annulled', { questionId: q.id, reason });
      return { status: 'done' };
    };
    const retryOrAnnul = (reason: string): Promise<HandlerOutcome> | HandlerOutcome => {
      if (now.getTime() >= deadline.getTime()) return annul(reason);
      const next = nextRunAfter(now, item.attempts);
      return { status: 'retry', error: reason, runAfter: next.getTime() < deadline.getTime() ? next : deadline };
    };

    if (!resolver) return annul('no_resolver');
    const r = await resolver.observe(q.criteria, q.targetDate);
    if (!r.ok) return retryOrAnnul(r.error.code);

    const evidenceId = await saveSnapshot(deps, r.value, { purpose: 'resolution', questionId: q.id });
    await deps.questions.linkEvidence(q.id, [evidenceId]);
    if (!r.value.parsed) return retryOrAnnul('missing_value');

    const outcome = evaluate(q.criteria, r.value.parsed);
    if (!outcome.ok) return annul(outcome.error.code);
    const observed = observedValue(q.criteria, q.meta, r.value.parsed);
    await deps.resolutions.record({
      questionId: q.id,
      outcome: outcome.value,
      observedValue: observed.value,
      observedUnit: observed.unit,
      evidenceId,
      resolverVersion: resolver.id,
    });
    deps.logger.info('resolve.done', { questionId: q.id, outcome: outcome.value, observed: observed.value });
    return { status: 'done' };
  };
}
