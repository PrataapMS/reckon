# Atlassian Statuspage (public pages)

Verify against a page's own API docs (e.g. https://www.githubstatus.com/api/v2) before changing the adapter (spec §3.1 rule).

| Use | Endpoint | Parameters Reckon relies on | Adapter |
| --- | --- | --- | --- |
| Recent incidents of one status page | `https://{host}/api/v2/incidents.json` | `page.name`, `page.url`; per incident `id`, `name`, `created_at`, `impact` (`none`/`minor`/`major`/`critical`), `shortlink` | `StatusPageAdapter` (`statuspage`) |

| Item | Value |
| --- | --- |
| Auth | None; the v2 page API is public and documented on every Statuspage-hosted page |
| Terms | Public read-only endpoint published by each page owner for embedding and polling; no separate licence stated. Poll gently |
| Limits | No published rate limit. Statuspage returns only "the 50 most recent incidents" (including resolved and postmortem), so 50 entries means `complete: false` |
| Timestamps | ISO 8601 with milliseconds; GitHub's page uses `Z`, the documented example uses `-06:00` offsets, so the adapter normalises to UTC |
| Impact | Any value outside the four known levels is `schema_changed`, so a new level gets noticed instead of guessed |
| Links | `shortlink` (e.g. `https://stspg.io/…`) when present, else `{page.url}/incidents/{id}` |
| Validation | `host` must be a DNS name with at least one dot, no port, path or userinfo, not an IPv4 literal or `localhost`; anything else is `not_found` without a request |
| Verified pages | `www.githubstatus.com` (GitHub), `www.netlifystatus.com` (Netlify), `status.npmjs.org` (npm): 50 incidents each, all four impact levels seen, no null shortlinks |
| Fixtures | `packages/adapters/test/fixtures/statuspage-incidents.json` (www.githubstatus.com, recorded 2026-10-05, trimmed to 4 incidents, updates and components removed) |
| Contract test | `packages/adapters/test/tech-sources.contract.test.ts` (run with `pnpm test:contracts`) |

Last verified: 2026-10-05 (live contract test passing for www.githubstatus.com).
