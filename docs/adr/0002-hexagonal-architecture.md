# ADR-0002: Hexagonal architecture, enforced in CI

**Status:** Accepted, 2026-10-05

## Context
Reckon depends on many external services (weather, FX, news, Telegram, an LLM) that will change or be replaced. Forecasting and scoring logic must be testable without the network and trustworthy over years.

## Decision
- `packages/core/src/domain`: pure functions and types. Imports only domain code and Zod.
- `packages/core/src/ports`: interfaces only (`WeatherPort`, `WorkQueue`, `Clock`, …).
- `packages/core/src/app`: use cases that depend on ports, never on adapters.
- `packages/adapters`: implementations of ports. Never imports use cases.
- `packages/runtime/src/compose.ts`: the only composition root. Plain constructor injection, no DI framework.
- `.dependency-cruiser.cjs` encodes these rules; `pnpm depcruise` runs in CI and fails on any violation (verified by deliberately adding a forbidden import).

## Consequences
- Adding a data source is one adapter plus one registration (goal G6).
- Use cases are tested with in-memory fakes (see `drain-work-queue.test.ts`).
- Slightly more files than a "just call fetch" design; accepted for longevity.
