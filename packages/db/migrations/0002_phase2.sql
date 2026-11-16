-- Phase 2: World Pulse and Evidence (spec 06-roadmap, Phase 2; ADR-0009).

-- New forecasters. Inserted here, not only by the seed, because forecasts reference them.
insert into forecasters (id, kind, display_name) values
  ('history.rate@1', 'history', 'Recent base rate'),
  ('provider.swpc@1', 'provider', 'NOAA SWPC forecast')
on conflict (id) do nothing;

-- World questions are about no place: location_id stays null (it is already nullable).
create index questions_template_target on questions (user_id, template_id, target_date);

-- News topics. Removing a topic disables it, so defaults are seeded exactly once per user.
create table topics (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users on delete cascade,
  key text not null,                  -- 'ai', 'custom:monsoon', 'city:bengaluru'
  label text not null,
  query text,                         -- GDELT query, null when the label is too short to search
  keywords text[] not null default '{}',
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique (user_id, key)
);

-- Headlines (spec §3.6). Mutable staging: unlinked rows expire after 90 days. When a headline is
-- first linked to a question it is copied into the append-only `evidence` ledger (kind 'news').
create table news_items (
  id uuid primary key default gen_random_uuid(),
  canonical_url text not null unique,
  url text not null,
  title text not null,
  source text not null,
  published_at timestamptz not null,
  snippet text check (snippet is null or length(snippet) <= 280),
  lang text,
  origin text not null check (origin in ('rss','gdelt','hn')),
  simhash bigint not null,
  tags text[] not null default '{}',
  fetched_at timestamptz not null,
  evidence_id uuid references evidence
);
create index news_items_published on news_items (published_at desc);
create index news_items_tags on news_items using gin (tags);

-- Conditional-fetch state per feed and GDELT search (ETag, Last-Modified, last attempt).
create table feed_state (
  id text primary key,                -- 'rss:bbc-world', 'hn', 'gdelt:<query>'
  etag text,
  last_modified text,
  last_fetched_at timestamptz,
  last_status text
);

-- Web Push (VAPID) subscriptions, one per browser.
create table push_subscriptions (
  endpoint text primary key,
  user_id uuid not null references users on delete cascade,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);
create index push_subscriptions_user on push_subscriptions (user_id);

grant select, insert, update, delete on topics, news_items, feed_state, push_subscriptions to reckon_app;
