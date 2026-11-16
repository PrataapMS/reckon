import {
  createPool,
  FeedAdapter,
  FrankfurterAdapter,
  FsEvidenceStore,
  GdeltAdapter,
  GfzKpAdapter,
  GitHubReleasesAdapter,
  HackerNewsAdapter,
  MemoryClimatologyRepo,
  MemoryEvidenceRepo,
  MemoryEvidenceStore,
  MemoryFeedStateRepo,
  MemoryForecastRepo,
  MemoryJobRuns,
  MemoryLinkTokenRepo,
  MemoryLocationRepo,
  MemoryNewsRepo,
  MemoryOutboxRepo,
  MemoryPushSubscriptionRepo,
  MemoryQuestionRepo,
  MemoryResolutionRepo,
  MemoryScoreReader,
  type MemoryStore,
  MemoryTopicRepo,
  MemoryUserRepo,
  MemoryWorkQueue,
  NetlifyBlobsEvidenceStore,
  nodeHasher,
  nodeTokens,
  OpenMeteoAirQualityAdapter,
  OpenMeteoEnsembleAdapter,
  OpenMeteoForecastAdapter,
  OpenMeteoGeocodingAdapter,
  OpenMeteoHistoryAdapter,
  OpenMeteoPastDayAdapter,
  PgClimatologyRepo,
  PgEvidenceRepo,
  PgFeedStateRepo,
  PgForecastRepo,
  PgHealthReader,
  PgJobRunRecorder,
  PgLinkTokenRepo,
  PgLocationRepo,
  PgNewsRepo,
  PgOutboxRepo,
  PgPushSubscriptionRepo,
  PgQuestionRepo,
  PgResolutionRepo,
  PgScoreReader,
  PgTopicRepo,
  PgUserRepo,
  PgWorkQueue,
  StatusPageAdapter,
  SwpcSpaceWeatherAdapter,
  TelegramMessenger,
  UsgsEarthquakeAdapter,
  WebPushSender,
} from '@reckon/adapters';
import {
  type AirQualityPort,
  addLocation,
  addTopic,
  buildDueBriefs,
  buildDueReveals,
  buildPreviewBrief,
  type ClimatologyRepo,
  type Clock,
  createTelegramLink,
  type DailyObservationPort,
  drainWorkQueue,
  type EnsemblePort,
  type EvidenceRepo,
  type EvidenceStore,
  enqueueDueGeneration,
  enqueueDueWorldGeneration,
  type FeedPort,
  type FeedStateRepo,
  type ForecastRepo,
  type FxPort,
  frankfurterResolver,
  type GeocodingPort,
  gdeltVolumeResolver,
  generateForLocation,
  generateWorldTemplate,
  getCalibration,
  getEvidenceRaw,
  getMe,
  getQuestionDetail,
  getReveal,
  getScoreboard,
  getTodayBrief,
  githubReleasesResolver,
  type HackerNewsPort,
  type HealthReader,
  type HistoryPort,
  handleTelegramMessage,
  type JobRunRecorder,
  type KpHistoryPort,
  type LinkTokenRepo,
  type LocationRepo,
  type Logger,
  listQuestions,
  listTopics,
  lockAndEnqueueResolutions,
  type Messenger,
  type NewsRepo,
  type NewsSearchPort,
  type NewsVolumePort,
  type OutboxRepo,
  openMeteoDailyResolver,
  type PushSender,
  type PushSubscriptionRepo,
  type QuakePort,
  type QuestionRepo,
  type ReleasePort,
  type ResolutionRepo,
  removeLocation,
  removeTopic,
  resolveQuestion,
  runNewsCycle,
  type ScoreReader,
  type SpaceWeatherPort,
  type StatusPagePort,
  sendOutbox,
  statuspageResolver,
  subscribePush,
  swpcKpResolver,
  type TopicRepo,
  type UserRepo,
  unsubscribePush,
  updateLocation,
  updateMe,
  usgsResolver,
  type WeatherPort,
  type WorkHandler,
  type WorkQueue,
} from '@reckon/core';
import type pg from 'pg';
import { appUrl, type Config, evidenceStoreKind, loadConfig } from './config';
import { jsonLogger } from './logger';

/** Every external source behind a port, so tests and the E2E stack can swap in fakes. */
export interface Sources {
  readonly weather: WeatherPort;
  readonly air: AirQualityPort;
  readonly ensemble: EnsemblePort;
  readonly history: HistoryPort;
  readonly observations: DailyObservationPort;
  readonly geocoding: GeocodingPort;
  // Phase 2
  readonly fx: FxPort;
  readonly quakes: QuakePort;
  readonly kpHistory: KpHistoryPort;
  readonly space: SpaceWeatherPort;
  readonly releases: ReleasePort;
  readonly status: StatusPagePort;
  readonly newsVolume: NewsVolumePort;
  readonly newsSearch: NewsSearchPort;
  readonly feeds: FeedPort;
  readonly hackerNews: HackerNewsPort;
}

/** Every repository behind a port: Postgres in production, memory in tests and the E2E stack. */
export interface Repos {
  readonly queue: WorkQueue;
  readonly jobRuns: JobRunRecorder;
  readonly health: HealthReader;
  readonly users: UserRepo;
  readonly locations: LocationRepo;
  readonly questions: QuestionRepo;
  readonly forecasts: ForecastRepo;
  readonly resolutions: ResolutionRepo;
  readonly evidence: EvidenceRepo;
  readonly scores: ScoreReader;
  readonly outbox: OutboxRepo;
  readonly linkTokens: LinkTokenRepo;
  readonly climatology: ClimatologyRepo;
  readonly topics: TopicRepo;
  readonly news: NewsRepo;
  readonly feedState: FeedStateRepo;
  readonly push: PushSubscriptionRepo;
}

export function pgRepos(pool: pg.Pool): Repos {
  return {
    queue: new PgWorkQueue(pool),
    jobRuns: new PgJobRunRecorder(pool),
    health: new PgHealthReader(pool),
    users: new PgUserRepo(pool),
    locations: new PgLocationRepo(pool),
    questions: new PgQuestionRepo(pool, nodeHasher),
    forecasts: new PgForecastRepo(pool),
    resolutions: new PgResolutionRepo(pool),
    evidence: new PgEvidenceRepo(pool),
    scores: new PgScoreReader(pool),
    outbox: new PgOutboxRepo(pool),
    linkTokens: new PgLinkTokenRepo(pool),
    climatology: new PgClimatologyRepo(pool),
    topics: new PgTopicRepo(pool),
    news: new PgNewsRepo(pool, nodeHasher),
    feedState: new PgFeedStateRepo(pool),
    push: new PgPushSubscriptionRepo(pool),
  };
}

export function memoryRepos(store: MemoryStore): Repos {
  const runs = new MemoryJobRuns(store);
  return {
    queue: new MemoryWorkQueue(store),
    jobRuns: runs,
    health: runs,
    users: new MemoryUserRepo(store),
    locations: new MemoryLocationRepo(store),
    questions: new MemoryQuestionRepo(store, nodeHasher),
    forecasts: new MemoryForecastRepo(store),
    resolutions: new MemoryResolutionRepo(store),
    evidence: new MemoryEvidenceRepo(store),
    scores: new MemoryScoreReader(store),
    outbox: new MemoryOutboxRepo(store),
    linkTokens: new MemoryLinkTokenRepo(store),
    climatology: new MemoryClimatologyRepo(store),
    topics: new MemoryTopicRepo(store),
    news: new MemoryNewsRepo(store, nodeHasher),
    feedState: new MemoryFeedStateRepo(store),
    push: new MemoryPushSubscriptionRepo(store),
  };
}

export interface Overrides {
  readonly clock?: Clock;
  readonly logger?: Logger;
  readonly sources?: Partial<Sources>;
  readonly evidenceStore?: EvidenceStore;
  readonly messenger?: Messenger;
  readonly pushSender?: PushSender;
  /** Use these repositories instead of connecting to DATABASE_URL. */
  readonly repos?: Repos;
}

function buildApp(
  config: Config,
  clock: Clock,
  logger: Logger,
  sources: Sources,
  repos: Repos,
  evidenceStore: EvidenceStore,
  messenger: Messenger | undefined,
  pushSender: PushSender | undefined,
) {
  const { queue, users, locations, questions, forecasts, resolutions, evidence, scores, outbox, linkTokens, climatology, topics, news, feedState } = repos;
  const resolvers = [
    openMeteoDailyResolver(sources.observations),
    frankfurterResolver(sources.fx),
    usgsResolver(sources.quakes),
    swpcKpResolver(sources.space),
    githubReleasesResolver(sources.releases),
    statuspageResolver(sources.status),
    gdeltVolumeResolver(sources.newsVolume),
  ];
  const url = appUrl(config);
  // Without VAPID keys there is no Web Push channel at all.
  const push = pushSender ? repos.push : undefined;

  const viewDeps = { clock, users, questions, forecasts, resolutions, evidence, evidenceStore, scores, news };
  const brief = getTodayBrief(viewDeps);
  const reveal = getReveal(viewDeps);
  const generate = generateForLocation({
    clock,
    logger,
    weather: sources.weather,
    air: sources.air,
    ensemble: sources.ensemble,
    history: sources.history,
    climatology,
    evidenceStore,
    evidence,
    hasher: nodeHasher,
    users,
    locations,
    questions,
    forecasts,
  });

  const generateWorld = generateWorldTemplate({
    clock,
    logger,
    users,
    locations,
    questions,
    forecasts,
    topics,
    evidenceStore,
    evidence,
    hasher: nodeHasher,
    world: {
      fx: sources.fx,
      quakes: sources.quakes,
      kpHistory: sources.kpHistory,
      space: sources.space,
      releases: sources.releases,
      status: sources.status,
      newsVolume: sources.newsVolume,
    },
  });
  const generateWorldHandler: WorkHandler = async (item) => {
    const p = item.payload as { userId?: unknown; templateId?: unknown } | null;
    if (typeof p?.userId !== 'string' || typeof p.templateId !== 'string') return { status: 'fail', error: 'payload needs userId and templateId' };
    const r = await generateWorld(p.userId, p.templateId);
    if (!r.ok) return { status: 'fail', error: r.error.code };
    if (r.value.sourceErrors.length) return { status: 'retry', error: r.value.sourceErrors.join(','), runAfter: new Date(clock.now().getTime() + 20 * 60_000) };
    return { status: 'done' };
  };

  const generateHandler: WorkHandler = async (item) => {
    const p = item.payload as { locationId?: unknown } | null;
    if (typeof p?.locationId !== 'string') return { status: 'fail', error: 'payload has no locationId' };
    const r = await generate(p.locationId);
    if (!r.ok) return { status: 'fail', error: r.error.code };
    // A failed source leaves forecasts missing; a retry before lock fills them in.
    if (r.value.sourceErrors.length) return { status: 'retry', error: r.value.sourceErrors.join(','), runAfter: new Date(clock.now().getTime() + 20 * 60_000) };
    return { status: 'done' };
  };

  const handlers: Readonly<Record<string, WorkHandler>> = {
    noop: async () => ({ status: 'done' }),
    generate: generateHandler,
    'generate.world': generateWorldHandler,
    resolve: resolveQuestion({ clock, logger, questions, resolutions, queue, resolvers, evidenceStore, evidence, hasher: nodeHasher }),
  };

  const settingsDeps = { users, locations, scores };
  const topicDeps = { topics, locations };
  return {
    handlers,
    primaryUserId: async () => (await users.primary())?.id ?? null,
    generate,
    enqueueDueGeneration: enqueueDueGeneration({ clock, users, locations, queue }),
    enqueueDueWorldGeneration: enqueueDueWorldGeneration({ clock, users, locations, queue, topics }),
    generateWorld,
    runNews: runNewsCycle({
      clock,
      logger,
      users,
      locations,
      topics,
      questions,
      news,
      feedState,
      feeds: sources.feeds,
      hackerNews: sources.hackerNews,
      search: sources.newsSearch,
    }),
    scoreboard: getScoreboard({ scores }),
    calibration: getCalibration({ scores }),
    topics: listTopics(topicDeps),
    addTopic: addTopic(topicDeps),
    removeTopic: removeTopic(topicDeps),
    pushKey: pushSender?.publicKey ?? null,
    subscribePush: subscribePush({ push: repos.push }),
    unsubscribePush: unsubscribePush({ push: repos.push }),
    lockAndEnqueueResolutions: lockAndEnqueueResolutions({ clock, questions, queue, resolvers }),
    buildDueBriefs: buildDueBriefs({ clock, logger, users, outbox, brief, ...(url ? { appUrl: url } : {}), ...(push ? { push } : {}) }),
    buildDueReveals: buildDueReveals({ clock, logger, users, outbox, reveal, ...(url ? { appUrl: url } : {}), ...(push ? { push } : {}) }),
    sendOutbox: sendOutbox({ clock, logger, users, outbox, messenger, ...(url ? { appUrl: url } : {}), ...(push && pushSender ? { push, pushSender } : {}) }),
    brief,
    reveal,
    questionDetail: getQuestionDetail(viewDeps),
    listQuestions: listQuestions(viewDeps),
    evidenceRaw: getEvidenceRaw(viewDeps),
    me: getMe(settingsDeps),
    updateMe: updateMe(settingsDeps),
    addLocation: addLocation({
      ...settingsDeps,
      onAdded: async (loc) => {
        const r = await generate(loc.id).catch((e: unknown) => {
          logger.warn('location.generate_failed', { error: String(e) });
          return null;
        });
        // Whatever the immediate run missed, the queue retries.
        if (!r?.ok || r.value.sourceErrors.length) await queue.enqueue('generate', { locationId: loc.id }, { maxAttempts: 4 });
      },
    }),
    updateLocation: updateLocation(settingsDeps),
    removeLocation: removeLocation(settingsDeps),
    telegramLink: createTelegramLink({ clock, tokens: nodeTokens, linkTokens, botUsername: config.TELEGRAM_BOT_USERNAME }),
    telegramMessage: handleTelegramMessage({
      clock,
      logger,
      users,
      linkTokens,
      messenger,
      brief,
      reveal: (userId, date) => reveal(userId, date),
      ...(url ? { appUrl: url } : {}),
    }),
  };
}

export type AppServices = ReturnType<typeof buildApp>;

/**
 * Composition root (spec §2.2): the ONLY place where concrete adapters are wired into use cases.
 * Everything database-backed is optional so the app still serves a live preview brief before
 * Postgres is configured.
 */
export interface Container {
  readonly config: Config;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly previewBrief: ReturnType<typeof buildPreviewBrief>;
  readonly geocoding?: GeocodingPort;
  readonly messenger?: Messenger;
  readonly db?: {
    readonly pool?: pg.Pool;
    readonly queue: WorkQueue;
    readonly jobRuns: JobRunRecorder;
    readonly health: HealthReader;
    readonly drain: ReturnType<typeof drainWorkQueue>;
    readonly app: AppServices;
  };
}

let cached: Container | undefined;

export function compose(env: Record<string, string | undefined> = process.env, overrides: Overrides = {}): Container {
  if (cached) return cached;
  cached = build(env, overrides);
  return cached;
}

/** Build a fresh container without caching (tests, scripts, the E2E server). */
export function build(env: Record<string, string | undefined> = process.env, overrides: Overrides = {}): Container {
  const config = loadConfig(env);
  const clock: Clock = overrides.clock ?? { now: () => new Date() };
  const logger = overrides.logger ?? jsonLogger({ app: 'reckon' });
  const userAgent = `Reckon/0.1 (+personal forecasting; ${config.CONTACT_EMAIL})`;
  const now = () => clock.now();
  // One GDELT client per process, so its 5-second politeness gap covers both ports.
  const gdelt = new GdeltAdapter({ userAgent, now });
  const sources: Sources = {
    weather: new OpenMeteoForecastAdapter({ userAgent, now }),
    air: new OpenMeteoAirQualityAdapter({ userAgent, now }),
    ensemble: new OpenMeteoEnsembleAdapter({ userAgent, now }),
    history: new OpenMeteoHistoryAdapter({ userAgent, now }),
    observations: new OpenMeteoPastDayAdapter({ userAgent, now }),
    geocoding: new OpenMeteoGeocodingAdapter({ userAgent, now }),
    fx: new FrankfurterAdapter({ userAgent, now }),
    quakes: new UsgsEarthquakeAdapter({ userAgent, now }),
    kpHistory: new GfzKpAdapter({ userAgent, now }),
    space: new SwpcSpaceWeatherAdapter({ userAgent, now }),
    releases: new GitHubReleasesAdapter({ userAgent, now, ...(config.GITHUB_TOKEN ? { token: config.GITHUB_TOKEN } : {}) }),
    status: new StatusPageAdapter({ userAgent, now }),
    newsVolume: gdelt,
    newsSearch: gdelt,
    feeds: new FeedAdapter({ userAgent, now }),
    hackerNews: new HackerNewsAdapter({ userAgent, now }),
    ...overrides.sources,
  };
  const pushSender =
    overrides.pushSender ??
    (config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY
      ? new WebPushSender({
          publicKey: config.VAPID_PUBLIC_KEY,
          privateKey: config.VAPID_PRIVATE_KEY,
          subject: config.VAPID_SUBJECT ?? `mailto:${config.CONTACT_EMAIL}`,
        })
      : undefined);
  const messenger = overrides.messenger ?? (config.TELEGRAM_BOT_TOKEN ? new TelegramMessenger({ token: config.TELEGRAM_BOT_TOKEN }) : undefined);

  let db: Container['db'];
  const pool = overrides.repos ? undefined : config.DATABASE_URL ? createPool(config.DATABASE_URL) : undefined;
  const repos = overrides.repos ?? (pool ? pgRepos(pool) : undefined);
  if (repos) {
    const kind = evidenceStoreKind(config);
    const evidenceStore =
      overrides.evidenceStore ??
      (kind === 'netlify' ? new NetlifyBlobsEvidenceStore() : kind === 'memory' ? new MemoryEvidenceStore() : new FsEvidenceStore(config.EVIDENCE_DIR));
    db = {
      ...(pool ? { pool } : {}),
      queue: repos.queue,
      jobRuns: repos.jobRuns,
      health: repos.health,
      drain: drainWorkQueue({ queue: repos.queue, clock, logger }),
      app: buildApp(config, clock, logger, sources, repos, evidenceStore, messenger, pushSender),
    };
  }

  return {
    config,
    clock,
    logger,
    previewBrief: buildPreviewBrief({ weather: sources.weather, air: sources.air, clock }),
    geocoding: sources.geocoding,
    ...(messenger ? { messenger } : {}),
    ...(db ? { db } : {}),
  };
}

/** Test helper: forget the cached container. */
export function resetContainer(): void {
  cached = undefined;
}
