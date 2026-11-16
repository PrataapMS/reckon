# 3. Forecasting engine

## 3.1 Data sources and adapters

Reckon v1 uses only free, keyless (or free-key) open-data and open-source APIs. Each sits behind an adapter with recorded-fixture tests and a nightly live contract test.

**Rule for implementers:** before writing an adapter, open the provider's current documentation and confirm endpoint, parameters, rate limit and licence. Record them in `packages/adapters/src/sources/<source>/SOURCE.md` (see the Open-Meteo one). Every adapter sets a `User-Agent` naming Reckon and a contact address, times out at 8 s, retries once on 5xx with jitter, and returns `SourceError` values (`timeout`, `rate_limited`, `schema_changed`, `not_found`, `upstream_5xx`, `network`) instead of throwing.

| Source | Domain | Used for | Auth | Licence / terms | Phase |
| --- | --- | --- | --- | --- | --- |
| Open-Meteo Forecast API | Weather | Daily precipitation probability, rain sum, max temperature; `past_days` to resolve recent days | None | Open source; free non-commercial; CC BY 4.0 attribution in UI | 0–1 (built) |
| Open-Meteo Ensemble API | Weather | Share of ensemble members above a threshold | None | As above | 1 |
| Open-Meteo Historical (ERA5) | Weather | Climatology baseline (10+ years); audit cross-check | None | As above | 1 |
| Open-Meteo Air Quality API | Air | US AQI and PM2.5 (CAMS model) | None | As above | 0–1 (built) |
| Frankfurter | Money | Daily ECB reference rates (USD/INR) | None | Open source; ECB data | 2 (built) |
| USGS Earthquake API | World | Count of quakes ≥ M in a window | None | US public domain | 2 (built) |
| NOAA SWPC JSON and text | Space | Estimated planetary Kp (resolution); 3-day geomagnetic forecast (`provider.swpc@1`) | None | US public domain | 2 (built) |
| GFZ Potsdam Kp | Space | Long Kp history for base rates | None | CC BY 4.0, attribution | 2 (built) |
| GitHub REST API | Tech | Releases of watched repos | Optional token | GitHub API terms | 2 (built) |
| Public status pages (Statuspage JSON) | Tech | Incidents for watched services (latest 50 only) | None | Public | 2 (built) |
| GDELT DOC 2.0 | News | Article lists, volume timelines, news-surge questions | None | Open data, attribution | 2 (built; fixtures synthetic) |
| Curated RSS/Atom feeds | News | Headlines for evidence panels (defaults in ADR-0009) | None | Publisher terms; headline, link, short snippet only | 2 (built) |
| Hacker News (Algolia search API) | Tech | Front page, evidence | None | Public | 2 (built) |
| Wikimedia Pageviews | Attention | Interest-surge questions | None | Open data | 4 |
| Manifold Markets API | Events | Crowd baseline, candidate questions | None to read | Open source | 4 |
| Todoist API | Personal | Task completion timestamps | Token, opt-in | Todoist terms | 5 |
| Google Calendar API | Personal | Whether a planned event was kept | OAuth, opt-in | Google terms | 5 |

India station data (CPCB via data.gov.in, free key) is a Phase 5 option. Stock-index questions such as NIFTY are excluded until a free, stable, terms-compliant source is confirmed; FX questions act as the "efficient market" control group meanwhile.

**Resolution sources are honest about what they measure.** Open-Meteo past-day values and ERA5 are model estimates on a grid, not a rain gauge at your door. That is acceptable because criteria name the dataset explicitly, and the UI's "How this is judged" panel says so. ERA5 disagreements are logged as a data-quality metric; the original resolution stands.

**Request budget (one user, two locations):** weather and AQI ≈ 12 calls/day; resolutions ≈ 8; climatology cached monthly; news ≈ 60 (hourly, ETag-cached); FX, quakes, Kp, GitHub, status ≈ 20. Far below every provider's free limits.

## 3.2 Question engine

Questions are generated from templates each morning with automatically chosen thresholds, so each is either useful for a decision or informative for calibration. The user never has to type a question.

```ts
interface QuestionTemplate {
  id: string; version: number; domain: Domain;
  class: 'decision' | 'informative';
  horizons: number[];                    // days ahead, e.g. [1, 3, 7]
  appliesTo(ctx: GenerationCtx): boolean;
  candidates(ctx: GenerationCtx): CandidateQuestion[];   // pure; no I/O beyond ctx
  thresholdSelector?: ThresholdSelector;
  resolver: ResolverId;
  forecasters: ForecasterId[];
  dailyBudget: number;
}
```

- **Decision questions** have fixed, human-meaningful thresholds ("rain ≥ 1 mm today" drives the umbrella tip) and are generated even when usually obvious.
- **Informative questions** have thresholds chosen so the historical base rate is near 50%, where each outcome carries the most information.

**Threshold selection** (implemented in `packages/core/src/domain/threshold.ts`):

1. Take the metric's ladder (rain 0.2, 1, 2.5, 5, 10, 20, 50 mm; US AQI 50, 100, 150, 200, 300; whole degrees).
2. For each value, compute the climatological base rate within ±7 calendar days of the date over 10+ years at that location.
3. Keep values with base rate in [0.25, 0.75]; pick the closest to 0.5, ties to the more decision-relevant value.
4. If none qualify, skip the template that day.

**World questions** (Phase 2) are asked once per user, not per place: their windows, ladders and evidence rules are in ADR-0009 and `packages/core/src/domain/world-templates.ts`.

**Volume:** 8–14 auto questions per day for two locations (Phase 1 identity includes the horizon and questions lock at the brief time; see ADR-0008), so 100 resolved in about 10 days. **Horizons:** 1, 3 and 7 days to show skill decay. **Correlation groups:** same date and region share a `correlation_group`, scored as one cluster. **Idempotency:** identity is `(template, criteria_hash)`.

| Template | Example | Class | Horizons | Resolves via | Phase |
| --- | --- | --- | --- | --- | --- |
| `wx.rain_any` | Rain ≥ 1 mm at Home tomorrow? | Decision | 1, 3 | Open-Meteo past_days | 1 |
| `wx.rain_adaptive` | Rain ≥ 5 mm at Home on Thursday? | Informative | 1, 3, 7 | Open-Meteo past_days | 1 |
| `wx.tmax_adaptive` | Max ≥ 31 °C at Work tomorrow? | Informative | 1, 3, 7 | Open-Meteo past_days | 1 |
| `air.aqi_decision` | US AQI max > 150 at Home tomorrow? | Decision | 1 | Open-Meteo Air Quality | 1 |
| `air.aqi_adaptive` | US AQI max > 100 at Home on Saturday? | Informative | 1, 3 | Open-Meteo Air Quality | 1 |
| `fx.usdinr_week` | USD/INR higher Friday than Monday? | Informative (control) | 4 | Frankfurter | 2 (built) |
| `world.quake_m6_week` | At least one M6.5+ quake worldwide this week? (magnitude by base rate) | Informative | 6 | USGS | 2 (built) |
| `space.kp_storm_3d` | Kp reaches 5 in the next 3 days? (level by base rate) | Informative | 3 | NOAA SWPC | 2 (built) |
| `tech.release_week` | Watched repo publishes a stable release this week? | Informative | 6 | GitHub | 2 (built) |
| `tech.incident_week` | GitHub reports a critical incident this week? (severity by base rate) | Informative | 6 | Status page | 2 (built) |
| `news.topic_surge` | Coverage of a tracked topic > k× its 30-day median tomorrow? (k by base rate) | Informative | 1 | GDELT | 2 (built) |
| `crowd.event` | Mirrors a curated Manifold question | Informative | varies | Market resolution (low trust) | 4 |
| `life.task_deadline` | Task X completed by its due date? | Decision | to due date | Todoist | 5 |
| `life.plan_kept` | Calendar event goes ahead as planned? | Decision | to event | Google Calendar | 5 |

Manual questions (escape hatch) use a guided form offering only machine-resolvable criteria, or "manual resolution", which counts against the 3-per-week prompt budget and is scored in the Personal bucket.

## 3.3 Forecasters

Every probability comes from a named, versioned forecaster; the one the user sees for a template is its current **champion**. All probabilities are clipped to [0.01, 0.99].

| ID | Kind | How it produces p | Phase |
| --- | --- | --- | --- |
| `provider.openmeteo@1` | Provider | Rain-any: the provider's daily precipitation probability. Other thresholds: a bounded logistic on distance to threshold, clipped to [0.2, 0.8] until a fitted mapping exists (see ADR-0007; built as `provisionalProbability`). | 0–1 |
| `ensemble.openmeteo@1` | Ensemble | Share of members meeting the condition, shrunk with (k + 1) / (n + 2). | 1 |
| `climatology@1` | Baseline | Historical base rate from the threshold selector; the reference for every skill score. | 1 |
| `persistence@1` | Baseline | p = 0.7 if the condition held today, else 0.3 (tuned later). | 1 |
| `history.rate@1` | Baseline | Rolling base rate over the last 52 comparable windows (events, counts, FX); at least 8. The reference for world questions. | 2 (built) |
| `provider.swpc@1` | Provider | NOAA SWPC's daily geomagnetic storm probabilities, combined over the question's window (ADR-0009). | 2 (built) |
| `crowd.manifold@1` | Crowd | Market probability at lock time. | 4 |
| `blend@N` | Model | Logistic regression stacking forecasters' logits plus horizon and season; fitted weekly in GitHub Actions. | 4 |
| `llm.evidence@N` | LLM | Reads a bounded evidence pack; returns JSON `{p, rationale}`; fixed prompt version, temperature 0. | 4 |
| `user` | Human | The user's optional "Call it" picks. | 3 |

**Champion selection** (nightly, per template and horizon): consider forecasters with ≥ 30 scored clusters; rank by 90-day mean Brier; a challenger replaces the champion only if better by ≥ 0.005 **and** its paired 90% bootstrap interval excludes zero. Defaults before anyone qualifies: ensemble (weather), provider (air), history.rate (events).

**LLM guardrails:** outputs only a probability and rationale; never creates criteria or resolves; bounded evidence pack (< 4,000 tokens); Zod-validated output (malformed = no forecast); each prompt version is a new forecaster ID; at most once per question, only where news plausibly matters.

## 3.4 Resolution, verification and jobs

Each resolver asks: "what did the declared source report for the declared window?" It never asks "what is the value now?", so it can run late, twice, or after an outage and produce the same answer.

```ts
interface Resolver {
  id: string; version: string;            // 'openmeteo.daily@1'
  earliestRunAfter(q: Question): Date;    // window_end + source publication delay
  observe(c: Criteria, ctx: ResolveCtx): Promise<Result<Observation, SourceError>>;
}
// The outcome is computed by the pure evaluate(criteria, observation), not by the resolver.
```

1. `tick` finds `locked` questions past `earliestRunAfter`, moves them to `resolving`, enqueues one `resolve` item each (deduplicated by question ID).
2. The worker calls `observe`; the raw response goes to Blobs; its SHA-256 and metadata become an `evidence` row.
3. `evaluate(criteria, observation)` returns 0 or 1.
4. In one transaction: insert the resolution, set `resolved`, add a `reveal` outbox entry.
5. On `SourceError`, retry at 1, 3, 6, 12, 24, 48 h (built: `BACKOFF_HOURS`); after `retryUntilHours`, annul with the last error code.

**Auditability:** every resolved question shows the frozen criteria in plain language plus hash; the observed value, source and fetch time; a raw-response download and the exact request URL; every forecaster's p, timestamp and score; and the ERA5 audit status.

| Job | Schedule (UTC) | Does | Budget | Status |
| --- | --- | --- | --- | --- |
| `tick` | hourly at :05 | Lock due questions, enqueue resolves, drain queue ≤ 16 s, repeat the generate/brief/reveal checks, send outbox | 25 s | Built |
| `generate` | 23:15 (≈ 04:45 IST) | Enqueue per-location generation and forecasts | 25 s | Built |
| `brief` | 00:45 (≈ 06:15 IST) | Build the Morning Brief into the outbox | 25 s | Built |
| `reveal` | 15:15 (≈ 20:45 IST) | Build the Reveal | 25 s | Built |
| `news` | hourly at :35 | Fetch feeds, Hacker News and the 2 stalest GDELT searches; tag, link, retain | 25 s | Built |
| `weekly` | Sunday 13:00 | Weekly report; recompute champions | 25 s | Phase 3 |
| GHA `backup` | daily 20:30 | Encrypted `pg_dump` artifact (30 days) | minutes | Built |
| GHA `contracts` | daily 02:00 | Live source contract tests; opens an issue on failure | minutes | Built |
| GHA `fit` | Sunday 12:00 | Fit blend model; write coefficients | minutes | Phase 4 |

The brief and reveal jobs read each user's timezone and preferred times, so changing them needs no redeploy. The work-queue claim is a single `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)` statement (built in `PgWorkQueue.claim`, race-tested in integration tests).

## 3.5 Scoring and analytics

Reckon uses proper scoring rules, compares every forecaster with climatology on the same questions, and refuses to claim skill until the confidence interval says so. All of this is built and unit-tested in `packages/core/src/domain/scoring.ts`.

- **Brier** = (p − o)²; **log score** = −[o ln p + (1 − o) ln(1 − p)] with p clipped. Lower is better.
- **BSS** = 1 − mean Brier(forecaster) / mean Brier(climatology), on the same questions.
- **"Proven"** requires a cluster bootstrap (resample correlation groups 2,000 times): Learning if < 30 clusters; Proven skill if the 95% CI is above 0; No proven edge if it spans 0; Worse than baseline if below 0. These labels appear on every probability.
- **Calibration:** reliability diagram with 5 bins until 500 resolved forecasts, then 10; Wilson 95% intervals; Murphy decomposition; ECE as the single calibration number.
- **Breakdowns:** by forecaster, template, domain, horizon, location and month; SQL views over `scores`, cached as JSON in Blobs.

**Honest expectations:** 100 resolved questions detect gross miscalibration and give a rough Brier; fine calibration needs roughly 300–500 per domain. The FX control should hover near BSS 0; "proven skill" there means a bug or a fluke. Beating the provider at weather is hard; "use the provider, it's well calibrated here" is a successful finding.

## 3.6 News and evidence pipeline (Phase 2)

News is evidence, never a resolution source (except GDELT volume for news-surge questions).

1. **Fetch** RSS/Atom, GDELT DOC (article list mode for tracked topics), Hacker News top stories, with ETag/Last-Modified.
2. **Normalize** to `NewsItem { url, canonicalUrl, title, source, publishedAt, snippet (≤ 280 chars), lang }`.
3. **Deduplicate** by canonical URL and title SimHash (Hamming ≤ 3 within 48 h).
4. **Tag** with deterministic keyword and entity rules (Phase 2); optional LLM tagging for unmatched items (Phase 4).
5. **Link** to matching open questions via `question_evidence` with a relevance score.
6. **Retain** 90 days unless linked, then permanently as evidence.

Default topics: the user's city, India economy, AI, a few major tech companies; one-tap suggestions afterwards. *(Built: `packages/core/src/domain/news.ts` and `app/news.ts`. Headlines are staged in `news_items` and copied into the append-only `evidence` ledger when first linked; ADR-0009.)* Store and show only headline, source, timestamp, link and a short snippet; always link to the publisher; drop feeds that forbid reuse.
