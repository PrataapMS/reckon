# ADR-0004: Append-only ledger enforced in the database

**Status:** Accepted, 2026-10-05

## Context
Reckon's credibility rests on one promise: predictions never disappear and are never quietly edited after the fact. Enforcing that only in application code is fragile.

## Decision
In `packages/db/migrations/0000_init.sql`:
- Triggers reject `UPDATE` and `DELETE` on `forecasts`, `evidence` and `resolutions`.
- A trigger rejects any forecast whose `made_at` is not strictly before the question's `lock_at`.
- A trigger rejects changes to a question's criteria, criteria hash, lock time or window. Status may change.
- Corrections are new `resolutions` rows with `supersedes`; the `latest_resolutions` and `scores` views use the newest non-superseded row.
- The `reckon_app` role only has `SELECT, INSERT` on the append-only tables (defence in depth).

## Consequences
- `packages/db/test/integration.test.ts` proves each rule against real Postgres.
- Fixing a genuinely wrong resolution means inserting a superseding row, which stays visible in history.
- Schema changes to these tables need a migration that temporarily disables the trigger, written deliberately and reviewed.
