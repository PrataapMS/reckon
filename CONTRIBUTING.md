# Contributing to Reckon

## Before you write code

1. Check [docs/ROADMAP.md](docs/ROADMAP.md) and the open issues for what is planned.
2. For anything beyond a small fix, open an issue first to agree the approach.

## Architecture rules (enforced by `pnpm depcruise`)

- Domain code (`packages/core/src/domain`) is pure: no I/O, no clock, no randomness. Use the `Clock` and `Rng` ports.
- Use cases (`packages/core/src/app`) depend on ports, never on adapters.
- Adapters implement ports and never import use cases.
- Wire concrete adapters only in `packages/runtime/src/compose.ts`.
- External data enters only through Zod parsing. No `any`.
- Expected failures return `Result<T, E>`; throw only for programmer errors.

## Adding a data source (the most common change)

1. Read the provider's docs; write `packages/adapters/src/sources/<name>/SOURCE.md` (endpoint, auth, licence, limits).
2. Add a port in `packages/core/src/ports` if no existing one fits.
3. Implement the adapter using `httpGetText` (timeout, retry and error codes for free).
4. Record a real response into `packages/adapters/test/fixtures/` and write a fixture test plus a `*.contract.test.ts`.
5. Register it in the composition root.

## Workflow

- Branch from `dev`; open PRs into `dev`.
- Small, focused commits with a short subject and a one-line body.
- Production deploys run only on a major version tag (`vN.0.0`) and need approval.
- Run `pnpm verify` before pushing; CI runs the same plus integration tests.

## Definition of Done

Code, tests, docs updated; accessible (keyboard, contrast, reduced motion); observable (logs and `job_runs` stats); the phase's acceptance criteria still pass.
