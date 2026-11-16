import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeMessenger, FakeOpenMeteo, FakePushSender, FakeWorld, MemoryEvidenceStore } from '@reckon/adapters';
import { ALL_FORECASTERS, isWorldMeta } from '@reckon/core';
import { build, type Container, pgRepos } from '@reckon/runtime';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runJob } from '../src';

/**
 * Phase 2 against real Postgres: world questions without a location, the news tables (dedupe,
 * linking into the append-only evidence ledger, retention), topics, push subscriptions and the
 * scored read behind the scoreboard. A throwaway database per run, as in the Phase 1 test.
 * Run with: DATABASE_URL=… pnpm test:integration
 */
const url = process.env.DATABASE_URL;
const ist = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+05:30`);
const MONDAY = '2026-10-05';

describe.runIf(Boolean(url))('World Pulse on Postgres', () => {
  const dbName = `reckon_it2_${Date.now().toString(36)}`;
  const admin = new pg.Client({ connectionString: url });
  let pool: pg.Pool;
  let c: Container;
  let app: NonNullable<Container['db']>['app'];
  const clock = {
    t: ist(MONDAY, '04:45'),
    now() {
      return this.t;
    },
  };
  const fw = new FakeWorld(clock);
  const push = new FakePushSender();
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
    // What the seed does; 0002 already inserted the Phase 2 forecasters, so conflicts are expected.
    for (const f of ALL_FORECASTERS)
      await pool.query('insert into forecasters (id, kind, display_name) values ($1, $2, $3) on conflict (id) do nothing', [f.id, f.kind, f.displayName]);
    userId = (await pool.query<{ id: string }>(`insert into users (tz) values ('Asia/Kolkata') returning id`)).rows[0]?.id ?? '';
    await pool.query(`insert into locations (user_id, name, lat, lon, tz, is_primary) values ($1, 'Bengaluru', 12.97, 77.59, 'Asia/Kolkata', true)`, [userId]);
    c = build(
      {},
      {
        clock,
        repos: pgRepos(pool),
        sources: { ...new FakeOpenMeteo(clock), ...fw },
        evidenceStore: new MemoryEvidenceStore(),
        messenger: new FakeMessenger(),
        pushSender: push,
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

  it('stores world questions without a location, with every forecast before lock', async () => {
    await runJob(c, 'generate');
    const r = await pool.query<{ template_id: string; n: string }>(
      `select template_id, count(*)::text as n from questions where location_id is null group by template_id order by template_id`,
    );
    expect(r.rows.map((x) => x.template_id)).toEqual([
      'fx.usdinr_week',
      'news.topic_surge',
      'space.kp_storm_3d',
      'tech.incident_week',
      'tech.release_week',
      'world.quake_m6_week',
    ]);
    const late = await pool.query(`select 1 from forecasts f join questions q on q.id = f.question_id where f.made_at >= q.lock_at`);
    expect(late.rowCount).toBe(0);
    // Running again creates nothing new.
    const before = (await pool.query<{ n: string }>('select count(*)::text as n from forecasts')).rows[0]?.n;
    for (const t of ['tech.release_week', 'space.kp_storm_3d']) await app.generateWorld(userId, t);
    expect((await pool.query<{ n: string }>('select count(*)::text as n from forecasts')).rows[0]?.n).toBe(before);
  });

  it('seeds topics once and keeps a removal', async () => {
    const t = await app.topics(userId);
    expect(t.topics.map((x) => x.label)).toContain('Bengaluru');
    const google = t.topics.find((x) => x.label === 'Google');
    await app.removeTopic(userId, google?.id ?? '');
    expect((await app.topics(userId)).topics.some((x) => x.label === 'Google')).toBe(false);
    const { rows } = await pool.query<{ enabled: boolean }>(`select enabled from topics where user_id = $1 and key = 'google'`, [userId]);
    expect(rows[0]?.enabled).toBe(false);
  });

  it('turns linked headlines into hashed, append-only evidence and prunes only unlinked ones', async () => {
    clock.t = ist(MONDAY, '05:35');
    const stats = await runJob(c, 'news');
    expect(stats.inserted).toBeGreaterThan(0);
    expect(stats.linked).toBeGreaterThan(0);
    const news = await pool.query<{ n: string }>(`select count(*)::text as n from evidence where kind = 'news' and blob_key is null and length(sha256) = 64`);
    expect(Number(news.rows[0]?.n)).toBeGreaterThan(0);
    await expect(pool.query(`update evidence set title = 'changed' where kind = 'news'`)).rejects.toThrow(/append-only/);

    const quake = (await pool.query<{ id: string }>(`select id from questions where template_id = 'world.quake_m6_week'`)).rows[0]?.id ?? '';
    const detail = await app.questionDetail(userId, quake);
    expect(detail?.news.some((n) => n.title.includes('earthquake'))).toBe(true);
    expect(detail?.evidence.every((e) => !e.sourceId.startsWith('news.'))).toBe(true);

    // A second run the same hour finds nothing new and links nothing twice.
    fw.failing.add('search');
    clock.t = ist(MONDAY, '05:45');
    const again = await runJob(c, 'news');
    expect(again.inserted).toBe(0);
    expect(again.linked).toBe(0);
    fw.failing.delete('search');

    // 91 days later unlinked headlines are gone; linked ones survive as evidence.
    await pool.query(`insert into news_items (canonical_url, url, title, source, published_at, origin, simhash, fetched_at)
      values ('https://old.example/x', 'https://old.example/x', 'Old', 'Old', now() - interval '200 days', 'rss', 1, now())`);
    const pruned = await c.db?.app.runNews(0);
    expect(pruned?.pruned).toBeGreaterThanOrEqual(1);
    const linkedLeft = await pool.query(`select 1 from news_items where evidence_id is not null`);
    expect(linkedLeft.rowCount).toBeGreaterThan(0);
  });

  it('stores push subscriptions and resolves a week into the scored read', async () => {
    await app.subscribePush(userId, { endpoint: 'https://push.example/1', p256dh: 'k', auth: 'a' });
    await app.subscribePush(userId, { endpoint: 'https://push.example/1', p256dh: 'k2', auth: 'a2' });
    expect((await pool.query('select p256dh from push_subscriptions')).rows).toEqual([{ p256dh: 'k2' }]);

    for (let d = 0; d <= 8; d++) {
      const date = new Date(Date.parse(`${MONDAY}T00:00:00Z`) + d * 86_400_000).toISOString().slice(0, 10);
      for (const hhmm of ['04:45', '06:15', '06:35', '14:05', '20:45']) {
        clock.t = ist(date, hhmm);
        await runJob(c, hhmm === '04:45' ? 'generate' : 'tick');
      }
    }
    const weekly = await pool.query<{ status: string; template_id: string }>(
      `select status, template_id from questions where location_id is null and target_date <= '2026-10-11'`,
    );
    expect(weekly.rows.filter((r) => r.status !== 'resolved')).toEqual([]);
    expect(push.sent.length).toBeGreaterThan(0); // no Telegram linked: briefs went by Web Push

    const scored = await c.db?.app.scoreboard(userId);
    expect(scored?.templates.map((t) => t.templateId)).toEqual(expect.arrayContaining(['world.quake_m6_week', 'wx.rain_any']));
    const ws = await pool.query(`select 1 from scores s join questions q on q.id = s.question_id where q.location_id is null`);
    expect(ws.rowCount).toBeGreaterThan(0);
    expect(worldOnly(await pool.query<{ meta: { scope?: string } }>(`select meta from questions where location_id is null`))).toBe(true);
  }, 60_000);
});

function worldOnly(r: { rows: { meta: { scope?: string } }[] }): boolean {
  return r.rows.every((x) => isWorldMeta(x.meta as never));
}
