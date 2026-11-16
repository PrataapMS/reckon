import type { HealthReader, JobRunRecorder, JobRunSummary, WorkItem, WorkQueue } from '@reckon/core';
import pg from 'pg';

/** Minimal query surface so repositories can be tested against any Postgres client. */
export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params?: unknown[]): Promise<pg.QueryResult<R>>;
}

/** One small pool per function instance; Neon pooled URLs work well with this. */
export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({
    connectionString,
    max: 3,
    idleTimeoutMillis: 10_000,
    ssl: connectionString.includes('sslmode=require') ? { rejectUnauthorized: true } : undefined,
  });
}

export class PgWorkQueue implements WorkQueue {
  constructor(private readonly db: Queryable) {}

  async enqueue(kind: string, payload: unknown, opts: { dedupeKey?: string; runAfter?: Date; maxAttempts?: number } = {}): Promise<void> {
    await this.db.query(
      `insert into work_items (kind, payload, dedupe_key, run_after, max_attempts)
       values ($1, $2, $3, coalesce($4, now()), coalesce($5, 6))
       on conflict (dedupe_key) do nothing`,
      [kind, JSON.stringify(payload), opts.dedupeKey ?? null, opts.runAfter ?? null, opts.maxAttempts ?? null],
    );
  }

  /** Spec §9: one statement claims a batch safely even when two ticks overlap. */
  async claim(limit: number, leaseSeconds: number): Promise<WorkItem[]> {
    const r = await this.db.query<{ id: string; kind: string; payload: unknown; attempts: number; max_attempts: number }>(
      `update work_items set leased_until = now() + make_interval(secs => $2), attempts = attempts + 1
       where id in (
         select id from work_items
         where done_at is null and run_after <= now()
           and (leased_until is null or leased_until < now())
           and attempts < max_attempts
         order by run_after
         limit $1
         for update skip locked)
       returning id, kind, payload, attempts, max_attempts`,
      [limit, leaseSeconds],
    );
    return r.rows.map((row) => ({ id: Number(row.id), kind: row.kind, payload: row.payload, attempts: row.attempts, maxAttempts: row.max_attempts }));
  }

  async complete(id: number): Promise<void> {
    await this.db.query('update work_items set done_at = now(), leased_until = null where id = $1', [id]);
  }

  async retryLater(id: number, error: string, runAfter: Date): Promise<void> {
    await this.db.query('update work_items set last_error = $2, run_after = $3, leased_until = null where id = $1', [id, error, runAfter]);
  }

  async giveUp(id: number, error: string): Promise<void> {
    await this.db.query('update work_items set last_error = $2, attempts = max_attempts, leased_until = null where id = $1', [id, error]);
  }

  async depth(): Promise<number> {
    const r = await this.db.query<{ n: string }>('select count(*)::text as n from work_items where done_at is null and attempts < max_attempts');
    return Number(r.rows[0]?.n ?? 0);
  }
}

export class PgJobRunRecorder implements JobRunRecorder {
  constructor(private readonly db: Queryable) {}
  async start(job: string): Promise<number> {
    const r = await this.db.query<{ id: string }>('insert into job_runs (job, started_at) values ($1, now()) returning id', [job]);
    return Number(r.rows[0]?.id);
  }
  async finish(id: number, status: 'ok' | 'error', stats: Record<string, unknown>): Promise<void> {
    await this.db.query('update job_runs set finished_at = now(), status = $2, stats = $3 where id = $1', [id, status, JSON.stringify(stats)]);
  }
}

export class PgHealthReader implements HealthReader {
  constructor(private readonly db: Queryable) {}
  async jobRuns(): Promise<JobRunSummary[]> {
    const r = await this.db.query<{ job: string; last_started_at: Date; last_status: string | null; last_ok_at: Date | null }>(
      `select job,
              max(started_at) as last_started_at,
              (array_agg(status order by started_at desc))[1] as last_status,
              max(finished_at) filter (where status = 'ok') as last_ok_at
       from job_runs group by job order by job`,
    );
    return r.rows.map((x) => ({
      job: x.job,
      lastStartedAt: x.last_started_at.toISOString(),
      lastStatus: x.last_status,
      lastOkAt: x.last_ok_at?.toISOString() ?? null,
    }));
  }
  async queueDepth(): Promise<number> {
    return new PgWorkQueue(this.db).depth();
  }
}
