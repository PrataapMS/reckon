-- Reckon initial schema (spec §5). Hand-written because it carries triggers and grants.
-- Later table changes may be generated with drizzle-kit, but integrity triggers stay in SQL.

create extension if not exists pgcrypto;

create table users (
  id uuid primary key default gen_random_uuid(),
  display_name text,
  tz text not null default 'UTC',
  brief_time time not null default '06:30',
  reveal_time time not null default '21:00',
  quiet_start time not null default '22:30',
  quiet_end time not null default '06:00',
  telegram_chat_id bigint unique,
  created_at timestamptz not null default now()
);

create table locations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users on delete cascade,
  name text not null,
  lat double precision not null check (lat between -90 and 90),
  lon double precision not null check (lon between -180 and 180),
  tz text not null,
  is_primary boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index locations_one_primary on locations (user_id) where is_primary;

create table templates (
  id text not null,
  version int not null,
  domain text not null,
  definition jsonb not null,
  enabled boolean not null default true,
  primary key (id, version)
);

create table forecasters (
  id text primary key,                 -- 'provider.openmeteo@1', 'climatology@1', 'user'
  kind text not null check (kind in ('provider','ensemble','climatology','persistence','history','crowd','blend','llm','human')),
  display_name text not null,
  config jsonb not null default '{}'
);

create table questions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users on delete cascade,
  template_id text,
  template_version int,
  domain text not null,
  title text not null,
  criteria jsonb not null,             -- frozen; enforced by trigger below
  criteria_hash text not null,         -- sha256 of canonical JSON
  horizon_days int not null check (horizon_days >= 0),
  correlation_group text not null,     -- e.g. 'wx:2026-10-06:IN-KA'
  lock_at timestamptz not null,
  window_start timestamptz not null,
  window_end timestamptz not null,
  status text not null default 'open' check (status in ('open','locked','resolving','resolved','annulled')),
  annul_reason text,
  created_at timestamptz not null default now(),
  check (lock_at <= window_start and window_start < window_end),
  unique (user_id, template_id, criteria_hash)
);
create index questions_status_lock on questions (status, lock_at);
create index questions_status_window_end on questions (status, window_end);

create table evidence (
  id uuid primary key default gen_random_uuid(),
  source_id text not null,
  kind text not null check (kind in ('snapshot','news')),
  fetched_at timestamptz not null,
  blob_key text,
  sha256 text not null,
  title text,
  url text,
  summary text,
  meta jsonb not null default '{}'
);
create index evidence_source_fetched on evidence (source_id, fetched_at desc);

create table forecasts (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references questions,
  forecaster_id text not null references forecasters,
  p double precision not null check (p > 0 and p < 1),
  made_at timestamptz not null default now(),
  rationale text,
  evidence_ids uuid[] not null default '{}'
);
create index forecasts_question on forecasts (question_id, forecaster_id, made_at desc);

create table resolutions (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references questions,
  outcome smallint check (outcome in (0,1)),  -- null when annulled
  observed_value double precision,
  observed_unit text,
  evidence_id uuid references evidence,
  resolver_version text not null,
  resolved_at timestamptz not null default now(),
  supersedes uuid references resolutions
);
create index resolutions_question on resolutions (question_id, resolved_at desc);

create table question_evidence (
  question_id uuid not null references questions,
  evidence_id uuid not null references evidence,
  relevance real not null default 0.5,
  linked_at timestamptz not null default now(),
  primary key (question_id, evidence_id)
);

create table work_items (
  id bigserial primary key,
  kind text not null,
  payload jsonb not null,
  dedupe_key text unique,
  run_after timestamptz not null default now(),
  attempts int not null default 0,
  max_attempts int not null default 6,
  leased_until timestamptz,
  last_error text,
  done_at timestamptz
);
create index work_items_ready on work_items (run_after) where done_at is null;

create table notifications_outbox (
  id bigserial primary key,
  channel text not null check (channel in ('telegram','webpush')),
  kind text not null,
  payload jsonb not null,
  dedupe_key text unique,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  attempts int not null default 0
);

create table job_runs (
  id bigserial primary key,
  job text not null,
  started_at timestamptz not null,
  finished_at timestamptz,
  status text check (status in ('ok','error')),
  stats jsonb
);
create index job_runs_job_started on job_runs (job, started_at desc);

create table source_health (
  source_id text primary key,
  last_ok_at timestamptz,
  last_error_at timestamptz,
  consecutive_failures int not null default 0,
  status text not null default 'healthy' check (status in ('healthy','degraded','down'))
);

create table user_stats (
  user_id uuid primary key references users on delete cascade,
  open_streak int not null default 0,
  best_streak int not null default 0,
  last_open_date date,
  freezes_left int not null default 2,
  xp int not null default 0
);

-- ---------------------------------------------------------------------------
-- Integrity: the ledger is append-only (spec §2 principle 2, §5 integrity rules)
-- ---------------------------------------------------------------------------

create function reckon_forbid_change() returns trigger language plpgsql as $$
begin
  raise exception 'reckon: % on % is not allowed; the ledger is append-only', tg_op, tg_table_name
    using errcode = 'P0001';
end $$;

create trigger forecasts_append_only before update or delete on forecasts
  for each row execute function reckon_forbid_change();
create trigger evidence_append_only before update or delete on evidence
  for each row execute function reckon_forbid_change();
create trigger resolutions_append_only before update or delete on resolutions
  for each row execute function reckon_forbid_change();

create function reckon_forecast_before_lock() returns trigger language plpgsql as $$
declare v_lock timestamptz;
begin
  select lock_at into v_lock from questions where id = new.question_id;
  if new.made_at >= v_lock then
    raise exception 'reckon: forecast made at % is not before lock_at %', new.made_at, v_lock using errcode = 'P0002';
  end if;
  return new;
end $$;

create trigger forecasts_before_lock before insert on forecasts
  for each row execute function reckon_forecast_before_lock();

create function reckon_freeze_criteria() returns trigger language plpgsql as $$
begin
  if new.criteria is distinct from old.criteria or new.criteria_hash is distinct from old.criteria_hash
     or new.lock_at is distinct from old.lock_at or new.window_start is distinct from old.window_start
     or new.window_end is distinct from old.window_end then
    raise exception 'reckon: question criteria and windows are frozen' using errcode = 'P0003';
  end if;
  return new;
end $$;

create trigger questions_frozen before update on questions
  for each row execute function reckon_freeze_criteria();

-- ---------------------------------------------------------------------------
-- Scores: last forecast per forecaster before lock, against the latest resolution
-- ---------------------------------------------------------------------------

create view latest_resolutions as
  select distinct on (question_id) *
  from resolutions r
  where not exists (select 1 from resolutions s where s.supersedes = r.id)
  order by question_id, resolved_at desc;

create view scores as
  with last_forecast as (
    select distinct on (f.question_id, f.forecaster_id) f.*
    from forecasts f join questions q on q.id = f.question_id
    where f.made_at < q.lock_at
    order by f.question_id, f.forecaster_id, f.made_at desc
  )
  select lf.question_id, lf.forecaster_id, q.template_id, q.domain, q.horizon_days, q.correlation_group,
         lf.p, lr.outcome,
         (lf.p - lr.outcome) ^ 2 as brier,
         -(lr.outcome * ln(greatest(least(lf.p, 0.99), 0.01))
           + (1 - lr.outcome) * ln(1 - greatest(least(lf.p, 0.99), 0.01))) as log_score,
         lr.resolved_at
  from last_forecast lf
  join questions q on q.id = lf.question_id and q.status = 'resolved'
  join latest_resolutions lr on lr.question_id = lf.question_id and lr.outcome is not null;

-- ---------------------------------------------------------------------------
-- Least-privilege application role (defence in depth; triggers already block changes)
-- Grant it to your Neon login role:  grant reckon_app to <your_login_role>;
-- ---------------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'reckon_app') then
    create role reckon_app nologin;
  end if;
end $$;

grant select, insert, update, delete on users, locations, templates, forecasters, questions,
  question_evidence, work_items, notifications_outbox, job_runs, source_health, user_stats to reckon_app;
grant select, insert on forecasts, evidence, resolutions to reckon_app;
grant select on scores, latest_resolutions to reckon_app;
grant usage, select on all sequences in schema public to reckon_app;
