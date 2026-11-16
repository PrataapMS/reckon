import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeMessenger, FakeOpenMeteo, FakeWorld, MemoryEvidenceStore } from '@reckon/adapters';
import { build, type Container, pgRepos } from '@reckon/runtime';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runJob } from '../src';

/**
 * The Phase 1 loop against real Postgres: the SQL repositories, triggers, the `scores` view and
 * transactions. Each run migrates a throwaway database, because the ledger is append-only and
 * cannot be cleaned up afterwards.
 * Run with: DATABASE_URL=… pnpm test:integration
 */
const url = process.env.DATABASE_URL;

const ist = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+05:30`);

describe.runIf(Boolean(url))('daily loop on Postgres', () => {
  const dbName = `reckon_it_${Date.now().toString(36)}`;
  const admin = new pg.Client({ connectionString: url });
  let pool: pg.Pool;
  let c: Container;
  let app: NonNullable<Container['db']>['app'];
  const clock = {
    t: ist('2026-10-06', '04:45'),
    now() {
      return this.t;
    },
  };
  const tg = new FakeMessenger();
  let userId = '';

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`create database ${dbName}`);
    const u = new URL(url as string);
    u.pathname = `/${dbName}`;
    pool = new pg.Pool({ connectionString: u.toString(), max: 4 });
    const dir = new URL('../../../packages/db/migrations/', import.meta.url).pathname;
    for (const f of readdirSync(dir)
      .filter((x) => x.endsWith('.sql'))
      .sort())
      await pool.query(readFileSync(join(dir, f), 'utf8'));
    for (const [id, kind, name] of [
      ['provider.openmeteo@1', 'provider', 'Open-Meteo provider'],
      ['ensemble.openmeteo@1', 'ensemble', 'Open-Meteo ensemble'],
      ['climatology@1', 'climatology', 'Climatology'],
      ['persistence@1', 'persistence', 'Persistence'],
    ])
      await pool.query('insert into forecasters (id, kind, display_name) values ($1, $2, $3)', [id, kind, name]);
    userId = (await pool.query<{ id: string }>(`insert into users (tz, telegram_chat_id) values ('Asia/Kolkata', 42) returning id`)).rows[0]?.id ?? '';
    await pool.query(`insert into locations (user_id, name, lat, lon, tz, is_primary) values ($1, 'Home', 12.97, 77.59, 'Asia/Kolkata', true)`, [userId]);

    c = build(
      {},
      {
        clock,
        repos: pgRepos(pool),
        sources: { ...new FakeOpenMeteo(clock), ...new FakeWorld(clock) },
        evidenceStore: new MemoryEvidenceStore(),
        messenger: tg,
        logger: { info() {}, warn() {}, error() {} },
      },
    );
    app = c.db?.app as typeof app;
  });

  afterAll(async () => {
    await pool?.end();
    if (!process.env.KEEP_DB) await admin.query(`drop database if exists ${dbName}`);
    await admin.end();
  });

  async function day(date: string) {
    clock.t = ist(date, '04:45');
    await runJob(c, 'generate');
    clock.t = ist(date, '06:15');
    await runJob(c, 'brief');
    clock.t = ist(date, '06:35');
    await runJob(c, 'tick');
    clock.t = ist(date, '20:45');
    await runJob(c, 'reveal');
  }

  it('generates, locks, resolves and reveals through the SQL repositories', async () => {
    await day('2026-10-06');
    await day('2026-10-07');
    await day('2026-10-08');

    // 7 Oct resolved on the 8 Oct morning tick; later days are still locked.
    const counts = (
      await pool.query<{ target: string; status: string; n: string }>(
        'select target_date::text as target, status, count(*)::text as n from questions group by 1, 2 order by 1',
      )
    ).rows;
    const oct7 = counts.filter((r) => r.target === '2026-10-07');
    expect(oct7.map((r) => r.status)).toEqual(['resolved']);
    expect(Number(oct7[0]?.n)).toBeGreaterThanOrEqual(4);
    expect(counts.filter((r) => r.target > '2026-10-07').every((r) => r.status === 'locked')).toBe(true);

    // Re-running generation for a day already generated writes nothing new.
    const before = (await pool.query<{ n: string }>('select count(*)::text as n from forecasts')).rows[0]?.n;
    clock.t = ist('2026-10-08', '05:00');
    const locId = (await pool.query<{ id: string }>('select id from locations limit 1')).rows[0]?.id ?? '';
    await app.generate(locId);
    expect((await pool.query<{ n: string }>('select count(*)::text as n from forecasts')).rows[0]?.n).toBe(before);

    // The scores view sees every resolved forecaster, and the brief reads trust from it.
    const scored = await pool.query<{ forecaster_id: string }>(
      'select distinct s.forecaster_id from scores s join questions q on q.id = s.question_id where q.location_id is not null',
    );
    expect(scored.rows.map((r) => r.forecaster_id).sort()).toEqual(['climatology@1', 'ensemble.openmeteo@1', 'persistence@1', 'provider.openmeteo@1']);
    clock.t = ist('2026-10-08', '21:05');
    const me = await app.me(userId);
    expect(me?.stats.resolvedDays).toBe(1);
    const brief = await app.brief(userId);
    expect(brief?.today.length).toBeGreaterThanOrEqual(4);
    expect(brief?.today[0]?.trust).toMatchObject({ status: 'learning', clusters: 1, needed: 30 });

    const reveal = await app.reveal(userId, 'latest');
    expect(reveal).toMatchObject({ date: '2026-10-07', sealed: false });
    expect(reveal?.cards.every((card) => card.outcome != null && card.observed != null)).toBe(true);

    const sent = (
      await pool.query<{ kind: string; n: string }>('select kind, count(*)::text as n from notifications_outbox where sent_at is not null group by kind')
    ).rows;
    expect(Object.fromEntries(sent.map((r) => [r.kind, Number(r.n)]))).toEqual({ brief: 3, reveal: 1 }); // 5 and 6 Oct had nothing to reveal
    expect(tg.sent).toHaveLength(4);
  });

  it('keeps the ledger append-only: one resolution per question, even when resolving twice', async () => {
    const q = (await pool.query<{ id: string }>(`select id from questions where status = 'resolved' limit 1`)).rows[0]?.id ?? '';
    await pool.query(`insert into work_items (kind, payload) values ('resolve', $1::jsonb)`, [JSON.stringify({ questionId: q })]);
    await runJob(c, 'tick');
    const n = (await pool.query<{ n: string }>('select count(*)::text as n from resolutions where question_id = $1', [q])).rows[0]?.n;
    expect(n).toBe('1');
    await expect(pool.query('update resolutions set outcome = 1 - outcome where question_id = $1', [q])).rejects.toThrow(/append-only/);
  });

  it('rejects changing a question’s horizon or target date (frozen with the criteria)', async () => {
    const q = (await pool.query<{ id: string }>('select id from questions limit 1')).rows[0]?.id ?? '';
    await expect(pool.query('update questions set horizon_days = horizon_days + 1 where id = $1', [q])).rejects.toThrow(/frozen/);
    await expect(pool.query(`update questions set target_date = target_date + 1 where id = $1`, [q])).rejects.toThrow(/frozen/);
  });

  it('consumes a Telegram link token once', async () => {
    const link = await app.telegramLink(userId);
    expect(link).toBeNull(); // no bot username configured in this container
    await pool.query(`insert into link_tokens (token, user_id, expires_at) values ('tok-1', $1, '2030-01-01')`, [userId]);
    await app.telegramMessage('9001', '/start tok-1');
    await app.telegramMessage('9002', '/start tok-1');
    const chat = (await pool.query<{ c: string }>('select telegram_chat_id::text as c from users where id = $1', [userId])).rows[0]?.c;
    expect(chat).toBe('9001');
  });
});
