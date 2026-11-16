# 5. Security, privacy, operations and cost

Reckon runs for $0/month on free tiers at single-user scale, keeps data minimal and exportable, and tells the operator about failures before the user notices.

## Security

- Secrets (database URL, session secret, passphrase hash, Telegram token, VAPID keys, optional GitHub and LLM keys) live in Netlify environment variables and GitHub Actions secrets; never committed. See `.env.example`. `pnpm push:keys` prints a VAPID pair; rotating it unsubscribes every browser.
- Append-only tables are protected by triggers and by the `reckon_app` role's grants.
- Security headers (CSP, HSTS, `nosniff`, referrer policy) are set in `netlify.toml`.
- Session cookies are HTTP-only, signed and `SameSite=Lax`; login is limited to 5 attempts per 15 minutes.
- Enable Dependabot on the GitHub repo; CI should fail on known critical vulnerabilities.

## Privacy

- Store only what is needed: locations, settings, questions, forecasts, evidence, outcomes.
- Coordinates are rounded to 2 decimals (~1 km), finer than the weather grid anyway (built in `place.ts`).
- Integrations use read-only scopes; tokens are encrypted at rest with an environment key.
- Personal questions never store details about other people beyond the event title already in the user's calendar.
- Full export and delete from Settings (Phase 3).

## Operations

- **Logs:** structured JSON with request or job context (built: `jsonLogger`).
- **Job ledger:** every job writes a `job_runs` row with timing and counts (built for `tick`).
- **Health:** `/api/v1/health` shows database status, queue depth and the last run of each job (built).
- **Alerting (Phase 1):** one Telegram alert if a job misses 2 runs or a source fails for 24 h.
- **Backups:** Neon's free tier keeps a 6-hour restore window, so `.github/workflows/backup.yml` also stores an `age`-encrypted `pg_dump` as a 30-day artifact.
- **Runbooks:** `docs/runbooks/`.

## Cost (single user)

| Service | Plan | Monthly cost | Covers |
| --- | --- | --- | --- |
| Netlify | Free (300 credits, hard cap) | $0 | PWA, API function, scheduled jobs, Blobs |
| Neon | Free (100 CU-hours, 0.5 GB per project) | $0 | Postgres |
| GitHub | Free | $0 | Repo, CI, backups, contract tests, model fitting |
| Open-Meteo and other sources | Free / non-commercial | $0 | Data |
| Telegram | Free | $0 | Notifications |
| LLM (Phase 4) | Pay as you go, small model | Estimated under $1 | 5–10 bounded calls per day |

**Netlify credit budget:** production deploy 15 credits; 20 per GB bandwidth; 2 per 10,000 requests; 10 per GB-hour compute.

| Item | Monthly estimate | Credits |
| --- | --- | --- |
| Scheduled jobs (~50 runs/day, ~5 s at 1 GB) | ≈ 2 GB-hours | ≈ 20 |
| API calls | ≈ 10,000 | ≈ 2 |
| Bandwidth (PWA mostly cached) | ≈ 0.5 GB | ≈ 10 |
| Production deploys | 8 | 120 |
| **Total** | | **≈ 150 of 300** |

If credits run out, Netlify pauses the site (including scheduled jobs) until next month. Resolvers backfill, so nothing is lost. Upgrade paths: Netlify Personal $9/month (1,000 credits) or the API and jobs on Cloudflare Workers Paid at $5/month.

**Neon compute:** jobs wake the database about twice an hour for ~10 minutes in total (compute suspends after 5 idle minutes), roughly 30 CU-hours/month at 0.25 CU, inside the 100 CU-hour allowance. Keep the minimum compute at 0.25 CU.

## Sources for limits and pricing (checked October 2026)

- [Netlify Functions configuration](https://docs.netlify.com/build/functions/configuration) · [Scheduled Functions](https://docs.netlify.com/build/functions/scheduled-functions/) · [Netlify Database billing](https://docs.netlify.com/build/data-and-storage/netlify-database/billing-and-usage/) · [Netlify credit costs (summary)](https://supadrop.host/blog/netlify-pricing-free-tier-limits/)
- [Neon pricing](https://neon.com/pricing) · [Neon free plan limits](https://neon.com/faqs/free-plan-limits-and-quotas)
- [Cloudflare Workers limits](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/workers/platform/limits.mdx)
- [Open-Meteo](https://github.com/open-meteo/open-meteo)
