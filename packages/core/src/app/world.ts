import { localDate, localMinutes, timeToMinutes } from '../domain/dates';
import { acceptsForecastAt } from '../domain/question';
import { worldTemplateById } from '../domain/registry';
import type { Result } from '../domain/result';
import { WORLD_FORECASTERS } from '../domain/world-forecasters';
import {
  DEFAULT_WATCH,
  type NeedKind,
  needKey,
  WORLD_TEMPLATES,
  type WorldCtx,
  type WorldData,
  type WorldNeed,
  type WorldNeedData,
} from '../domain/world-templates';
import type {
  Clock,
  ForecastRepo,
  FxPort,
  KpHistoryPort,
  LocationRepo,
  Logger,
  NewsVolumePort,
  QuakePort,
  QuestionRepo,
  ReleasePort,
  SourceError,
  SourceSnapshot,
  SpaceWeatherPort,
  StatusPagePort,
  TopicRepo,
  UserRepo,
  WorkQueue,
} from '../ports';
import { type EvidenceDeps, saveSnapshot } from './evidence';
import { GENERATE_LEAD_MINUTES } from './generate';
import { enabledTopics, ensureDefaultTopics } from './topics';

/** Every Phase 2 source a world template can ask for. */
export interface WorldSources {
  readonly fx: FxPort;
  readonly quakes: QuakePort;
  readonly kpHistory: KpHistoryPort;
  readonly space: SpaceWeatherPort;
  readonly releases: ReleasePort;
  readonly status: StatusPagePort;
  readonly newsVolume: NewsVolumePort;
}

/** Fetch one need through its port. Adding a source means one case here plus its adapter. */
export function loadNeed(s: WorldSources, need: WorldNeed): Promise<Result<SourceSnapshot<unknown>, SourceError>> {
  switch (need.kind) {
    case 'fx':
      return s.fx.dailyRates(need);
    case 'quakes':
      return s.quakes.events(need);
    case 'kp.history':
      return s.kpHistory.kpHistory(need);
    case 'kp.forecast':
      return s.space.geomagForecast();
    case 'releases':
      return s.releases.releases(need.repo);
    case 'incidents':
      return s.status.incidents(need.host);
    case 'news.volume':
      return s.newsVolume.dailyVolume(need);
  }
}

export interface GenerateWorldDeps extends EvidenceDeps {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly users: UserRepo;
  readonly locations: LocationRepo;
  readonly questions: QuestionRepo;
  readonly forecasts: ForecastRepo;
  readonly topics: TopicRepo;
  readonly world: WorldSources;
}

export interface WorldGenerateStats {
  readonly questionsCreated: number;
  readonly questionsSeen: number;
  readonly forecastsWritten: number;
  readonly sourceErrors: readonly string[];
}

export type WorldGenerateError = { readonly code: 'user_not_found' | 'template_not_found' };

/**
 * Generate one world template's questions for a user and collect every forecaster's probability
 * before lock. One work item per template, so a slow or failing source only delays its own
 * questions. Idempotent: a retry adds only what is missing, and one question per slot.
 */
export function generateWorldTemplate(deps: GenerateWorldDeps) {
  const seedTopics = ensureDefaultTopics(deps);
  return async (userId: string, templateId: string): Promise<Result<WorldGenerateStats, WorldGenerateError>> => {
    const template = worldTemplateById(templateId);
    if (!template) return { ok: false, error: { code: 'template_not_found' } };
    const user = await deps.users.byId(userId);
    if (!user) return { ok: false, error: { code: 'user_not_found' } };
    await seedTopics(userId);

    const now = deps.clock.now();
    const ctx: WorldCtx = {
      now,
      today: localDate(now, user.tz),
      tz: user.tz,
      briefMinutes: timeToMinutes(user.briefTime),
      topics: enabledTopics(await deps.topics.list(userId)),
      watch: DEFAULT_WATCH,
    };
    const stats = { questionsCreated: 0, questionsSeen: 0, forecastsWritten: 0, sourceErrors: [] as string[] };
    if (!template.appliesTo(ctx)) return { ok: true, value: stats };

    // Sequential on purpose: several needs can hit one rate-limited provider.
    const parsed = new Map<string, unknown>();
    const evidenceIds = new Map<string, string>();
    for (const need of template.needs(ctx)) {
      const r = await loadNeed(deps.world, need);
      if (!r.ok) {
        stats.sourceErrors.push(`${r.error.sourceId}:${r.error.code}`);
        deps.logger.warn('generate_world.source_failed', { templateId, source: r.error.sourceId, code: r.error.code, detail: r.error.detail });
        continue;
      }
      const key = needKey(need);
      parsed.set(key, r.value.parsed);
      evidenceIds.set(key, await saveSnapshot(deps, r.value, { purpose: 'forecast', templateId }));
    }
    const data: WorldData = {
      get: <K extends NeedKind>(need: Extract<WorldNeed, { kind: K }>) => parsed.get(needKey(need)) as WorldNeedData[K] | undefined,
    };

    for (const c of template.candidates(ctx, data)) {
      const sameDay = await deps.questions.listByTargetDates(userId, c.spec.targetDate, c.spec.targetDate);
      const existing = sameDay.find((q) => q.templateId === template.id && 'slot' in q.meta && q.meta.slot === c.spec.meta.slot);
      const { id, created } = existing ? { id: existing.id, created: false } : await deps.questions.insertIfAbsent({ ...c.spec, userId, locationId: null });
      stats.questionsSeen++;
      if (created) stats.questionsCreated++;
      const already = created ? new Set<string>() : new Set((await deps.forecasts.forQuestions([id])).map((f) => f.forecasterId));
      const lockAt = existing?.lockAt ?? c.spec.lockAt;
      const cite = (needs: readonly WorldNeed[]) => needs.flatMap((n) => evidenceIds.get(needKey(n)) ?? []);
      const linked = new Set<string>();
      for (const fid of template.forecasters) {
        if (already.has(fid)) continue;
        const out = WORLD_FORECASTERS.find((f) => f.id === fid)?.forecast(c.inputs);
        if (!out) continue;
        const madeAt = deps.clock.now();
        if (!acceptsForecastAt(lockAt, madeAt)) continue;
        const ids = cite(c.evidence[out.uses]);
        for (const e of ids) linked.add(e);
        await deps.forecasts.insert({ questionId: id, forecasterId: fid, p: out.p, madeAt, rationale: out.rationale, evidenceIds: ids });
        stats.forecastsWritten++;
      }
      if (linked.size) await deps.questions.linkEvidence(id, [...linked]);
    }
    deps.logger.info('generate_world.done', { templateId, userId, today: ctx.today, ...stats });
    return { ok: true, value: stats };
  };
}

/**
 * Enqueue one `generate.world` item per user and applicable world template once the user's
 * generation is due (the same lead as place generation). Safe to call from every tick.
 */
export function enqueueDueWorldGeneration(deps: { clock: Clock; users: UserRepo; locations: LocationRepo; queue: WorkQueue; topics: TopicRepo }) {
  return async (): Promise<number> => {
    const now = deps.clock.now();
    let enqueued = 0;
    const withPlaces = new Set((await deps.locations.all()).map((l) => l.userId));
    for (const user of await deps.users.all()) {
      // A user who has not finished onboarding has no brief to put these in yet.
      if (!withPlaces.has(user.id)) continue;
      if (localMinutes(now, user.tz) < timeToMinutes(user.briefTime) - GENERATE_LEAD_MINUTES) continue;
      const today = localDate(now, user.tz);
      const ctx: WorldCtx = {
        now,
        today,
        tz: user.tz,
        briefMinutes: timeToMinutes(user.briefTime),
        topics: enabledTopics(await deps.topics.list(user.id)),
        watch: DEFAULT_WATCH,
      };
      for (const t of WORLD_TEMPLATES) {
        // Topics are seeded by the first run, so the surge template is always given its chance.
        if (t.id !== 'news.topic_surge' && !t.appliesTo(ctx)) continue;
        await deps.queue.enqueue(
          'generate.world',
          { userId: user.id, templateId: t.id },
          { dedupeKey: `generate.world:${t.id}:${user.id}:${today}`, maxAttempts: 4 },
        );
        enqueued++;
      }
    }
    return enqueued;
  };
}
