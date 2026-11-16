import { ALL_FORECASTERS, ALL_TEMPLATES } from '@reckon/core';
import pg from 'pg';

/** Seeds the forecaster and template registries and a single user with a primary location. Idempotent. */
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}
const lat = Number(process.env.DEFAULT_LAT ?? 12.97);
const lon = Number(process.env.DEFAULT_LON ?? 77.59);
const tz = process.env.DEFAULT_TZ ?? 'Asia/Kolkata';

const forecasters: (readonly [string, string, string])[] = [...ALL_FORECASTERS.map((f) => [f.id, f.kind, f.displayName] as const), ['user', 'human', 'You']];

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  for (const [id, kind, name] of forecasters) {
    await client.query('insert into forecasters (id, kind, display_name) values ($1, $2, $3) on conflict (id) do nothing', [id, kind, name]);
  }
  for (const t of ALL_TEMPLATES) {
    const definition = {
      class: t.class,
      horizons: t.horizons,
      resolver: t.resolver,
      forecasters: t.forecasters,
      champion: t.champion,
      description: t.description,
    };
    await client.query(
      `insert into templates (id, version, domain, definition) values ($1, $2, $3, $4::jsonb)
       on conflict (id, version) do update set domain = excluded.domain, definition = excluded.definition`,
      [t.id, t.version, t.domain, JSON.stringify(definition)],
    );
  }
  const existing = await client.query<{ id: string }>('select id from users limit 1');
  let userId = existing.rows[0]?.id;
  if (!userId) {
    userId = (await client.query<{ id: string }>('insert into users (tz) values ($1) returning id', [tz])).rows[0]?.id;
    await client.query('insert into locations (user_id, name, lat, lon, tz, is_primary) values ($1, $2, $3, $4, $5, true)', [userId, 'Home', lat, lon, tz]);
    await client.query('insert into user_stats (user_id) values ($1)', [userId]);
  }
  console.log(`seeded ${forecasters.length} forecasters, ${ALL_TEMPLATES.length} templates and user ${userId}`);
} finally {
  await client.end();
}
