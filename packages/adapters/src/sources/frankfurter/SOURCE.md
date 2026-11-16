# Frankfurter (ECB reference rates)

Verify against https://frankfurter.dev (v1 docs: https://frankfurter.dev/v1/) before changing the adapter (spec §3.1 rule).

| Use | Endpoint | Parameters Reckon relies on | Adapter |
| --- | --- | --- | --- |
| Daily FX series (e.g. USD/INR) | `https://api.frankfurter.dev/v1/{start}..{end}` | `base`, `symbols` (one quote); response `rates: { 'YYYY-MM-DD': { <QUOTE>: number } }` | `FrankfurterAdapter` (`frankfurter`) |

| Item | Value |
| --- | --- |
| Auth | None |
| Terms | Free, including commercial use; the rates themselves fall under the provider's (ECB's) terms. No personal data or request logs kept |
| Limits | No quotas; abuse rate limiting only. Responses are edge-cached (`cache-control: max-age=86400`) |
| Fixtures | `packages/adapters/test/fixtures/frankfurter-range.json` (recorded 2026-10-05) |
| Contract test | `packages/adapters/test/world-sources.contract.test.ts` (run with `pnpm test:contracts`) |

Quirks confirmed live on 2026-10-05:

- **v1 is deprecated** (`deprecation` header dated 2026-05-18, `link: </v2/rates>; rel="successor-version"`). The FAQ says v1 "remains available indefinitely". Reckon stays on v1 on purpose: v2 blends rates from many central banks by default, while v1 is ECB-only. A v2 move would use `/v2/providers/ecb/rates?from=&to=&base=&quotes=`.
- ECB holidays and weekends are absent from `rates`.
- A range that starts on a non-working day is widened back to the previous ECB day (a Sat..Sun request returns Friday). The adapter drops dates outside `[start, end]`.
- An unknown currency returns HTTP 404 `{"message":"not found"}` (mapped to `not_found`).
- Rates are published around 16:00 CET on ECB working days.

Last verified: 2026-10-05 (live contract test passing).
