import type { Criteria, Observation } from '../domain/criteria';
import type { DailyAirQuality, DailyMetric, DailySeries, DailyWeather, EnsembleDay, Place } from '../domain/data';
import type { Result } from '../domain/result';
import type { Outcome } from '../domain/scoring';
import type { Domain, QuestionMeta, QuestionSpec, UserSettings } from '../domain/templates';
import type { FxRate, GeomagForecast, IncidentList, KpPoint, Quake, RawNewsItem, ReleaseList, VolumePoint } from '../domain/world-data';

/** Ports are interfaces only (spec §4). Adapters implement them; use cases depend on them. */

export interface Clock {
  now(): Date;
}

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export type SourceErrorCode = 'timeout' | 'rate_limited' | 'schema_changed' | 'not_found' | 'upstream_5xx' | 'network';
export interface SourceError {
  readonly code: SourceErrorCode;
  readonly sourceId: string;
  readonly detail?: string;
}

/** Every external fetch is kept as evidence: the raw bytes plus where and when they came from. */
export interface SourceSnapshot<T> {
  readonly sourceId: string;
  readonly fetchedAt: string;
  readonly requestUrl: string;
  readonly raw: string;
  readonly parsed: T;
  /** Media type of `raw`; JSON unless the source publishes text or XML. */
  readonly contentType?: string;
}

export type { DailyAirQuality, DailyMetric, DailySeries, DailyWeather, EnsembleDay, Place } from '../domain/data';
export type {
  FxRate,
  GeomagDay,
  GeomagForecast,
  Incident,
  IncidentImpact,
  IncidentList,
  KpPoint,
  NewsOrigin,
  Quake,
  RawNewsItem,
  Release,
  ReleaseList,
  VolumePoint,
} from '../domain/world-data';

export interface LocationQuery {
  readonly lat: number;
  readonly lon: number;
  readonly tz: string;
  readonly days: number;
  /** Include this many complete past days before today (for persistence and resolution). */
  readonly pastDays?: number;
}

export interface WeatherPort {
  dailyForecast(q: LocationQuery): Promise<Result<SourceSnapshot<DailyWeather[]>, SourceError>>;
}

export interface AirQualityPort {
  dailyForecast(q: LocationQuery): Promise<Result<SourceSnapshot<DailyAirQuality[]>, SourceError>>;
}

export interface WorkItem {
  readonly id: number;
  readonly kind: string;
  readonly payload: unknown;
  readonly attempts: number;
  readonly maxAttempts: number;
}

export interface WorkQueue {
  enqueue(kind: string, payload: unknown, opts?: { dedupeKey?: string; runAfter?: Date; maxAttempts?: number }): Promise<void>;
  claim(limit: number, leaseSeconds: number): Promise<WorkItem[]>;
  complete(id: number): Promise<void>;
  retryLater(id: number, error: string, runAfter: Date): Promise<void>;
  giveUp(id: number, error: string): Promise<void>;
  depth(): Promise<number>;
}

export interface JobRunRecorder {
  start(job: string): Promise<number>;
  finish(id: number, status: 'ok' | 'error', stats: Record<string, unknown>): Promise<void>;
}

export interface JobRunSummary {
  readonly job: string;
  readonly lastStartedAt: string;
  readonly lastStatus: string | null;
  readonly lastOkAt: string | null;
}

export interface HealthReader {
  jobRuns(): Promise<JobRunSummary[]>;
  queueDepth(): Promise<number>;
}

// ---------------------------------------------------------------------------
// Phase 1 sources
// ---------------------------------------------------------------------------

export interface EnsemblePort {
  dailyMembers(q: LocationQuery): Promise<Result<SourceSnapshot<EnsembleDay[]>, SourceError>>;
}

export interface HistoryQuery {
  readonly lat: number;
  readonly lon: number;
  readonly tz: string;
  readonly start: string;
  readonly end: string;
}

/** Long daily history for climatology (ERA5 for weather, CAMS reanalysis for air). */
export interface HistoryPort {
  dailyHistory(q: HistoryQuery, metric: DailyMetric): Promise<Result<SourceSnapshot<DailySeries>, SourceError>>;
}

export interface DayQuery {
  readonly lat: number;
  readonly lon: number;
  readonly tz: string;
  readonly date: string;
  readonly metric: DailyMetric;
}

/** What the declared dataset reported for one local day (used by resolvers). */
export interface DailyObservationPort {
  observeDay(q: DayQuery): Promise<Result<SourceSnapshot<{ readonly value: number | null }>, SourceError>>;
}

export interface GeoPlace {
  readonly name: string;
  readonly region: string;
  readonly country: string;
  readonly lat: number;
  readonly lon: number;
  readonly tz: string;
}

export interface GeocodingPort {
  search(name: string): Promise<Result<GeoPlace[], SourceError>>;
}

// ---------------------------------------------------------------------------
// Phase 2 sources (spec §3.1). Each has one adapter in packages/adapters/src/sources/<source>.
// ---------------------------------------------------------------------------

type Fetched<T> = Promise<Result<SourceSnapshot<T>, SourceError>>;

/** Frankfurter (ECB reference rates). Dates are ECB working days; holidays are simply absent. */
export interface FxPort {
  dailyRates(q: { readonly base: string; readonly quote: string; readonly start: string; readonly end: string }): Fetched<FxRate[]>;
}

/** USGS earthquake catalogue: every event at or above a magnitude in [start, end). */
export interface QuakePort {
  events(q: { readonly minMagnitude: number; readonly start: string; readonly end: string }): Fetched<Quake[]>;
}

/** Long Kp history (GFZ Potsdam), used for base rates. Instants in [start, end]. */
export interface KpHistoryPort {
  kpHistory(q: { readonly start: string; readonly end: string }): Fetched<KpPoint[]>;
}

/** NOAA SWPC: the observed planetary Kp of the last 7 days, and the 3-day geomagnetic forecast. */
export interface SpaceWeatherPort {
  observedKp(): Fetched<KpPoint[]>;
  geomagForecast(): Fetched<GeomagForecast>;
}

/** GitHub releases of one repository ('owner/name'), newest first. */
export interface ReleasePort {
  releases(repo: string): Fetched<ReleaseList>;
}

/** A public Atlassian Statuspage, by host (e.g. 'www.githubstatus.com'). */
export interface StatusPagePort {
  incidents(host: string): Fetched<IncidentList>;
}

/** GDELT DOC 2.0 timeline: matching articles per UTC day for start..end (inclusive dates). */
export interface NewsVolumePort {
  dailyVolume(q: { readonly query: string; readonly start: string; readonly end: string }): Fetched<VolumePoint[]>;
}

/** GDELT DOC 2.0 article list: recent articles matching a query. */
export interface NewsSearchPort {
  articles(q: { readonly query: string; readonly hours: number; readonly max: number }): Fetched<RawNewsItem[]>;
}

export interface FeedRef {
  readonly id: string;
  readonly url: string;
  readonly name: string;
}

/** A conditional fetch result: nothing new since the last ETag / Last-Modified. */
export type FeedFetch =
  | { readonly notModified: true }
  | { readonly notModified: false; readonly snapshot: SourceSnapshot<RawNewsItem[]>; readonly etag: string | null; readonly lastModified: string | null };

/** RSS 2.0 and Atom feeds, fetched with If-None-Match / If-Modified-Since. */
export interface FeedPort {
  fetchFeed(feed: FeedRef, cache: { readonly etag: string | null; readonly lastModified: string | null }): Promise<Result<FeedFetch, SourceError>>;
}

/** Hacker News front page. */
export interface HackerNewsPort {
  frontPage(): Fetched<RawNewsItem[]>;
}

/** Raw evidence bytes (Netlify Blobs in production). Keys are content-addressed. */
export interface EvidenceStore {
  put(key: string, body: string, contentType: string): Promise<void>;
  get(key: string): Promise<{ readonly body: string; readonly contentType: string } | null>;
}

export interface Hasher {
  sha256(text: string): string;
}

export interface TokenSource {
  /** A URL-safe random token. */
  token(bytes?: number): string;
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

export interface User {
  readonly id: string;
  readonly displayName: string | null;
  readonly tz: string;
  readonly briefTime: string; // 'HH:MM'
  readonly revealTime: string;
  readonly quietStart: string;
  readonly quietEnd: string;
  readonly telegramChatId: string | null;
  readonly onboardedAt: string | null;
  readonly paused: boolean;
  readonly settings: UserSettings;
}

export type UserPatch = Partial<Pick<User, 'displayName' | 'tz' | 'briefTime' | 'revealTime' | 'quietStart' | 'quietEnd' | 'paused' | 'settings'>> & {
  readonly onboarded?: boolean;
};

export interface UserRepo {
  /** Reckon is single-user for now (spec §1.2 non-goals); this is that user. */
  primary(): Promise<User | null>;
  byId(id: string): Promise<User | null>;
  byTelegramChat(chatId: string): Promise<User | null>;
  all(): Promise<User[]>;
  update(id: string, patch: UserPatch): Promise<User | null>;
  setTelegramChat(id: string, chatId: string | null): Promise<void>;
}

export interface Location extends Place {
  readonly userId: string;
  readonly isPrimary: boolean;
}

export interface LocationInput {
  readonly name: string;
  readonly lat: number;
  readonly lon: number;
  readonly tz: string;
  readonly isPrimary?: boolean;
}

export interface LocationRepo {
  list(userId: string): Promise<Location[]>;
  all(): Promise<Location[]>;
  get(id: string): Promise<Location | null>;
  create(userId: string, input: LocationInput): Promise<Location>;
  update(id: string, patch: Partial<LocationInput>): Promise<Location | null>;
  remove(id: string): Promise<boolean>;
}

export interface EvidenceRecord {
  readonly id: string;
  readonly sourceId: string;
  readonly kind: 'snapshot' | 'news';
  readonly title?: string | null;
  readonly fetchedAt: string;
  readonly blobKey: string | null;
  readonly sha256: string;
  readonly url: string | null;
  readonly meta: Record<string, unknown>;
}

export interface EvidenceRepo {
  insertSnapshot(e: Omit<EvidenceRecord, 'id' | 'kind'>): Promise<string>;
  get(id: string): Promise<EvidenceRecord | null>;
}

export type QuestionStatusValue = 'open' | 'locked' | 'resolving' | 'resolved' | 'annulled';

export interface QuestionRecord {
  readonly id: string;
  readonly userId: string;
  readonly locationId: string | null;
  readonly templateId: string | null;
  readonly templateVersion: number | null;
  readonly domain: Domain;
  readonly title: string;
  readonly criteria: Criteria;
  readonly criteriaHash: string;
  readonly horizonDays: number;
  readonly correlationGroup: string;
  readonly lockAt: Date;
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly status: QuestionStatusValue;
  readonly annulReason: string | null;
  readonly targetDate: string;
  readonly meta: QuestionMeta;
  readonly createdAt: Date;
}

export interface NewQuestion extends QuestionSpec {
  readonly userId: string;
  /** Null for world questions, which are about no particular place. */
  readonly locationId: string | null;
}

export interface QuestionRepo {
  insertIfAbsent(q: NewQuestion): Promise<{ readonly id: string; readonly created: boolean }>;
  get(id: string): Promise<QuestionRecord | null>;
  /** open -> locked for every question whose lock time has passed. */
  lockDue(now: Date): Promise<number>;
  /** Locked questions whose window closed at least `delayHours` ago. */
  dueForResolution(now: Date, delayHours: number, limit: number): Promise<QuestionRecord[]>;
  /** Compare-and-set status change; false if the question was not in `from`. */
  transition(id: string, from: QuestionStatusValue, to: QuestionStatusValue): Promise<boolean>;
  listByTargetDates(userId: string, from: string, to: string): Promise<QuestionRecord[]>;
  linkEvidence(questionId: string, evidenceIds: readonly string[]): Promise<void>;
  evidenceFor(questionId: string): Promise<EvidenceRecord[]>;
}

export interface ForecastRecord {
  readonly id: string;
  readonly questionId: string;
  readonly forecasterId: string;
  readonly p: number;
  readonly madeAt: Date;
  readonly rationale: string | null;
  readonly evidenceIds: readonly string[];
}

export interface ForecastRepo {
  insert(f: Omit<ForecastRecord, 'id'>): Promise<void>;
  forQuestions(questionIds: readonly string[]): Promise<ForecastRecord[]>;
}

export interface ResolutionRecord {
  readonly id: string;
  readonly questionId: string;
  readonly outcome: Outcome | null;
  readonly observedValue: number | null;
  readonly observedUnit: string | null;
  readonly evidenceId: string | null;
  readonly resolverVersion: string;
  readonly resolvedAt: Date;
}

export interface NewResolution {
  readonly questionId: string;
  readonly outcome: Outcome | null; // null = annulled
  readonly observedValue: number | null;
  readonly observedUnit: string | null;
  readonly evidenceId: string | null;
  readonly resolverVersion: string;
  readonly annulReason?: string;
}

export interface ResolutionRepo {
  /** Spec §3.4 step 4, in one transaction: insert the resolution and move resolving -> resolved|annulled. */
  record(r: NewResolution): Promise<boolean>;
  latestFor(questionIds: readonly string[]): Promise<ResolutionRecord[]>;
}

export interface ClimatologyEntry {
  readonly sourceId: string;
  readonly evidenceId: string | null;
  readonly series: DailySeries;
  readonly refreshedAt: Date;
}

export interface ClimatologyRepo {
  get(lat: number, lon: number, metric: DailyMetric): Promise<ClimatologyEntry | null>;
  put(lat: number, lon: number, metric: DailyMetric, entry: Omit<ClimatologyEntry, 'refreshedAt'>): Promise<void>;
}

export interface OutboxMessage {
  readonly text: string;
  readonly buttons?: readonly { readonly text: string; readonly url: string }[];
  /** Plain-text form for Web Push, which cannot render Telegram's HTML. */
  readonly push?: PushPayload;
}

export interface PushPayload {
  readonly title: string;
  readonly body: string;
  readonly path: string;
}

export type OutboxKind = 'brief' | 'reveal' | 'alert';
export type Channel = 'telegram' | 'webpush';

export interface OutboxEntry {
  readonly id: number;
  readonly userId: string | null;
  readonly channel: 'telegram' | 'webpush';
  readonly kind: OutboxKind;
  readonly payload: OutboxMessage;
  readonly createdAt: Date;
  readonly attempts: number;
}

export interface OutboxRepo {
  /** Returns false if an entry with this dedupe key already exists (nothing sent twice). */
  enqueue(e: { userId: string; channel: Channel; kind: OutboxKind; payload: OutboxMessage; dedupeKey: string; createdAt: Date }): Promise<boolean>;
  exists(dedupeKey: string): Promise<boolean>;
  pending(limit: number, maxAttempts: number): Promise<OutboxEntry[]>;
  markSent(id: number, at: Date): Promise<void>;
  markSkipped(id: number, reason: string, at: Date): Promise<void>;
  markFailed(id: number, error: string): Promise<void>;
  scheduledSentSince(userId: string, since: Date): Promise<number>;
}

/** One scored forecast: the last pre-lock p of one forecaster on one resolved question (the `scores` view). */
export interface ScoredForecast {
  readonly questionId: string;
  readonly templateId: string;
  readonly forecasterId: string;
  readonly domain: Domain;
  readonly horizonDays: number;
  readonly cluster: string;
  readonly p: number;
  readonly o: Outcome;
}

export interface ScoreReader {
  scored(userId: string): Promise<ScoredForecast[]>;
  /** Independent resolved days of place questions (weather and air), toward the first trust label. */
  resolvedClusterCount(userId: string): Promise<number>;
}

export interface LinkTokenRepo {
  create(userId: string, token: string, expiresAt: Date): Promise<void>;
  /** Marks the token used and returns its user, or null if unknown, used or expired. */
  consume(token: string, now: Date): Promise<string | null>;
}

export type MessengerError = { readonly code: 'blocked' | 'failed'; readonly detail?: string };

export interface Messenger {
  readonly channel: 'telegram';
  send(chatId: string, msg: OutboxMessage): Promise<Result<void, MessengerError>>;
}

/** Strategy for resolving questions (spec §3.4). The outcome is computed by evaluate(), never here. */
export interface Resolver {
  readonly id: string; // 'openmeteo.daily@1'
  /** The criteria `source.id`s this resolver judges (ADR-0005: the dataset fixes the resolver). */
  readonly sourceIds: readonly string[];
  readonly delayHours: number; // source publication delay after the window closes
  observe(c: Criteria, targetDate: string): Promise<Result<SourceSnapshot<Observation | null>, SourceError>>;
}

// ---------------------------------------------------------------------------
// Phase 2: topics, news, feeds, Web Push
// ---------------------------------------------------------------------------

export interface TopicRecord {
  readonly id: string;
  readonly userId: string;
  readonly key: string;
  readonly label: string;
  readonly query: string | null;
  readonly keywords: readonly string[];
  readonly enabled: boolean;
  readonly createdAt: Date;
}

export interface TopicRepo {
  /** Every topic the user ever had, including removed (disabled) ones. */
  list(userId: string): Promise<TopicRecord[]>;
  /** Insert, or re-enable an existing topic with the same key. */
  upsert(
    userId: string,
    t: { readonly key: string; readonly label: string; readonly query: string | null; readonly keywords: readonly string[] },
  ): Promise<TopicRecord>;
  setEnabled(userId: string, id: string, enabled: boolean): Promise<boolean>;
}

/** A headline after normalisation (spec §3.6 step 2). */
export interface NewsItem {
  readonly url: string;
  readonly canonicalUrl: string;
  readonly title: string;
  readonly source: string;
  readonly publishedAt: Date;
  readonly snippet: string | null;
  readonly lang: string | null;
  readonly origin: string;
  readonly simhash: bigint;
  readonly tags: readonly string[];
}

export interface NewsItemRecord extends NewsItem {
  readonly id: string;
  readonly fetchedAt: Date;
}

export interface LinkedNews {
  readonly evidenceId: string;
  readonly title: string;
  readonly source: string;
  readonly url: string;
  readonly publishedAt: string;
  readonly snippet: string | null;
  readonly relevance: number;
}

export interface NewsRepo {
  hasCanonicalUrl(urls: readonly string[]): Promise<Set<string>>;
  /** Title fingerprints of items published since `since`, for near-duplicate detection. */
  simhashesSince(since: Date): Promise<bigint[]>;
  insert(item: NewsItem, fetchedAt: Date): Promise<string>;
  /** Items published since `since` that carry at least one of `tags` and are not yet linked to the question. */
  unlinkedTagged(questionId: string, since: Date, tags: readonly string[]): Promise<NewsItemRecord[]>;
  /**
   * Link a headline to a question as evidence (spec §3.6 step 5). The first link turns the item into
   * a permanent `evidence` row; later links reuse it. Idempotent.
   */
  link(itemId: string, questionId: string, relevance: number): Promise<void>;
  linkedCount(questionId: string): Promise<number>;
  forQuestion(questionId: string): Promise<LinkedNews[]>;
  /** Spec §3.6 step 6: drop unlinked items older than `before`; linked ones live on as evidence. */
  prune(before: Date): Promise<number>;
}

export interface FeedState {
  readonly id: string;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly lastFetchedAt: Date | null;
  readonly lastStatus: string | null;
}

export interface FeedStateRepo {
  all(): Promise<FeedState[]>;
  put(s: FeedState): Promise<void>;
}

export interface PushSubscription {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
}

export interface PushSubscriptionRepo {
  add(userId: string, s: PushSubscription): Promise<void>;
  remove(userId: string, endpoint: string): Promise<boolean>;
  forUser(userId: string): Promise<PushSubscription[]>;
}

export type PushError = { readonly code: 'gone' | 'failed'; readonly detail?: string };

export interface PushSender {
  readonly publicKey: string;
  send(s: PushSubscription, payload: PushPayload): Promise<Result<void, PushError>>;
}
