# ADR-0003: Netlify + Neon + GitHub Actions on free tiers

**Status:** Accepted, 2026-10-05

## Context
The app must cost close to nothing, deploy without friction, store data, and run scheduled work. Checked in October 2026: Netlify Free gives 300 credits a month as a hard cap (production deploy 15, 20 per GB bandwidth, 2 per 10,000 requests, 10 per GB-hour compute); scheduled functions have a 30-second limit. Neon Free gives 100 CU-hours and 0.5 GB per project, with compute suspending after 5 idle minutes. Netlify's built-in database is Neon underneath, but its free-plan availability was documented inconsistently, and it bills compute against Netlify credits.

## Decision
- Netlify Free hosts the PWA, one `/api/*` function and the scheduled functions.
- A separate Neon Free project (AWS us-east-2, next to Netlify's default function region) holds Postgres, so database compute never consumes Netlify credits.
- GitHub Actions runs CI, backups, nightly source-contract tests and (Phase 4) model fitting.
- All scheduled work is chunked through a Postgres work queue and resolvers can backfill, so a missed run or a credit pause delays work but never corrupts it.

## Consequences
- $0/month expected; ≈150 of 300 Netlify credits used, mostly by production deploys, so work happens on `dev` and merges to `main` weekly.
- Fallbacks: Netlify Personal ($9/month) or moving the Hono API and jobs to Cloudflare Workers Paid ($5/month) with no code changes to core.
