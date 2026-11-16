# Contributing to Reckon

## Before you write code

1. Read [docs/spec/00-index.md](docs/spec/00-index.md) and the section for the area you are touching.
2. Pick the first unticked task in your phase in [docs/spec/06-roadmap.md](docs/spec/06-roadmap.md).
3. If your change departs from the spec, write an ADR in `docs/adr` first (copy an existing one).

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

- Branch from `dev`; open PRs into `dev`. Merge `dev` → `main` about weekly (production deploys cost Netlify credits).
- Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`).
- Run `pnpm verify` before pushing; CI runs the same plus integration tests.

## Definition of Done

Code, tests, docs updated; accessible (keyboard, contrast, reduced motion); observable (logs and `job_runs` stats); deployed to a preview; the phase's acceptance criteria still pass.
