import { PgHealthReader, PgJobRunRecorder, PgWorkQueue } from '@reckon/adapters';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Integration tests against a real Postgres (local Docker or a Neon branch).
 * Run with: DATABASE_URL=... pnpm test:integration   (after pnpm db:migrate && pnpm db:seed)
 */
const url = process.env.DATABASE_URL;

describe.runIf(Boolean(url))('database integrity (spec §5)', () => {
  const pool = new pg.Pool({ connectionString: url });
  let userId = '';
  let questionId = '';

  beforeAll(async () => {
    userId = (await pool.query<{ id: string }>('select id from users limit 1')).rows[0]?.id ?? '';
    expect(userId, 'run pnpm db:seed first').not.toBe('');
    const crit = { kind: 'test', n: Math.random() };
    questionId = (
      await pool.query<{ id: string }>(
        `insert into questions (user_id, template_id, domain, title, criteria, criteria_hash, horizon_days, correlation_group, lock_at, window_start, window_end)
         values ($1, 'test.template', 'weather', 'Integration question', $2::jsonb, md5($2::text), 1, 'test:group',
                 now() + interval '1 hour', now() + interval '1 hour', now() + interval '1 day') returning id`,
        [userId, JSON.stringify(crit)],
      )
    ).rows[0]?.id as string;
  });

  afterAll(async () => {
    await pool.end();
  });

  it('accepts a forecast before lock', async () => {
    await pool.query(`insert into forecasts (question_id, forecaster_id, p) values ($1, 'climatology@1', 0.4)`, [questionId]);
  });

  it('rejects a forecast made at or after lock time', async () => {
    await expect(
      pool.query(`insert into forecasts (question_id, forecaster_id, p, made_at) values ($1, 'climatology@1', 0.4, now() + interval '2 hours')`, [questionId]),
    ).rejects.toThrow(/not before lock_at/);
  });

  it('never lets a forecast be edited or deleted', async () => {
    await expect(pool.query('update forecasts set p = 0.9 where question_id = $1', [questionId])).rejects.toThrow(/append-only/);
    await expect(pool.query('delete from forecasts where question_id = $1', [questionId])).rejects.toThrow(/append-only/);
  });

  it('freezes question criteria but allows status changes', async () => {
    await expect(pool.query(`update questions set criteria = '{"kind":"changed"}' where id = $1`, [questionId])).rejects.toThrow(/frozen/);
    await pool.query(`update questions set status = 'locked' where id = $1`, [questionId]);
  });

  it('claims work items exactly once even when two workers race', async () => {
    const q = new PgWorkQueue(pool);
    const key = `race-${Math.random()}`;
    await q.enqueue('noop', {}, { dedupeKey: key });
    await q.enqueue('noop', {}, { dedupeKey: key }); // deduplicated
    const [a, b] = await Promise.all([q.claim(10, 60), q.claim(10, 60)]);
    const mine = [...a, ...b].filter((i) => i.kind === 'noop');
    const ids = mine.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const i of mine) await q.complete(i.id);
  });

  it('records job runs that the health endpoint can read', async () => {
    const rec = new PgJobRunRecorder(pool);
    const id = await rec.start('integration');
    await rec.finish(id, 'ok', { checked: true });
    const runs = await new PgHealthReader(pool).jobRuns();
    expect(runs.find((r) => r.job === 'integration')?.lastStatus).toBe('ok');
  });
});
