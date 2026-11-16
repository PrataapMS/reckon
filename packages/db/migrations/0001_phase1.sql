-- Phase 1: Daily Brief MVP (spec 06-roadmap, Phase 1; ADR-0008).

-- Users: onboarding state, pause switch and tunable action thresholds.
alter table users
  add column onboarded_at timestamptz,
  add column notifications_paused boolean not null default false,
  add column settings jsonb not null default '{}';

-- Questions: which location and local date a question is about, plus display metadata.
-- These are set at creation; the frozen-criteria trigger below is extended to cover them.
alter table questions
  add column location_id uuid references locations on delete set null,
  add column target_date date,
  add column meta jsonb not null default '{}';

-- ADR-0008: the same claim asked at different horizons is a different question, so the
-- horizon is part of the identity. Without it, the 1-day question for a date would collapse
-- into the 3-day question already asked about that date, and horizon decay could not be measured.
alter table questions drop constraint questions_user_id_template_id_criteria_hash_key;
alter table questions add constraint questions_identity unique (user_id, template_id, criteria_hash, horizon_days);
create index questions_user_target on questions (user_id, target_date);

create or replace function reckon_freeze_criteria() returns trigger language plpgsql as $$
begin
  if new.criteria is distinct from old.criteria or new.criteria_hash is distinct from old.criteria_hash
     or new.lock_at is distinct from old.lock_at or new.window_start is distinct from old.window_start
     or new.window_end is distinct from old.window_end or new.horizon_days is distinct from old.horizon_days
     or new.target_date is distinct from old.target_date then
    raise exception 'reckon: question criteria and windows are frozen' using errcode = 'P0003';
  end if;
  return new;
end $$;

-- Climatology cache (monthly refresh): one daily series per grid point and metric.
create table climatology (
  lat double precision not null,
  lon double precision not null,
  metric text not null,               -- 'precipitation_sum' | 'temperature_2m_max' | 'us_aqi'
  source_id text not null,
  series_start date not null,
  vals jsonb not null,                -- array of numbers or nulls, one per day from series_start
  evidence_id uuid references evidence,
  refreshed_at timestamptz not null default now(),
  primary key (lat, lon, metric)
);

-- One-time Telegram deep-link tokens (t.me/<bot>?start=<token>).
create table link_tokens (
  token text primary key,
  user_id uuid not null references users on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz
);

-- Outbox: who it is for, and why it was skipped (quiet hours expiry, paused, cap).
alter table notifications_outbox
  add column user_id uuid references users on delete cascade,
  add column skipped_at timestamptz,
  add column skip_reason text,
  add column last_error text;
create index outbox_pending on notifications_outbox (created_at) where sent_at is null and skipped_at is null;

grant select, insert, update, delete on climatology, link_tokens to reckon_app;
