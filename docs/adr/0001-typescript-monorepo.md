# ADR-0001: TypeScript monorepo, Python only for offline ML

**Status:** Accepted, 2026-10-05

## Context
Netlify Functions run Node.js, TypeScript and Go, not Python. The UI, API, jobs and question criteria all share the same data shapes, and contract drift between them is the most likely source of bugs in a small project.

## Decision
- One pnpm workspace with Turborepo: `apps/*` (web, api, jobs), `packages/*` (core, contracts, adapters, db, runtime), `netlify/` (function entries).
- TypeScript 5, strict, everywhere that runs in production. Packages export their `src/index.ts` directly; Vite, Vitest, tsx and Netlify's esbuild compile on the fly, so there is no package build step.
- Python (uv, scikit-learn, statsmodels) is introduced only in Phase 4, in `ml/`, and runs only in GitHub Actions. It writes model coefficients to Postgres; TypeScript reads them.

## Consequences
- One language, one set of Zod schemas, one test runner.
- The FastAPI backend from the original idea note is dropped.
- If heavy numerical work is ever needed at request time, it must be precomputed in GitHub Actions or moved to another host.
