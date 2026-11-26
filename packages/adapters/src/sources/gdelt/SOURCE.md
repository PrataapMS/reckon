# GDELT DOC 2.0

Verify these against https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/ before changing the adapter (spec §3.1 rule).

| Use | Endpoint | Parameters Reckon relies on | Adapter |
| --- | --- | --- | --- |
| Daily news volume (`NewsVolumePort`) | `https://api.gdeltproject.org/api/v2/doc/doc` | `mode=timelinevolraw`, `format=json`, `startdatetime=YYYYMMDD000000`, `enddatetime=YYYYMMDD235959`, `query`; reads `timeline[0].data[].{date,value}` | `GdeltAdapter.dailyVolume` |
| Recent articles (`NewsSearchPort`) | same | `mode=artlist`, `format=json`, `maxrecords` ≤ 250 (default 75), `timespan=<n>h`, `sort=datedesc`, `query`; reads `articles[].{url,title,seendate,domain,language}` | `GdeltAdapter.articles` |

Behaviour the adapter depends on:

- Timeline resolution depends on the span: 15-minute buckets under 72 hours, hourly up to a week, daily beyond. The adapter sums `value` per UTC date (first 8 characters of `date`, e.g. `20261005T000000Z`) and returns one point per date from start to end, filling dates with no bucket as 0. An empty or missing timeline means "no data" and returns no points, not zeros. `norm` (all articles monitored in the bucket) is ignored.
- Only the last ~3 months are searchable; `startdatetime`/`enddatetime` must fall inside that window.
- No matches: `artlist` may answer `{}` or an empty body; both are zero articles.
- Bad queries (e.g. "The specified phrase is too short", "Your search contained…") come back as HTTP 200 with a plain-text body. Any non-JSON body is `schema_changed`, with the message as `detail`.
- `seendate` is `YYYYMMDDTHHMMSSZ` (UTC) and becomes ISO 8601; `language` is a language name such as `English` and is passed through as `lang`. `snippet` is always null (the list has none).

| Item | Value |
| --- | --- |
| Auth | None |
| Terms | https://www.gdeltproject.org/about.html#termsofuse: datasets are "available for unlimited and unrestricted use for any academic, commercial, or governmental use of any kind without fee"; any use or redistribution must cite the GDELT Project and link to https://www.gdeltproject.org/ (show this next to GDELT-derived numbers) |
| Limits | At most one request every 5 seconds; over that, HTTP 429 with a plain-text "Please limit requests to one every 5 seconds…" (mapped to `rate_limited`). Each `GdeltAdapter` instance keeps its own next-request time and sleeps out the rest of the gap (`minIntervalMs`, default 5000; `sleep` injectable for tests). Use one instance per process. `httpGet` still retries a 5xx once after < 1 s, which is inside the gap |
| Fixtures | `packages/adapters/test/fixtures/gdelt-timeline.json`, `gdelt-artlist.json`. **SYNTHETIC**: hand-written from the documented format because the API answered 429 (and later timed out at 8 s) from the development sandbox on 2026-10-05. Article URLs and domains are placeholders. Re-record both from a real response and replace these files |
| Contract test | `packages/adapters/test/news-sources.contract.test.ts` (run with `pnpm test:contracts`). Retries `rate_limited`, `timeout`, `network` and `upstream_5xx` with backoff, then skips with the reason, so only a contract change fails the nightly run. Still 429 from a home network on 2026-11-26 |

Last verified: 2026-10-05 (docs only: the field names `timeline`, `series`, `data`, `date`, `value`, `norm`, `articles`, `url`, `url_mobile`, `title`, `seendate`, `socialimage`, `domain`, `language`, `sourcecountry` are not shown on the doc page and still need confirming against a live response; the live contract test failed from the sandbox with `rate_limited` / `timeout`).
