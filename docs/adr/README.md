# Architecture decision records

One file per decision, numbered, never edited after acceptance (supersede with a new ADR instead).
Template: Context → Decision → Consequences. Status: Proposed | Accepted | Superseded by ADR-XXXX.

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-typescript-monorepo.md) | TypeScript monorepo (pnpm + Turborepo); Python only for offline ML | Accepted |
| [0002](0002-hexagonal-architecture.md) | Hexagonal architecture enforced by dependency-cruiser | Accepted |
| [0003](0003-hosting-netlify-neon.md) | Netlify (free) + Neon Postgres (free) + GitHub Actions | Accepted |
| [0004](0004-append-only-ledger.md) | Append-only ledger enforced in the database | Accepted |
| [0005](0005-resolution-source-policy.md) | Resolution sources are declared up front and never changed | Accepted |
| [0006](0006-scrypt-and-pg-driver.md) | scrypt for passphrases; `pg` driver for Postgres | Accepted |
| [0007](0007-provisional-probability-mapping.md) | Bounded logistic mapping before a fitted one exists | Accepted |
| [0008](0008-phase1-question-engine.md) | Phase 1 question engine: identity includes horizon, lock at brief time, ~1° clusters, AQI history limits | Accepted |
| [0009](0009-phase2-world-pulse.md) | Phase 2 World Pulse: world questions, deterministic windows, adaptive ladders, news storage, Web Push fallback | Accepted |
