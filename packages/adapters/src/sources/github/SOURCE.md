# GitHub releases

Verify these against https://docs.github.com/en/rest/releases/releases and https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api before changing the adapter (spec §3.1 rule).

| Use | Endpoint | Parameters Reckon relies on | Adapter |
| --- | --- | --- | --- |
| Releases of one repository | `https://api.github.com/repos/{owner}/{repo}/releases` | `per_page=100` (the maximum); fields `tag_name`, `name`, `draft`, `prerelease`, `published_at` (null for drafts), `html_url` | `GitHubReleasesAdapter` (`github.releases`) |

| Item | Value |
| --- | --- |
| Headers | `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`; `Authorization: Bearer <token>` only when a token is configured |
| Auth | None needed for public repositories. A token (no scopes) raises the limit |
| Terms | GitHub Terms of Service §H "API Terms": no excessive or abusive request rates, no sharing tokens to exceed rate limits, no harvesting for spam. Release metadata is public |
| Limits | Primary: 60 requests/hour per IP unauthenticated, 5,000/hour with a personal token. Exceeding it gives 403 or 429 with `x-ratelimit-remaining: 0` (reset in `x-ratelimit-reset`); secondary limits give 403/429, often with `retry-after`. Both map to `rate_limited` |
| Ordering | The list is not in publish order (nodejs/node, 2026-10-05), so the adapter sorts by `published_at` descending |
| Completeness | Only the first page is fetched; 100 entries means older releases may be missing (`complete: false`). nodejs/node and facebook/react both return a full page |
| Redirects | Renamed or moved repositories answer 301 to `/repositories/{id}/releases`; fetch follows it. `facebook/react` now redirects and its `html_url`s point at `github.com/react/react` |
| Drafts | Only visible to tokens with push access; excluded, as are entries with null `published_at` |
| Validation | `repo` must be `owner/name` (owner `[A-Za-z0-9-]` ≤ 39, name `[A-Za-z0-9._-]` ≤ 100, not `.`/`..`); anything else is `not_found` without a request |
| Fixtures | `packages/adapters/test/fixtures/github-releases.json` (facebook/react, recorded 2026-10-05, trimmed to 4 releases incl. prerelease `v16.9.0-rc.0`; the draft `v19.4.0` was added by hand) |
| Contract test | `packages/adapters/test/tech-sources.contract.test.ts` (run with `pnpm test:contracts`; set `GITHUB_TOKEN` to avoid the shared 60/h budget) |

Last verified: 2026-10-05 (live contract tests passing for nodejs/node and facebook/react).
