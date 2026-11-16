# ADR-0008: Phase 1 question engine — identity, lock time, clusters and data limits

**Status:** Accepted, 2026-10-05. Refines spec §3.2–§3.4 and ADR-0007 for the Phase 1 build.

## Context
Building the Daily Brief MVP raised questions the spec leaves open or gets slightly wrong:

1. **Identity.** Spec §3.2 says a question's identity is `(template, criteria_hash)`. The criteria for "rain ≥ 1 mm on Thursday" are identical whether asked 3 days ahead on Monday or 1 day ahead on Wednesday, so the 1-day question would collapse into the 3-day one. Horizon decay, a stated goal, could not be measured.
2. **Lock time.** The spec says "today's locked brief" but not when a question locks.
3. **Correlation groups.** "Same date and region" needs a concrete region.
4. **Air-quality climatology.** The Open-Meteo air-quality history (CAMS) only starts in August 2022 (checked 2026-10-05). A ±7-day window gives about 60 samples, not the 10+ years the spec assumes for weather.
5. **Provider mapping for rain.** ADR-0007 gives scales for temperature and AQI only.
6. **Resolution timing.** Spec §3.4 gives a backoff schedule (1, 3, 6, 12, 24, 48 h) and a 72-hour annul deadline; followed literally, the last retry lands after the deadline.
7. **Which day the Reveal shows.** A day's values are only published after it ends, so the evening reveal cannot judge the same day.

## Decision
1. **Identity is `(user, template, criteria_hash, horizon_days)`** (constraint `questions_identity`, migration `0001_phase1.sql`). `criteria_hash` stays the SHA-256 of the canonical criteria JSON. `horizon_days` and `target_date` are frozen by the same trigger as the criteria.
2. **Questions lock at the user's brief time on the day they are generated**, so the morning brief shows exactly what is scored. If generation runs late, a question locks 15 minutes after generation. It is never later than the start of its window, and is skipped if the window has already begun. Generation becomes due two hours before the brief time.
3. **Correlation group = `<target date>:<round(lat)>:<round(lon)>`**, a ~1° grid. Weather and air questions about the same day and area are one cluster, so "30 clusters" means about 30 independent days.
4. **Climatology needs at least 45 samples** (three seasons of ±7 days) instead of an implicit 60. Weather uses 12 years of ERA5 from the archive API; US AQI uses everything since 2022-08-01. Adaptive templates skip a day when no rung of the ladder has a base rate in [0.25, 0.75] (spec §3.2 step 4).
5. **Rain uses the provisional logistic with scale `max(1, threshold / 2)` mm**, still clipped to [0.2, 0.8]. "Any rain" (threshold ≤ 1 mm) uses the provider's precipitation probability, as the spec says. `provisionalProbability` moved to `packages/core/src/domain/probability.ts` so pure forecasters can use it.
6. **Resolver `openmeteo.daily@1` runs 6 hours after the local day ends** and retries on the backoff schedule, but never past `window_end + retryUntilHours`. At that deadline it annuls with the last error code. A past day's AQI needs at least 20 of its 24 hourly values, or it counts as missing and is retried.
7. **The Reveal shows yesterday's claims.** They open at the user's reveal time today (21:00 by default) and are sealed before that. The API withholds outcomes and resolution evidence for sealed days. The brief and reveal jobs build their messages up to 30 minutes early; the Telegram reveal may therefore arrive up to 15 minutes before the in-app cards open.
8. **Ensemble = ECMWF IFS 0.25° (51 members)** via `models=ecmwf_ifs025`, counting the control run as a member.
9. **Repositories take timestamps from the app `Clock`** where a guardrail compares times (the outbox's `created_at`, `sent_at`, `skipped_at`), so the fake-clock E2E run and production behave the same.

## Consequences
- The same claim appears at up to three horizons. The brief and reveal show the freshest (shortest horizon); the scoreboard can compare all three.
- Air-quality base rates are noisier than weather's until more history accumulates. They are labelled with their sample size in the climatology rationale.
- A day with a source outage annuls exactly 72 hours after it closed, matching G2.
- Changing any of these is a new template or forecaster version, so existing track records stay honest.
