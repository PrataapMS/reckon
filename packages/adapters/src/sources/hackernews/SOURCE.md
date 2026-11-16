# Hacker News (Algolia HN Search API)

Verify against https://hn.algolia.com/api before changing the adapter (spec §3.1 rule). The official API (https://github.com/HackerNews/API) would need the `topstories` id list plus one request per item; Algolia returns the front page in one call.

| Use | Endpoint | Parameters Reckon relies on | Adapter |
| --- | --- | --- | --- |
| Current front page | `https://hn.algolia.com/api/v1/search` | `tags=front_page`, `hitsPerPage=30`; per hit `objectID`, `title`, `url` (absent for text posts such as Ask HN), `created_at` | `HackerNewsAdapter` (`hackernews`) |

| Item | Value |
| --- | --- |
| Auth | None |
| Terms | Algolia's HN Search API page states no licence beyond its rate limit. The official HN API repository is MIT-licensed; HN content belongs to its authors, and Reckon stores only titles and links |
| Limits | 10,000 requests per hour per IP (stated on https://hn.algolia.com/api; that page needs JavaScript, so the text was confirmed from its bundle). The official Firebase API states no rate limit |
| Mapping | `source` is the article's hostname without `www.`; text posts and non-http(s) links become `https://news.ycombinator.com/item?id=<objectID>` with source `Hacker News`. Hits without a title are skipped. `snippet` and `lang` are null |
| Size | The front page tag held 29 stories on 2026-10-05, so expect up to 30 rather than exactly 30 |
| Fixtures | `packages/adapters/test/fixtures/hackernews-front.json` (recorded 2026-10-05, trimmed to 3 front-page hits plus a real Ask HN hit from `tags=ask_hn`, `_highlightResult`/`children`/`story_text` removed) |
| Contract test | `packages/adapters/test/tech-sources.contract.test.ts` (run with `pnpm test:contracts`) |

Last verified: 2026-10-05 (live contract test passing).
