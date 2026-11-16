import {
  type ClimatologyEntry,
  type ClimatologyRepo,
  type Criteria,
  canonicalJson,
  type DailyMetric,
  type Domain,
  type EvidenceRecord,
  type EvidenceRepo,
  type FeedState,
  type FeedStateRepo,
  type ForecastRecord,
  type ForecastRepo,
  type Hasher,
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
  type Outcome,
  type PushSubscription,
  type PushSubscriptionRepo,
  type QuestionMeta,
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
  type UserSettings,
} from '@reckon/core';
import type pg from 'pg';
import type { Queryable } from './pg';

/**
 * Postgres repositories (spec §2.3, Repository pattern): use cases never see SQL.
 * Dates are cast to text in SQL so a 'YYYY-MM-DD' never shifts through the server's timezone.
 */

async function inTransaction<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Users and locations
// ---------------------------------------------------------------------------

const USER_COLUMNS = `id, display_name, tz, to_char(brief_time, 'HH24:MI') as brief_time, to_char(reveal_time, 'HH24:MI') as reveal_time,
  to_char(quiet_start, 'HH24:MI') as quiet_start, to_char(quiet_end, 'HH24:MI') as quiet_end, telegram_chat_id::text as telegram_chat_id,
  onboarded_at, notifications_paused, settings`;

interface UserRow {
  id: string;
  display_name: string | null;
  tz: string;
  brief_time: string;
  reveal_time: string;
  quiet_start: string;
  quiet_end: string;
  telegram_chat_id: string | null;
  onboarded_at: Date | null;
  notifications_paused: boolean;
  settings: UserSettings;
}

const toUser = (r: UserRow): User => ({
  id: r.id,
  displayName: r.display_name,
  tz: r.tz,
  briefTime: r.brief_time,
  revealTime: r.reveal_time,
  quietStart: r.quiet_start,
  quietEnd: r.quiet_end,
  telegramChatId: r.telegram_chat_id,
  onboardedAt: r.onboarded_at?.toISOString() ?? null,
  paused: r.notifications_paused,
  settings: r.settings ?? {},
});

export class PgUserRepo implements UserRepo {
  constructor(private readonly db: Queryable) {}

  private async one(where: string, params: unknown[]): Promise<User | null> {
    const r = await this.db.query<UserRow>(`select ${USER_COLUMNS} from users ${where} limit 1`, params);
    return r.rows[0] ? toUser(r.rows[0]) : null;
  }

  primary() {
    return this.one('order by created_at', []);
  }
  byId(id: string) {
    return this.one('where id = $1', [id]);
  }
  byTelegramChat(chatId: string) {
    return this.one('where telegram_chat_id = $1::bigint', [chatId]);
  }
  async all(): Promise<User[]> {
    return (await this.db.query<UserRow>(`select ${USER_COLUMNS} from users order by created_at`)).rows.map(toUser);
  }

  async update(id: string, patch: UserPatch): Promise<User | null> {
    const cols: Record<string, unknown> = {
      display_name: patch.displayName,
      tz: patch.tz,
      brief_time: patch.briefTime,
      reveal_time: patch.revealTime,
      quiet_start: patch.quietStart,
      quiet_end: patch.quietEnd,
      notifications_paused: patch.paused,
      settings: patch.settings === undefined ? undefined : JSON.stringify(patch.settings),
    };
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const [col, v] of Object.entries(cols)) {
      if (v === undefined) continue;
      params.push(v);
      sets.push(`${col} = $${params.length}`);
    }
    if (patch.onboarded) sets.push('onboarded_at = coalesce(onboarded_at, now())');
    if (sets.length) await this.db.query(`update users set ${sets.join(', ')} where id = $1`, params);
    return this.byId(id);
  }

  async setTelegramChat(id: string, chatId: string | null): Promise<void> {
    // A chat links to one user; relinking moves it.
    if (chatId) await this.db.query('update users set telegram_chat_id = null where telegram_chat_id = $1::bigint and id <> $2', [chatId, id]);
    await this.db.query('update users set telegram_chat_id = $2::bigint where id = $1', [id, chatId]);
  }
}

interface LocationRow {
  id: string;
  user_id: string;
  name: string;
  lat: number;
  lon: number;
  tz: string;
  is_primary: boolean;
}
const toLocation = (r: LocationRow): Location => ({ id: r.id, userId: r.user_id, name: r.name, lat: r.lat, lon: r.lon, tz: r.tz, isPrimary: r.is_primary });
const LOCATION_COLUMNS = 'id, user_id, name, lat, lon, tz, is_primary';

export class PgLocationRepo implements LocationRepo {
  constructor(private readonly pool: pg.Pool) {}

  async list(userId: string): Promise<Location[]> {
    const r = await this.pool.query<LocationRow>(`select ${LOCATION_COLUMNS} from locations where user_id = $1 order by is_primary desc, created_at`, [userId]);
    return r.rows.map(toLocation);
  }
  async all(): Promise<Location[]> {
    return (await this.pool.query<LocationRow>(`select ${LOCATION_COLUMNS} from locations order by created_at`)).rows.map(toLocation);
  }
  async get(id: string): Promise<Location | null> {
    const r = await this.pool.query<LocationRow>(`select ${LOCATION_COLUMNS} from locations where id = $1`, [id]);
    return r.rows[0] ? toLocation(r.rows[0]) : null;
  }

  create(userId: string, input: LocationInput): Promise<Location> {
    return inTransaction(this.pool, async (c) => {
      if (input.isPrimary) await c.query('update locations set is_primary = false where user_id = $1', [userId]);
      const r = await c.query<LocationRow>(
        `insert into locations (user_id, name, lat, lon, tz, is_primary) values ($1, $2, $3, $4, $5, $6) returning ${LOCATION_COLUMNS}`,
        [userId, input.name, input.lat, input.lon, input.tz, input.isPrimary ?? false],
      );
      return toLocation(r.rows[0] as LocationRow);
    });
  }

  update(id: string, patch: Partial<LocationInput>): Promise<Location | null> {
    return inTransaction(this.pool, async (c) => {
      if (patch.isPrimary) await c.query('update locations set is_primary = false where user_id = (select user_id from locations where id = $1)', [id]);
      const r = await c.query<LocationRow>(
        `update locations set name = coalesce($2, name), lat = coalesce($3, lat), lon = coalesce($4, lon), tz = coalesce($5, tz),
           is_primary = coalesce($6, is_primary) where id = $1 returning ${LOCATION_COLUMNS}`,
        [id, patch.name ?? null, patch.lat ?? null, patch.lon ?? null, patch.tz ?? null, patch.isPrimary ?? null],
      );
      return r.rows[0] ? toLocation(r.rows[0]) : null;
    });
  }

  remove(id: string): Promise<boolean> {
    return inTransaction(this.pool, async (c) => {
      const r = await c.query<{ user_id: string; is_primary: boolean }>('delete from locations where id = $1 returning user_id, is_primary', [id]);
      const gone = r.rows[0];
      if (gone?.is_primary) {
        await c.query('update locations set is_primary = true where id = (select id from locations where user_id = $1 order by created_at limit 1)', [
          gone.user_id,
        ]);
      }
      return Boolean(gone);
    });
  }
}

// ---------------------------------------------------------------------------
// Questions, forecasts, evidence, resolutions
// ---------------------------------------------------------------------------

interface QuestionRow {
  id: string;
  user_id: string;
  location_id: string | null;
  template_id: string | null;
  template_version: number | null;
  domain: Domain;
  title: string;
  criteria: Criteria;
  criteria_hash: string;
  horizon_days: number;
  correlation_group: string;
  lock_at: Date;
  window_start: Date;
  window_end: Date;
  status: QuestionStatusValue;
  annul_reason: string | null;
  target_date: string;
  meta: QuestionMeta;
  created_at: Date;
}

const QUESTION_COLUMNS = `id, user_id, location_id, template_id, template_version, domain, title, criteria, criteria_hash, horizon_days,
  correlation_group, lock_at, window_start, window_end, status, annul_reason, target_date::text as target_date, meta, created_at`;

const toQuestion = (r: QuestionRow): QuestionRecord => ({
  id: r.id,
  userId: r.user_id,
  locationId: r.location_id,
  templateId: r.template_id,
  templateVersion: r.template_version,
  domain: r.domain,
  title: r.title,
  criteria: r.criteria,
  criteriaHash: r.criteria_hash,
  horizonDays: r.horizon_days,
  correlationGroup: r.correlation_group,
  lockAt: r.lock_at,
  windowStart: r.window_start,
  windowEnd: r.window_end,
  status: r.status,
  annulReason: r.annul_reason,
  targetDate: r.target_date,
  meta: r.meta,
  createdAt: r.created_at,
});

interface EvidenceRow {
  id: string;
  source_id: string;
  kind: 'snapshot' | 'news';
  title?: string | null;
  fetched_at: Date;
  blob_key: string | null;
  sha256: string;
  url: string | null;
  meta: Record<string, unknown>;
}
const toEvidence = (r: EvidenceRow): EvidenceRecord => ({
  id: r.id,
  sourceId: r.source_id,
  kind: r.kind,
  title: r.title ?? null,
  fetchedAt: r.fetched_at.toISOString(),
  blobKey: r.blob_key,
  sha256: r.sha256,
  url: r.url,
  meta: r.meta ?? {},
});

export class PgQuestionRepo implements QuestionRepo {
  constructor(
    private readonly db: Queryable,
    private readonly hasher: Hasher,
  ) {}

  async insertIfAbsent(q: NewQuestion): Promise<{ id: string; created: boolean }> {
    const criteriaJson = canonicalJson(q.criteria);
    const hash = this.hasher.sha256(criteriaJson);
    const inserted = await this.db.query<{ id: string }>(
      `insert into questions (user_id, location_id, template_id, template_version, domain, title, criteria, criteria_hash, horizon_days,
         correlation_group, lock_at, window_start, window_end, target_date, meta)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14::date, $15::jsonb)
       on conflict on constraint questions_identity do nothing
       returning id`,
      [
        q.userId,
        q.locationId,
        q.templateId,
        q.templateVersion,
        q.domain,
        q.title,
        criteriaJson,
        hash,
        q.horizonDays,
        q.correlationGroup,
        q.lockAt,
        q.windowStart,
        q.windowEnd,
        q.targetDate,
        JSON.stringify(q.meta),
      ],
    );
    if (inserted.rows[0]) return { id: inserted.rows[0].id, created: true };
    const existing = await this.db.query<{ id: string }>(
      'select id from questions where user_id = $1 and template_id = $2 and criteria_hash = $3 and horizon_days = $4',
      [q.userId, q.templateId, hash, q.horizonDays],
    );
    return { id: existing.rows[0]?.id as string, created: false };
  }

  async get(id: string): Promise<QuestionRecord | null> {
    const r = await this.db.query<QuestionRow>(`select ${QUESTION_COLUMNS} from questions where id = $1`, [id]);
    return r.rows[0] ? toQuestion(r.rows[0]) : null;
  }

  async lockDue(now: Date): Promise<number> {
    const r = await this.db.query(`update questions set status = 'locked' where status = 'open' and lock_at <= $1`, [now]);
    return r.rowCount ?? 0;
  }

  async dueForResolution(now: Date, delayHours: number, limit: number): Promise<QuestionRecord[]> {
    const r = await this.db.query<QuestionRow>(
      `select ${QUESTION_COLUMNS} from questions
       where status = 'locked' and window_end + make_interval(hours => $2) <= $1
       order by window_end limit $3`,
      [now, delayHours, limit],
    );
    return r.rows.map(toQuestion);
  }

  async transition(id: string, from: QuestionStatusValue, to: QuestionStatusValue): Promise<boolean> {
    const r = await this.db.query('update questions set status = $3 where id = $1 and status = $2', [id, from, to]);
    return (r.rowCount ?? 0) > 0;
  }

  async listByTargetDates(userId: string, from: string, to: string): Promise<QuestionRecord[]> {
    const r = await this.db.query<QuestionRow>(
      `select ${QUESTION_COLUMNS} from questions where user_id = $1 and target_date between $2::date and $3::date order by target_date, created_at`,
      [userId, from, to],
    );
    return r.rows.map(toQuestion);
  }

  async linkEvidence(questionId: string, evidenceIds: readonly string[]): Promise<void> {
    if (!evidenceIds.length) return;
    await this.db.query(
      `insert into question_evidence (question_id, evidence_id, relevance)
       select $1, e, 1 from unnest($2::uuid[]) as e on conflict do nothing`,
      [questionId, evidenceIds],
    );
  }

  async evidenceFor(questionId: string): Promise<EvidenceRecord[]> {
    const r = await this.db.query<EvidenceRow>(
      `select e.id, e.source_id, e.kind, e.title, e.fetched_at, e.blob_key, e.sha256, e.url, e.meta
       from question_evidence qe join evidence e on e.id = qe.evidence_id
       where qe.question_id = $1 order by e.fetched_at`,
      [questionId],
    );
    return r.rows.map(toEvidence);
  }
}

export class PgEvidenceRepo implements EvidenceRepo {
  constructor(private readonly db: Queryable) {}

  async insertSnapshot(e: Omit<EvidenceRecord, 'id' | 'kind'>): Promise<string> {
    const r = await this.db.query<{ id: string }>(
      `insert into evidence (source_id, kind, fetched_at, blob_key, sha256, url, meta) values ($1, 'snapshot', $2, $3, $4, $5, $6::jsonb) returning id`,
      [e.sourceId, e.fetchedAt, e.blobKey, e.sha256, e.url, JSON.stringify(e.meta)],
    );
    return r.rows[0]?.id as string;
  }

  async get(id: string): Promise<EvidenceRecord | null> {
    const r = await this.db.query<EvidenceRow>('select id, source_id, kind, fetched_at, blob_key, sha256, url, meta from evidence where id = $1', [id]);
    return r.rows[0] ? toEvidence(r.rows[0]) : null;
  }
}

interface ForecastRow {
  id: string;
  question_id: string;
  forecaster_id: string;
  p: number;
  made_at: Date;
  rationale: string | null;
  evidence_ids: string[];
}

export class PgForecastRepo implements ForecastRepo {
  constructor(private readonly db: Queryable) {}

  async insert(f: Omit<ForecastRecord, 'id'>): Promise<void> {
    await this.db.query('insert into forecasts (question_id, forecaster_id, p, made_at, rationale, evidence_ids) values ($1, $2, $3, $4, $5, $6::uuid[])', [
      f.questionId,
      f.forecasterId,
      f.p,
      f.madeAt,
      f.rationale,
      f.evidenceIds,
    ]);
  }

  async forQuestions(questionIds: readonly string[]): Promise<ForecastRecord[]> {
    if (!questionIds.length) return [];
    const r = await this.db.query<ForecastRow>(
      'select id, question_id, forecaster_id, p, made_at, rationale, evidence_ids from forecasts where question_id = any($1::uuid[]) order by made_at',
      [questionIds],
    );
    return r.rows.map((x) => ({
      id: x.id,
      questionId: x.question_id,
      forecasterId: x.forecaster_id,
      p: x.p,
      madeAt: x.made_at,
      rationale: x.rationale,
      evidenceIds: x.evidence_ids,
    }));
  }
}

export class PgResolutionRepo implements ResolutionRepo {
  constructor(private readonly pool: pg.Pool) {}

  record(r: NewResolution): Promise<boolean> {
    return inTransaction(this.pool, async (c) => {
      // Status first: the compare-and-set guarantees one resolution per question even if two workers race.
      const moved = await c.query(`update questions set status = $2, annul_reason = $3 where id = $1 and status = 'resolving'`, [
        r.questionId,
        r.outcome == null ? 'annulled' : 'resolved',
        r.annulReason ?? null,
      ]);
      if ((moved.rowCount ?? 0) === 0) return false;
      await c.query(
        `insert into resolutions (question_id, outcome, observed_value, observed_unit, evidence_id, resolver_version) values ($1, $2, $3, $4, $5, $6)`,
        [r.questionId, r.outcome, r.observedValue, r.observedUnit, r.evidenceId, r.resolverVersion],
      );
      return true;
    });
  }

  async latestFor(questionIds: readonly string[]): Promise<ResolutionRecord[]> {
    if (!questionIds.length) return [];
    const res = await this.pool.query<{
      id: string;
      question_id: string;
      outcome: number | null;
      observed_value: number | null;
      observed_unit: string | null;
      evidence_id: string | null;
      resolver_version: string;
      resolved_at: Date;
    }>(
      `select id, question_id, outcome, observed_value, observed_unit, evidence_id, resolver_version, resolved_at
       from latest_resolutions where question_id = any($1::uuid[])`,
      [questionIds],
    );
    return res.rows.map((x) => ({
      id: x.id,
      questionId: x.question_id,
      outcome: x.outcome == null ? null : (x.outcome as Outcome),
      observedValue: x.observed_value,
      observedUnit: x.observed_unit,
      evidenceId: x.evidence_id,
      resolverVersion: x.resolver_version,
      resolvedAt: x.resolved_at,
    }));
  }
}

// ---------------------------------------------------------------------------
// Climatology, outbox, scores, link tokens
// ---------------------------------------------------------------------------

export class PgClimatologyRepo implements ClimatologyRepo {
  constructor(private readonly db: Queryable) {}

  async get(lat: number, lon: number, metric: DailyMetric): Promise<ClimatologyEntry | null> {
    const r = await this.db.query<{ source_id: string; evidence_id: string | null; series_start: string; vals: (number | null)[]; refreshed_at: Date }>(
      'select source_id, evidence_id, series_start::text as series_start, vals, refreshed_at from climatology where lat = $1 and lon = $2 and metric = $3',
      [lat, lon, metric],
    );
    const row = r.rows[0];
    return row
      ? { sourceId: row.source_id, evidenceId: row.evidence_id, series: { start: row.series_start, values: row.vals }, refreshedAt: row.refreshed_at }
      : null;
  }

  async put(lat: number, lon: number, metric: DailyMetric, e: Omit<ClimatologyEntry, 'refreshedAt'>): Promise<void> {
    await this.db.query(
      `insert into climatology (lat, lon, metric, source_id, evidence_id, series_start, vals, refreshed_at)
       values ($1, $2, $3, $4, $5, $6::date, $7::jsonb, now())
       on conflict (lat, lon, metric) do update set source_id = excluded.source_id, evidence_id = excluded.evidence_id,
         series_start = excluded.series_start, vals = excluded.vals, refreshed_at = excluded.refreshed_at`,
      [lat, lon, metric, e.sourceId, e.evidenceId, e.series.start, JSON.stringify(e.series.values)],
    );
  }
}

export class PgOutboxRepo implements OutboxRepo {
  constructor(private readonly db: Queryable) {}

  async enqueue(e: { userId: string; channel: 'telegram'; kind: OutboxKind; payload: OutboxMessage; dedupeKey: string; createdAt: Date }): Promise<boolean> {
    const r = await this.db.query(
      `insert into notifications_outbox (user_id, channel, kind, payload, dedupe_key, created_at) values ($1, $2, $3, $4::jsonb, $5, $6)
       on conflict (dedupe_key) do nothing`,
      [e.userId, e.channel, e.kind, JSON.stringify(e.payload), e.dedupeKey, e.createdAt],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async exists(dedupeKey: string): Promise<boolean> {
    const r = await this.db.query('select 1 from notifications_outbox where dedupe_key = $1', [dedupeKey]);
    return (r.rowCount ?? 0) > 0;
  }

  async pending(limit: number, maxAttempts: number): Promise<OutboxEntry[]> {
    const r = await this.db.query<{
      id: string;
      user_id: string | null;
      channel: 'telegram' | 'webpush';
      kind: OutboxKind;
      payload: OutboxMessage;
      created_at: Date;
      attempts: number;
    }>(
      `select id, user_id, channel, kind, payload, created_at, attempts from notifications_outbox
       where sent_at is null and skipped_at is null and attempts < $2 order by created_at limit $1`,
      [limit, maxAttempts],
    );
    return r.rows.map((x) => ({
      id: Number(x.id),
      userId: x.user_id,
      channel: x.channel,
      kind: x.kind,
      payload: x.payload,
      createdAt: x.created_at,
      attempts: x.attempts,
    }));
  }

  async markSent(id: number, at: Date): Promise<void> {
    await this.db.query('update notifications_outbox set sent_at = $2, attempts = attempts + 1 where id = $1', [id, at]);
  }
  async markSkipped(id: number, reason: string, at: Date): Promise<void> {
    await this.db.query('update notifications_outbox set skipped_at = $3, skip_reason = $2 where id = $1', [id, reason, at]);
  }
  async markFailed(id: number, error: string): Promise<void> {
    await this.db.query('update notifications_outbox set attempts = attempts + 1, last_error = $2 where id = $1', [id, error.slice(0, 500)]);
  }
  async scheduledSentSince(userId: string, since: Date): Promise<number> {
    const r = await this.db.query<{ n: string }>(
      `select count(*)::text as n from notifications_outbox where user_id = $1 and kind in ('brief', 'reveal') and sent_at >= $2`,
      [userId, since],
    );
    return Number(r.rows[0]?.n ?? 0);
  }
}

export class PgScoreReader implements ScoreReader {
  constructor(private readonly db: Queryable) {}

  async scored(userId: string): Promise<ScoredForecast[]> {
    const r = await this.db.query<{
      question_id: string;
      template_id: string;
      forecaster_id: string;
      domain: Domain;
      horizon_days: number;
      correlation_group: string;
      p: number;
      outcome: number;
    }>(
      `select s.question_id, s.template_id, s.forecaster_id, s.domain, s.horizon_days, s.correlation_group, s.p, s.outcome
       from scores s join questions q on q.id = s.question_id
       where q.user_id = $1 and s.template_id is not null`,
      [userId],
    );
    return r.rows.map((x) => ({
      questionId: x.question_id,
      templateId: x.template_id,
      forecasterId: x.forecaster_id,
      domain: x.domain,
      horizonDays: x.horizon_days,
      cluster: x.correlation_group,
      p: x.p,
      o: x.outcome as Outcome,
    }));
  }

  async resolvedClusterCount(userId: string): Promise<number> {
    const r = await this.db.query<{ n: string }>(
      `select count(distinct correlation_group)::text as n from questions where user_id = $1 and status = 'resolved' and location_id is not null`,
      [userId],
    );
    return Number(r.rows[0]?.n ?? 0);
  }
}

export class PgLinkTokenRepo implements LinkTokenRepo {
  constructor(private readonly db: Queryable) {}

  async create(userId: string, token: string, expiresAt: Date): Promise<void> {
    await this.db.query('insert into link_tokens (token, user_id, expires_at) values ($1, $2, $3)', [token, userId, expiresAt]);
  }

  async consume(token: string, now: Date): Promise<string | null> {
    const r = await this.db.query<{ user_id: string }>(
      'update link_tokens set used_at = $2 where token = $1 and used_at is null and expires_at > $2 returning user_id',
      [token, now],
    );
    return r.rows[0]?.user_id ?? null;
  }
}

// ---------------------------------------------------------------------------
// Phase 2: topics, news, feed state, push subscriptions
// ---------------------------------------------------------------------------

interface TopicRow {
  id: string;
  user_id: string;
  key: string;
  label: string;
  query: string | null;
  keywords: string[];
  enabled: boolean;
  created_at: Date;
}
const toTopic = (r: TopicRow): TopicRecord => ({
  id: r.id,
  userId: r.user_id,
  key: r.key,
  label: r.label,
  query: r.query,
  keywords: r.keywords,
  enabled: r.enabled,
  createdAt: r.created_at,
});
const TOPIC_COLUMNS = 'id, user_id, key, label, query, keywords, enabled, created_at';

export class PgTopicRepo implements TopicRepo {
  constructor(private readonly db: Queryable) {}

  async list(userId: string): Promise<TopicRecord[]> {
    return (await this.db.query<TopicRow>(`select ${TOPIC_COLUMNS} from topics where user_id = $1 order by created_at, label`, [userId])).rows.map(toTopic);
  }

  async upsert(userId: string, t: { key: string; label: string; query: string | null; keywords: readonly string[] }): Promise<TopicRecord> {
    const r = await this.db.query<TopicRow>(
      `insert into topics (user_id, key, label, query, keywords) values ($1, $2, $3, $4, $5::text[])
       on conflict (user_id, key) do update set enabled = true
       returning ${TOPIC_COLUMNS}`,
      [userId, t.key, t.label, t.query, t.keywords],
    );
    return toTopic(r.rows[0] as TopicRow);
  }

  async setEnabled(userId: string, id: string, enabled: boolean): Promise<boolean> {
    const r = await this.db.query('update topics set enabled = $3 where user_id = $1 and id = $2', [userId, id, enabled]);
    return (r.rowCount ?? 0) > 0;
  }
}

interface NewsRow {
  id: string;
  canonical_url: string;
  url: string;
  title: string;
  source: string;
  published_at: Date;
  snippet: string | null;
  lang: string | null;
  origin: string;
  simhash: string;
  tags: string[];
  fetched_at: Date;
}
const NEWS_COLUMNS = 'id, canonical_url, url, title, source, published_at, snippet, lang, origin, simhash::text as simhash, tags, fetched_at';
const toNews = (r: NewsRow): NewsItemRecord => ({
  id: r.id,
  canonicalUrl: r.canonical_url,
  url: r.url,
  title: r.title,
  source: r.source,
  publishedAt: r.published_at,
  snippet: r.snippet,
  lang: r.lang,
  origin: r.origin,
  simhash: BigInt(r.simhash),
  tags: r.tags,
  fetchedAt: r.fetched_at,
});

export class PgNewsRepo implements NewsRepo {
  constructor(
    private readonly pool: pg.Pool,
    private readonly hasher: Hasher,
  ) {}

  async hasCanonicalUrl(urls: readonly string[]): Promise<Set<string>> {
    if (!urls.length) return new Set();
    const r = await this.pool.query<{ canonical_url: string }>('select canonical_url from news_items where canonical_url = any($1::text[])', [urls]);
    return new Set(r.rows.map((x) => x.canonical_url));
  }

  async simhashesSince(since: Date): Promise<bigint[]> {
    const r = await this.pool.query<{ simhash: string }>('select simhash::text as simhash from news_items where published_at >= $1', [since]);
    return r.rows.map((x) => BigInt(x.simhash));
  }

  async insert(n: NewsItem, fetchedAt: Date): Promise<string> {
    const r = await this.pool.query<{ id: string }>(
      `insert into news_items (canonical_url, url, title, source, published_at, snippet, lang, origin, simhash, tags, fetched_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::bigint, $10::text[], $11)
       on conflict (canonical_url) do update set canonical_url = excluded.canonical_url
       returning id`,
      [n.canonicalUrl, n.url, n.title, n.source, n.publishedAt, n.snippet, n.lang, n.origin, n.simhash.toString(), n.tags, fetchedAt],
    );
    return r.rows[0]?.id as string;
  }

  async unlinkedTagged(questionId: string, since: Date, tags: readonly string[]): Promise<NewsItemRecord[]> {
    if (!tags.length) return [];
    const r = await this.pool.query<NewsRow>(
      `select ${NEWS_COLUMNS} from news_items n
       where n.published_at >= $2 and n.tags && $3::text[]
         and not exists (select 1 from question_evidence qe where qe.question_id = $1 and qe.evidence_id = n.evidence_id)
       order by n.published_at desc limit 200`,
      [questionId, since, tags],
    );
    return r.rows.map(toNews);
  }

  link(itemId: string, questionId: string, relevance: number): Promise<void> {
    return inTransaction(this.pool, async (c) => {
      const r = await c.query<NewsRow & { evidence_id: string | null }>(`select ${NEWS_COLUMNS}, evidence_id from news_items where id = $1 for update`, [
        itemId,
      ]);
      const row = r.rows[0];
      if (!row) return;
      let evidenceId = row.evidence_id;
      if (!evidenceId) {
        // The headline enters the append-only ledger exactly as shown: hash of what we keep.
        const kept = { url: row.url, title: row.title, source: row.source, publishedAt: row.published_at.toISOString(), snippet: row.snippet };
        const e = await c.query<{ id: string }>(
          `insert into evidence (source_id, kind, fetched_at, sha256, title, url, summary, meta)
           values ($1, 'news', $2, $3, $4, $5, $6, $7::jsonb) returning id`,
          [
            `news.${row.origin}`,
            row.fetched_at,
            this.hasher.sha256(canonicalJson(kept)),
            row.title,
            row.url,
            row.snippet,
            JSON.stringify({ purpose: 'news', source: row.source, publishedAt: kept.publishedAt, newsItemId: row.id }),
          ],
        );
        evidenceId = e.rows[0]?.id as string;
        await c.query('update news_items set evidence_id = $2 where id = $1', [itemId, evidenceId]);
      }
      await c.query('insert into question_evidence (question_id, evidence_id, relevance) values ($1, $2, $3) on conflict do nothing', [
        questionId,
        evidenceId,
        relevance,
      ]);
    });
  }

  async linkedCount(questionId: string): Promise<number> {
    const r = await this.pool.query<{ n: string }>(
      `select count(*)::text as n from question_evidence qe join evidence e on e.id = qe.evidence_id where qe.question_id = $1 and e.kind = 'news'`,
      [questionId],
    );
    return Number(r.rows[0]?.n ?? 0);
  }

  async forQuestion(questionId: string): Promise<LinkedNews[]> {
    const r = await this.pool.query<{
      id: string;
      title: string | null;
      url: string | null;
      summary: string | null;
      meta: Record<string, unknown>;
      relevance: number;
    }>(
      `select e.id, e.title, e.url, e.summary, e.meta, qe.relevance
       from question_evidence qe join evidence e on e.id = qe.evidence_id
       where qe.question_id = $1 and e.kind = 'news'
       order by qe.relevance desc, e.meta->>'publishedAt' desc`,
      [questionId],
    );
    return r.rows.map((x) => ({
      evidenceId: x.id,
      title: x.title ?? '',
      source: typeof x.meta.source === 'string' ? x.meta.source : '',
      url: x.url ?? '',
      publishedAt: typeof x.meta.publishedAt === 'string' ? x.meta.publishedAt : '',
      snippet: x.summary,
      relevance: x.relevance,
    }));
  }

  async prune(before: Date): Promise<number> {
    const r = await this.pool.query('delete from news_items where published_at < $1 and evidence_id is null', [before]);
    return r.rowCount ?? 0;
  }
}

export class PgFeedStateRepo implements FeedStateRepo {
  constructor(private readonly db: Queryable) {}

  async all(): Promise<FeedState[]> {
    const r = await this.db.query<{ id: string; etag: string | null; last_modified: string | null; last_fetched_at: Date | null; last_status: string | null }>(
      'select id, etag, last_modified, last_fetched_at, last_status from feed_state',
    );
    return r.rows.map((x) => ({ id: x.id, etag: x.etag, lastModified: x.last_modified, lastFetchedAt: x.last_fetched_at, lastStatus: x.last_status }));
  }

  async put(f: FeedState): Promise<void> {
    await this.db.query(
      `insert into feed_state (id, etag, last_modified, last_fetched_at, last_status) values ($1, $2, $3, $4, $5)
       on conflict (id) do update set etag = excluded.etag, last_modified = excluded.last_modified,
         last_fetched_at = excluded.last_fetched_at, last_status = excluded.last_status`,
      [f.id, f.etag, f.lastModified, f.lastFetchedAt, f.lastStatus],
    );
  }
}

export class PgPushSubscriptionRepo implements PushSubscriptionRepo {
  constructor(private readonly db: Queryable) {}

  async add(userId: string, s: PushSubscription): Promise<void> {
    await this.db.query(
      `insert into push_subscriptions (endpoint, user_id, p256dh, auth) values ($1, $2, $3, $4)
       on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
      [s.endpoint, userId, s.p256dh, s.auth],
    );
  }

  async remove(userId: string, endpoint: string): Promise<boolean> {
    const r = await this.db.query('delete from push_subscriptions where user_id = $1 and endpoint = $2', [userId, endpoint]);
    return (r.rowCount ?? 0) > 0;
  }

  async forUser(userId: string): Promise<PushSubscription[]> {
    const r = await this.db.query<{ endpoint: string; p256dh: string; auth: string }>(
      'select endpoint, p256dh, auth from push_subscriptions where user_id = $1 order by created_at',
      [userId],
    );
    return r.rows;
  }
}
