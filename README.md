# Reckon

**Reality keeps score.**

Reckon makes small, concrete predictions about your near future (rain, air quality, and later currency moves, tech releases, outages and your own deadlines), checks every one against a pre-declared data source, and shows exactly how trustworthy each kind of prediction is. It never claims to know the future; it measures what is predictable.

## Status

**Phases 0–2 are built and verified.** Each morning Reckon writes weather and air-quality questions for your places plus World Pulse questions about money, tech, space and the news (11 templates). Every forecaster's probability is locked before the question opens, each question resolves from its declared public source, and the verdicts are revealed in the app, on Telegram or by Web Push. Headlines linked to each claim explain "why we believe this", and the Scoreboard shows Brier scores and a reliability diagram. What remains is the live run after deploying (see docs/spec/06-roadmap.md).

| Check | Result |
| --- | --- |
| Unit tests (scoring, criteria, lifecycle, thresholds, queue, adapters, API) | 32 passing |
| Integration tests against Postgres (append-only, lock time, frozen criteria, race-safe queue, job ledger) | 6 passing |
| Live Open-Meteo contract tests | passing |
| Typecheck, Biome lint, dependency-cruiser layering rules | clean |
| PWA build and Netlify-style function bundling | succeeding |

## Quick start

```bash
pnpm install && cp .env.example .env && pnpm verify
pnpm dev:api   # and in another terminal:
pnpm dev:web   # http://localhost:5173
```

Full setup, including Postgres, Neon and Netlify: [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md).

## Repository map

```text
apps/
  api/          Hono API (/api/v1): health, session, me, brief/preview
  jobs/         Scheduled job logic (tick)
  web/          Vite + React PWA: Today, Reveal, Scoreboard
netlify/
  functions/    Netlify entry points: api.mts (/api/*), tick.mts (hourly)
packages/
  core/         Pure domain (scoring, criteria, lifecycle), ports, use cases
  contracts/    Zod API schemas shared by API and web
  adapters/     Open-Meteo sources, Postgres repositories
  db/           SQL migrations (with integrity triggers), migrate/seed scripts, Drizzle schema
  runtime/      Config, logger, composition root
docs/
  spec/         The full product and engineering spec, in reading order
  adr/          Architecture decision records
  runbooks/     What to do when something breaks
.github/workflows/  CI, nightly source contracts, nightly encrypted backup
```

## Commands

| Command | Does |
| --- | --- |
| `pnpm verify` | Lint, typecheck, architecture rules, unit tests, build |
| `pnpm test` / `pnpm test:watch` | Unit tests |
| `pnpm test:integration` | Database tests (needs `DATABASE_URL`) |
| `pnpm test:contracts` | Live data-source contract tests |
| `pnpm db:up` / `db:migrate` / `db:seed` | Local Postgres, migrations, seed |
| `pnpm dev:api` / `pnpm dev:web` | Local API on :8787, PWA on :5173 |
| `pnpm job <tick\|generate\|brief\|reveal\|news>` | Run a scheduled job by hand |
| `pnpm push:keys` | Generate VAPID keys for Web Push |

## Costs

$0/month on Netlify Free, Neon Free and GitHub Free at single-user scale; see [docs/spec/05-operations.md](docs/spec/05-operations.md).

## Data attribution

Weather and air-quality data by [Open-Meteo.com](https://open-meteo.com/), licensed CC BY 4.0, used under its free non-commercial terms. Exchange rates: European Central Bank via [Frankfurter](https://frankfurter.dev/). Earthquakes: [USGS](https://earthquake.usgs.gov/) (public domain). Space weather: [NOAA SWPC](https://www.swpc.noaa.gov/) (public domain) and Kp history from [GFZ Potsdam](https://kp.gfz.de/) (CC BY 4.0). News coverage: [GDELT](https://www.gdeltproject.org/). Headlines are shown as title, source, time and a short snippet, always linking to the publisher.
