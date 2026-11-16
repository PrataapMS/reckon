import {
  type ClimatologyEntry,
  type ClimatologyRepo,
  canonicalJson,
  type DailyMetric,
  type EvidenceRecord,
  type EvidenceRepo,
  type FeedState,
  type FeedStateRepo,
  type ForecastRecord,
  type ForecastRepo,
  type Hasher,
  type HealthReader,
  type JobRunRecorder,
  type JobRunSummary,
  type LinkedNews,
  type LinkTokenRepo,
  type Location,
  type LocationInput,
  type LocationRepo,
  type NewQuestion,
  type NewResolution,
  type NewsItem,
  type NewsItemRecord,
  type NewsRepo,
  type OutboxEntry,
  type OutboxKind,
  type OutboxMessage,
  type OutboxRepo,
  type PushSubscription,
  type PushSubscriptionRepo,
  type QuestionRecord,
  type QuestionRepo,
  type QuestionStatusValue,
  type ResolutionRecord,
  type ResolutionRepo,
  type ScoredForecast,
  type ScoreReader,
  type TopicRecord,
  type TopicRepo,
  type User,
  type UserPatch,
  type UserRepo,
  type WorkItem,
  type WorkQueue,
} from '@reckon/core';

/**
 * In-memory repositories for unit tests and the E2E fake stack. They enforce the same ledger
 * rules as the database triggers (forecasts strictly before lock; one resolution per question)
 * so a use case that would be rejected by Postgres is rejected here too.
 */

export interface MemoryClock {
  now(): Date;
}

let seq = 0;
const uuid = () => {
  seq++;
  const hex = seq.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
};

export class MemoryStore {
  users: User[] = [];
  locations: (Location & { createdAt: number })[] = [];
  questions: QuestionRecord[] = [];
  forecasts: ForecastRecord[] = [];
  resolutions: (ResolutionRecord & { supersedes?: string })[] = [];
  evidence: EvidenceRecord[] = [];
  questionEvidence: { questionId: string; evidenceId: string }[] = [];
  climatology = new Map<string, ClimatologyEntry>();
  outbox: (OutboxEntry & { dedupeKey: string; sentAt: Date | null; skippedAt: Date | null; skipReason: string | null })[] = [];
  linkTokens: { token: string; userId: string; expiresAt: Date; usedAt: Date | null }[] = [];
  work: (Omit<WorkItem, 'attempts'> & {
    attempts: number;
    dedupeKey: string | null;
    runAfter: Date;
    leasedUntil: Date | null;
    doneAt: Date | null;
    lastError: string | null;
  })[] = [];
  topics: TopicRecord[] = [];
  news: (NewsItemRecord & { evidenceId: string | null })[] = [];
  relevance = new Map<string, number>(); // `${questionId}|${evidenceId}`
  feedState = new Map<string, FeedState>();
  push: (PushSubscription & { userId: string })[] = [];
  jobRuns: { id: number; job: string; startedAt: Date; finishedAt: Date | null; status: 'ok' | 'error' | null; stats: Record<string, unknown> }[] = [];

  constructor(readonly clock: MemoryClock) {}

  addUser(partial: Partial<User> = {}): User {
    const u: User = {
      id: uuid(),
      displayName: null,
      tz: 'Asia/Kolkata',
      briefTime: '06:30',
      revealTime: '21:00',
      quietStart: '22:30',
      quietEnd: '06:00',
      telegramChatId: null,
      onboardedAt: null,
      paused: false,
      settings: {},
      ...partial,
    };
    this.users.push(u);
    return u;
  }
}

export class MemoryUserRepo implements UserRepo {
  constructor(private readonly s: MemoryStore) {}
  async primary() {
    return this.s.users[0] ?? null;
  }
  async byId(id: string) {
    return this.s.users.find((u) => u.id === id) ?? null;
  }
  async byTelegramChat(chatId: string) {
    return this.s.users.find((u) => u.telegramChatId === chatId) ?? null;
  }
  async all() {
    return [...this.s.users];
  }
  async update(id: string, patch: UserPatch) {
    const i = this.s.users.findIndex((u) => u.id === id);
    const u = this.s.users[i];
    if (!u) return null;
    const { onboarded, ...rest } = patch;
    const next: User = { ...u, ...rest, onboardedAt: onboarded && !u.onboardedAt ? this.s.clock.now().toISOString() : u.onboardedAt };
    this.s.users[i] = next;
    return next;
  }
  async setTelegramChat(id: string, chatId: string | null) {
    this.s.users = this.s.users.map((u) =>
      u.id === id ? { ...u, telegramChatId: chatId } : chatId && u.telegramChatId === chatId ? { ...u, telegramChatId: null } : u,
    );
  }
}

export class MemoryLocationRepo implements LocationRepo {
  constructor(private readonly s: MemoryStore) {}
  private strip = ({ createdAt: _, ...l }: Location & { createdAt: number }): Location => l;
  async list(userId: string) {
    return this.s.locations
      .filter((l) => l.userId === userId)
      .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.createdAt - b.createdAt)
      .map(this.strip);
  }
  async all() {
    return this.s.locations.map(this.strip);
  }
  async get(id: string) {
    const l = this.s.locations.find((x) => x.id === id);
    return l ? this.strip(l) : null;
  }
  async create(userId: string, input: LocationInput) {
    if (input.isPrimary) this.s.locations = this.s.locations.map((l) => (l.userId === userId ? { ...l, isPrimary: false } : l));
    const l = { id: uuid(), userId, name: input.name, lat: input.lat, lon: input.lon, tz: input.tz, isPrimary: input.isPrimary ?? false, createdAt: seq };
    this.s.locations.push(l);
    return this.strip(l);
  }
  async update(id: string, patch: Partial<LocationInput>) {
    const l = this.s.locations.find((x) => x.id === id);
    if (!l) return null;
    if (patch.isPrimary) this.s.locations = this.s.locations.map((x) => (x.userId === l.userId ? { ...x, isPrimary: false } : x));
    const next = { ...l, ...patch, isPrimary: patch.isPrimary ?? l.isPrimary };
    this.s.locations = this.s.locations.map((x) => (x.id === id ? next : x));
    return this.strip(next);
  }
  async remove(id: string) {
    const l = this.s.locations.find((x) => x.id === id);
    if (!l) return false;
    this.s.locations = this.s.locations.filter((x) => x.id !== id);
    if (l.isPrimary) {
      const next = this.s.locations.find((x) => x.userId === l.userId);
      if (next) this.s.locations = this.s.locations.map((x) => (x.id === next.id ? { ...x, isPrimary: true } : x));
    }
    return true;
  }
}

export class MemoryQuestionRepo implements QuestionRepo {
  constructor(
    private readonly s: MemoryStore,
    private readonly hasher: Hasher,
  ) {}
  async insertIfAbsent(q: NewQuestion) {
    const criteriaHash = this.hasher.sha256(canonicalJson(q.criteria));
    const existing = this.s.questions.find(
      (x) => x.userId === q.userId && x.templateId === q.templateId && x.criteriaHash === criteriaHash && x.horizonDays === q.horizonDays,
    );
    if (existing) return { id: existing.id, created: false };
    if (!(q.lockAt.getTime() <= q.windowStart.getTime() && q.windowStart.getTime() < q.windowEnd.getTime()))
      throw new Error('check constraint: lock <= start < end');
    const rec: QuestionRecord = {
      id: uuid(),
      userId: q.userId,
      locationId: q.locationId,
      templateId: q.templateId,
      templateVersion: q.templateVersion,
      domain: q.domain,
      title: q.title,
      criteria: JSON.parse(canonicalJson(q.criteria)),
      criteriaHash,
      horizonDays: q.horizonDays,
      correlationGroup: q.correlationGroup,
      lockAt: q.lockAt,
      windowStart: q.windowStart,
      windowEnd: q.windowEnd,
      status: 'open',
      annulReason: null,
      targetDate: q.targetDate,
      meta: q.meta,
      createdAt: this.s.clock.now(),
    };
    this.s.questions.push(rec);
    return { id: rec.id, created: true };
  }
  async get(id: string) {
    return this.s.questions.find((q) => q.id === id) ?? null;
  }
  private set(id: string, patch: Partial<QuestionRecord>) {
    this.s.questions = this.s.questions.map((q) => (q.id === id ? { ...q, ...patch } : q));
  }
  async lockDue(now: Date) {
    const due = this.s.questions.filter((q) => q.status === 'open' && q.lockAt.getTime() <= now.getTime());
    for (const q of due) this.set(q.id, { status: 'locked' });
    return due.length;
  }
  async dueForResolution(now: Date, delayHours: number, limit: number) {
    return this.s.questions
      .filter((q) => q.status === 'locked' && q.windowEnd.getTime() + delayHours * 3_600_000 <= now.getTime())
      .sort((a, b) => a.windowEnd.getTime() - b.windowEnd.getTime())
      .slice(0, limit);
  }
  async transition(id: string, from: QuestionStatusValue, to: QuestionStatusValue) {
    const q = this.s.questions.find((x) => x.id === id);
    if (!q || q.status !== from) return false;
    this.set(id, { status: to });
    return true;
  }
  async listByTargetDates(userId: string, from: string, to: string) {
    return this.s.questions.filter((q) => q.userId === userId && q.targetDate >= from && q.targetDate <= to);
  }
  async linkEvidence(questionId: string, evidenceIds: readonly string[]) {
    for (const evidenceId of evidenceIds) {
      if (!this.s.questionEvidence.some((x) => x.questionId === questionId && x.evidenceId === evidenceId))
        this.s.questionEvidence.push({ questionId, evidenceId });
    }
  }
  async evidenceFor(questionId: string) {
    const ids = new Set(this.s.questionEvidence.filter((x) => x.questionId === questionId).map((x) => x.evidenceId));
    return this.s.evidence.filter((e) => ids.has(e.id));
  }
}

export class MemoryEvidenceRepo implements EvidenceRepo {
  constructor(private readonly s: MemoryStore) {}
  async insertSnapshot(e: Omit<EvidenceRecord, 'id' | 'kind'>) {
    const id = uuid();
    this.s.evidence.push({ ...e, id, kind: 'snapshot' });
    return id;
  }
  async get(id: string) {
    return this.s.evidence.find((e) => e.id === id) ?? null;
  }
}

export class MemoryForecastRepo implements ForecastRepo {
  constructor(private readonly s: MemoryStore) {}
  async insert(f: Omit<ForecastRecord, 'id'>) {
    const q = this.s.questions.find((x) => x.id === f.questionId);
    if (!q) throw new Error('foreign key: question');
    // Mirrors the reckon_forecast_before_lock trigger.
    if (f.madeAt.getTime() >= q.lockAt.getTime()) throw new Error(`reckon: forecast made at ${f.madeAt.toISOString()} is not before lock_at`);
    if (!(f.p > 0 && f.p < 1)) throw new Error('check constraint: 0 < p < 1');
    this.s.forecasts.push({ ...f, id: uuid() });
  }
  async forQuestions(ids: readonly string[]) {
    const set = new Set(ids);
    return this.s.forecasts.filter((f) => set.has(f.questionId));
  }
}

export class MemoryResolutionRepo implements ResolutionRepo {
  constructor(private readonly s: MemoryStore) {}
  async record(r: NewResolution) {
    const q = this.s.questions.find((x) => x.id === r.questionId);
    if (q?.status !== 'resolving') return false;
    this.s.questions = this.s.questions.map((x) =>
      x.id === r.questionId ? { ...x, status: r.outcome == null ? 'annulled' : 'resolved', annulReason: r.annulReason ?? null } : x,
    );
    this.s.resolutions.push({
      id: uuid(),
      questionId: r.questionId,
      outcome: r.outcome,
      observedValue: r.observedValue,
      observedUnit: r.observedUnit,
      evidenceId: r.evidenceId,
      resolverVersion: r.resolverVersion,
      resolvedAt: this.s.clock.now(),
    });
    return true;
  }
  async latestFor(ids: readonly string[]) {
    const out = new Map<string, ResolutionRecord>();
    for (const r of this.s.resolutions) if (ids.includes(r.questionId)) out.set(r.questionId, r);
    return [...out.values()];
  }
}

export class MemoryClimatologyRepo implements ClimatologyRepo {
  constructor(private readonly s: MemoryStore) {}
  async get(lat: number, lon: number, metric: DailyMetric) {
    return this.s.climatology.get(`${lat}|${lon}|${metric}`) ?? null;
  }
  async put(lat: number, lon: number, metric: DailyMetric, e: Omit<ClimatologyEntry, 'refreshedAt'>) {
    this.s.climatology.set(`${lat}|${lon}|${metric}`, { ...e, refreshedAt: this.s.clock.now() });
  }
}

export class MemoryOutboxRepo implements OutboxRepo {
  private nextId = 1;
  constructor(private readonly s: MemoryStore) {}
  async enqueue(e: { userId: string; channel: 'telegram'; kind: OutboxKind; payload: OutboxMessage; dedupeKey: string; createdAt: Date }) {
    if (this.s.outbox.some((x) => x.dedupeKey === e.dedupeKey)) return false;
    this.s.outbox.push({ ...e, id: this.nextId++, attempts: 0, sentAt: null, skippedAt: null, skipReason: null });
    return true;
  }
  async exists(dedupeKey: string) {
    return this.s.outbox.some((x) => x.dedupeKey === dedupeKey);
  }
  async pending(limit: number, maxAttempts: number) {
    return this.s.outbox.filter((x) => !x.sentAt && !x.skippedAt && x.attempts < maxAttempts).slice(0, limit);
  }
  private patch(id: number, p: Partial<MemoryStore['outbox'][number]>) {
    this.s.outbox = this.s.outbox.map((x) => (x.id === id ? { ...x, ...p } : x));
  }
  async markSent(id: number, at: Date) {
    const e = this.s.outbox.find((x) => x.id === id);
    this.patch(id, { sentAt: at, attempts: (e?.attempts ?? 0) + 1 });
  }
  async markSkipped(id: number, reason: string, at: Date) {
    this.patch(id, { skippedAt: at, skipReason: reason });
  }
  async markFailed(id: number) {
    const e = this.s.outbox.find((x) => x.id === id);
    this.patch(id, { attempts: (e?.attempts ?? 0) + 1 });
  }
  async scheduledSentSince(userId: string, since: Date) {
    return this.s.outbox.filter((x) => x.userId === userId && (x.kind === 'brief' || x.kind === 'reveal') && x.sentAt && x.sentAt >= since).length;
  }
}

/** Mirrors the `scores` view: last pre-lock forecast per forecaster vs the latest resolution. */
export class MemoryScoreReader implements ScoreReader {
  constructor(private readonly s: MemoryStore) {}
  async scored(userId: string): Promise<ScoredForecast[]> {
    const out: ScoredForecast[] = [];
    for (const q of this.s.questions.filter((x) => x.userId === userId && x.status === 'resolved' && x.templateId)) {
      const r = [...this.s.resolutions].reverse().find((x) => x.questionId === q.id);
      if (r?.outcome == null) continue;
      const last = new Map<string, ForecastRecord>();
      for (const f of this.s.forecasts) {
        if (f.questionId !== q.id || f.madeAt >= q.lockAt) continue;
        const prev = last.get(f.forecasterId);
        if (!prev || prev.madeAt < f.madeAt) last.set(f.forecasterId, f);
      }
      for (const f of last.values()) {
        out.push({
          questionId: q.id,
          templateId: q.templateId ?? '',
          forecasterId: f.forecasterId,
          domain: q.domain,
          horizonDays: q.horizonDays,
          cluster: q.correlationGroup,
          p: f.p,
          o: r.outcome,
        });
      }
    }
    return out;
  }
  async resolvedClusterCount(userId: string) {
    return new Set(this.s.questions.filter((q) => q.userId === userId && q.status === 'resolved' && q.locationId !== null).map((q) => q.correlationGroup)).size;
  }
}

export class MemoryLinkTokenRepo implements LinkTokenRepo {
  constructor(private readonly s: MemoryStore) {}
  async create(userId: string, token: string, expiresAt: Date) {
    this.s.linkTokens.push({ token, userId, expiresAt, usedAt: null });
  }
  async consume(token: string, now: Date) {
    const t = this.s.linkTokens.find((x) => x.token === token && !x.usedAt && x.expiresAt > now);
    if (!t) return null;
    t.usedAt = now;
    return t.userId;
  }
}

export class MemoryTopicRepo implements TopicRepo {
  constructor(private readonly s: MemoryStore) {}
  async list(userId: string) {
    return this.s.topics.filter((t) => t.userId === userId);
  }
  async upsert(userId: string, t: { key: string; label: string; query: string | null; keywords: readonly string[] }) {
    const existing = this.s.topics.find((x) => x.userId === userId && x.key === t.key);
    if (existing) {
      const next = { ...existing, enabled: true };
      this.s.topics = this.s.topics.map((x) => (x.id === existing.id ? next : x));
      return next;
    }
    const rec: TopicRecord = {
      id: uuid(),
      userId,
      key: t.key,
      label: t.label,
      query: t.query,
      keywords: [...t.keywords],
      enabled: true,
      createdAt: this.s.clock.now(),
    };
    this.s.topics.push(rec);
    return rec;
  }
  async setEnabled(userId: string, id: string, enabled: boolean) {
    const found = this.s.topics.some((t) => t.userId === userId && t.id === id);
    this.s.topics = this.s.topics.map((t) => (t.userId === userId && t.id === id ? { ...t, enabled } : t));
    return found;
  }
}

/** Same rules as PgNewsRepo: headlines become `evidence` rows (kind 'news') on first link. */
export class MemoryNewsRepo implements NewsRepo {
  constructor(
    private readonly s: MemoryStore,
    private readonly hasher: Hasher,
  ) {}
  async hasCanonicalUrl(urls: readonly string[]) {
    const want = new Set(urls);
    return new Set(this.s.news.filter((n) => want.has(n.canonicalUrl)).map((n) => n.canonicalUrl));
  }
  async simhashesSince(since: Date) {
    return this.s.news.filter((n) => n.publishedAt >= since).map((n) => n.simhash);
  }
  async insert(n: NewsItem, fetchedAt: Date) {
    const existing = this.s.news.find((x) => x.canonicalUrl === n.canonicalUrl);
    if (existing) return existing.id;
    const id = uuid();
    this.s.news.push({ ...n, id, fetchedAt, evidenceId: null });
    return id;
  }
  async unlinkedTagged(questionId: string, since: Date, tags: readonly string[]) {
    const linked = new Set(this.s.questionEvidence.filter((x) => x.questionId === questionId).map((x) => x.evidenceId));
    return this.s.news
      .filter((n) => n.publishedAt >= since && n.tags.some((t) => tags.includes(t)) && !(n.evidenceId && linked.has(n.evidenceId)))
      .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
  }
  async link(itemId: string, questionId: string, relevance: number) {
    const n = this.s.news.find((x) => x.id === itemId);
    if (!n) return;
    if (!n.evidenceId) {
      const id = uuid();
      const kept = { url: n.url, title: n.title, source: n.source, publishedAt: n.publishedAt.toISOString(), snippet: n.snippet };
      this.s.evidence.push({
        id,
        sourceId: `news.${n.origin}`,
        kind: 'news',
        title: n.title,
        fetchedAt: n.fetchedAt.toISOString(),
        blobKey: null,
        sha256: this.hasher.sha256(canonicalJson(kept)),
        url: n.url,
        meta: { purpose: 'news', source: n.source, publishedAt: kept.publishedAt, newsItemId: n.id, snippet: n.snippet },
      });
      n.evidenceId = id;
    }
    if (!this.s.questionEvidence.some((x) => x.questionId === questionId && x.evidenceId === n.evidenceId)) {
      this.s.questionEvidence.push({ questionId, evidenceId: n.evidenceId });
      this.s.relevance.set(`${questionId}|${n.evidenceId}`, relevance);
    }
  }
  async linkedCount(questionId: string) {
    return (await this.forQuestion(questionId)).length;
  }
  async forQuestion(questionId: string): Promise<LinkedNews[]> {
    const ids = new Set(this.s.questionEvidence.filter((x) => x.questionId === questionId).map((x) => x.evidenceId));
    return this.s.evidence
      .filter((e) => e.kind === 'news' && ids.has(e.id))
      .map((e) => ({
        evidenceId: e.id,
        title: e.title ?? '',
        source: String(e.meta.source ?? ''),
        url: e.url ?? '',
        publishedAt: String(e.meta.publishedAt ?? ''),
        snippet: typeof e.meta.snippet === 'string' ? e.meta.snippet : null,
        relevance: this.s.relevance.get(`${questionId}|${e.id}`) ?? 0.5,
      }))
      .sort((a, b) => b.relevance - a.relevance || b.publishedAt.localeCompare(a.publishedAt));
  }
  async prune(before: Date) {
    const n = this.s.news.length;
    this.s.news = this.s.news.filter((x) => x.publishedAt >= before || x.evidenceId);
    return n - this.s.news.length;
  }
}

export class MemoryFeedStateRepo implements FeedStateRepo {
  constructor(private readonly s: MemoryStore) {}
  async all() {
    return [...this.s.feedState.values()];
  }
  async put(f: FeedState) {
    this.s.feedState.set(f.id, f);
  }
}

export class MemoryPushSubscriptionRepo implements PushSubscriptionRepo {
  constructor(private readonly s: MemoryStore) {}
  async add(userId: string, sub: PushSubscription) {
    this.s.push = [...this.s.push.filter((x) => x.endpoint !== sub.endpoint), { ...sub, userId }];
  }
  async remove(userId: string, endpoint: string) {
    const n = this.s.push.length;
    this.s.push = this.s.push.filter((x) => !(x.userId === userId && x.endpoint === endpoint));
    return this.s.push.length < n;
  }
  async forUser(userId: string) {
    return this.s.push.filter((x) => x.userId === userId).map(({ endpoint, p256dh, auth }) => ({ endpoint, p256dh, auth }));
  }
}

export class MemoryWorkQueue implements WorkQueue {
  private nextId = 1;
  constructor(private readonly s: MemoryStore) {}
  async enqueue(kind: string, payload: unknown, opts: { dedupeKey?: string; runAfter?: Date; maxAttempts?: number } = {}) {
    if (opts.dedupeKey && this.s.work.some((w) => w.dedupeKey === opts.dedupeKey)) return;
    this.s.work.push({
      id: this.nextId++,
      kind,
      payload,
      attempts: 0,
      maxAttempts: opts.maxAttempts ?? 6,
      dedupeKey: opts.dedupeKey ?? null,
      runAfter: opts.runAfter ?? this.s.clock.now(),
      leasedUntil: null,
      doneAt: null,
      lastError: null,
    });
  }
  async claim(limit: number, leaseSeconds: number) {
    const now = this.s.clock.now();
    const ready = this.s.work
      .filter((w) => !w.doneAt && w.runAfter <= now && (!w.leasedUntil || w.leasedUntil < now) && w.attempts < w.maxAttempts)
      .sort((a, b) => a.runAfter.getTime() - b.runAfter.getTime())
      .slice(0, limit);
    for (const w of ready) {
      w.attempts++;
      w.leasedUntil = new Date(now.getTime() + leaseSeconds * 1000);
    }
    return ready.map(({ id, kind, payload, attempts, maxAttempts }) => ({ id, kind, payload, attempts, maxAttempts }));
  }
  private find(id: number) {
    const w = this.s.work.find((x) => x.id === id);
    if (!w) throw new Error(`no work item ${id}`);
    return w;
  }
  async complete(id: number) {
    const w = this.find(id);
    w.doneAt = this.s.clock.now();
    w.leasedUntil = null;
  }
  async retryLater(id: number, error: string, runAfter: Date) {
    const w = this.find(id);
    Object.assign(w, { lastError: error, runAfter, leasedUntil: null });
  }
  async giveUp(id: number, error: string) {
    const w = this.find(id);
    Object.assign(w, { lastError: error, attempts: w.maxAttempts, leasedUntil: null });
  }
  async depth() {
    return this.s.work.filter((w) => !w.doneAt && w.attempts < w.maxAttempts).length;
  }
}

export class MemoryJobRuns implements JobRunRecorder, HealthReader {
  constructor(private readonly s: MemoryStore) {}
  async start(job: string) {
    const id = this.s.jobRuns.length + 1;
    this.s.jobRuns.push({ id, job, startedAt: this.s.clock.now(), finishedAt: null, status: null, stats: {} });
    return id;
  }
  async finish(id: number, status: 'ok' | 'error', stats: Record<string, unknown>) {
    const r = this.s.jobRuns.find((x) => x.id === id);
    if (r) Object.assign(r, { finishedAt: this.s.clock.now(), status, stats });
  }
  async jobRuns(): Promise<JobRunSummary[]> {
    const jobs = [...new Set(this.s.jobRuns.map((r) => r.job))].sort();
    return jobs.map((job) => {
      const runs = this.s.jobRuns.filter((r) => r.job === job);
      const last = runs[runs.length - 1];
      const ok = runs.filter((r) => r.status === 'ok').pop();
      return {
        job,
        lastStartedAt: (last?.startedAt ?? new Date(0)).toISOString(),
        lastStatus: last?.status ?? null,
        lastOkAt: ok?.finishedAt?.toISOString() ?? null,
      };
    });
  }
  async queueDepth() {
    return new MemoryWorkQueue(this.s).depth();
  }
}
