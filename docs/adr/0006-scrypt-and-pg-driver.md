# ADR-0006: scrypt for passphrases; `pg` driver for Postgres

**Status:** Accepted, 2026-10-05. Refines spec §15 (which named Argon2id) and the stack table (Neon driver).

## Context
- Argon2id needs a native module, which complicates Netlify's esbuild bundling.
- Neon's serverless HTTP driver only talks to Neon, so local development against Docker Postgres and CI integration tests would need a different code path.

## Decision
- Passphrases are hashed with Node's built-in `crypto.scrypt` (N = 2^15, r = 8, p = 1, 16-byte salt, 32-byte key), stored as `scrypt$N$r$p$salt$hash`, compared with `timingSafeEqual`. Generate with `pnpm --filter @reckon/api hash-passphrase "…"`.
- All database access uses `pg` (node-postgres) with a small pool (max 3). It works identically against Neon's pooled connection string, local Docker and the CI Postgres service. `pg-native` is excluded from bundles in `netlify.toml`.
- Drizzle remains available for typed queries (`packages/db/src/schema.ts`); DDL, triggers and grants stay in hand-written SQL migrations.

## Consequences
- One code path everywhere; integration tests run in CI.
- If cold-start connection time ever matters, Neon's serverless driver can be added as a second `Queryable` implementation behind the same interface.
