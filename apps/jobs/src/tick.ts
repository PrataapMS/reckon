import type { Container } from '@reckon/runtime';

/**
 * Scheduled jobs (spec §3.4). Each job records a `job_runs` row with its stats. Every step is
 * idempotent and "due"-based, so a missed or doubled run never loses or repeats work: tick
 * repeats the generate, brief and reveal checks hourly as a safety net.
 */
export type JobName = 'tick' | 'generate' | 'brief' | 'reveal' | 'news';

type App = NonNullable<Container['db']>;

/** Netlify scheduled functions stop at 30 s; leave room for the steps after the drain. */
const BUDGET_MS: Record<JobName, number> = { tick: 16_000, generate: 22_000, brief: 0, reveal: 14_000, news: 20_000 };

const steps: Record<JobName, (db: App) => Promise<Record<string, unknown>>> = {
  async tick(db) {
    const resolutions = await db.app.lockAndEnqueueResolutions();
    const generationsEnqueued = (await db.app.enqueueDueGeneration()) + (await db.app.enqueueDueWorldGeneration());
    const drain = await db.drain(db.app.handlers, BUDGET_MS.tick);
    const briefs = await db.app.buildDueBriefs();
    const reveals = await db.app.buildDueReveals();
    const outbox = await db.app.sendOutbox();
    return { ...resolutions, generationsEnqueued, drain, briefs, reveals, outbox };
  },
  async generate(db) {
    const generationsEnqueued = (await db.app.enqueueDueGeneration()) + (await db.app.enqueueDueWorldGeneration());
    const drain = await db.drain(db.app.handlers, BUDGET_MS.generate);
    return { generationsEnqueued, drain };
  },
  async brief(db) {
    const briefs = await db.app.buildDueBriefs();
    const outbox = await db.app.sendOutbox();
    return { briefs, outbox };
  },
  async reveal(db) {
    const resolutions = await db.app.lockAndEnqueueResolutions();
    const drain = await db.drain(db.app.handlers, BUDGET_MS.reveal);
    const reveals = await db.app.buildDueReveals();
    const outbox = await db.app.sendOutbox();
    return { ...resolutions, drain, reveals, outbox };
  },
  async news(db) {
    return { ...(await db.app.runNews(BUDGET_MS.news)) };
  },
};

export async function runJob(c: Container, job: JobName): Promise<Record<string, unknown>> {
  if (!c.db) {
    c.logger.warn(`${job}.skipped`, { reason: 'DATABASE_URL not set' });
    return { skipped: true };
  }
  const runId = await c.db.jobRuns.start(job);
  try {
    const stats = await steps[job](c.db);
    await c.db.jobRuns.finish(runId, 'ok', stats);
    c.logger.info(`${job}.done`, stats);
    return stats;
  } catch (e) {
    await c.db.jobRuns.finish(runId, 'error', { error: String(e) });
    c.logger.error(`${job}.failed`, { error: String(e) });
    throw e;
  }
}

/** Kept for the Phase 0 entry point. */
export function runTick(c: Container): Promise<Record<string, unknown>> {
  return runJob(c, 'tick');
}
