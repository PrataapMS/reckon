# A data source changed its format

**Symptom:** the nightly `Source contracts` workflow failed and opened an issue, or `/api/v1/health` shows a source failing.

1. Open the failed run and read the `SourceError` code in the assertion message.
   - `schema_changed`: the payload shape moved. `rate_limited` / `upstream_5xx` / `timeout`: usually transient; re-run the workflow once.
2. Fetch the endpoint yourself with the URL from the adapter's `url()` method and compare it with the recorded fixture in `packages/adapters/test/fixtures/`.
3. Read the provider's changelog or docs; update `SOURCE.md` in the adapter folder.
4. Update the Zod schema and mapping in the adapter. Re-record the fixture (`curl … -o fixtures/<name>.json`).
5. Run `pnpm test` and `pnpm test:contracts`; merge.
6. Questions that could not resolve meanwhile retry automatically (1–48 h backoff). Those past `retryUntilHours` are annulled with the error code, which is correct: never back-fill a guess.
