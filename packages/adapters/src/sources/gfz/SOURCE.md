# GFZ Potsdam Kp index

Verify against https://kp.gfz.de/en/data before changing the adapter (spec §3.1 rule).

| Use | Endpoint | Parameters Reckon relies on | Adapter |
| --- | --- | --- | --- |
| Long Kp history (base rates) | `https://kp.gfz.de/app/json/` | `start`, `end` as `YYYY-MM-DDTHH:MM:SSZ` (both inclusive, matched on slot start), `index=Kp`; response has parallel arrays `Kp` and `datetime` | `GfzKpAdapter` (`gfz.kp`) |

| Item | Value |
| --- | --- |
| Auth | None |
| Terms | **CC BY 4.0.** GFZ asks users to "refer to GFZ German Research Centre for Geosciences as data source". The UI must show the credit wherever Kp history is used (`GFZ_KP_ATTRIBUTION`). Scientific citation: Matzka et al. (2021), doi:10.1029/2020SW002641 |
| Limits | No published rate limit. 1990–2025 (105 192 slots) is a 3.6 MB response in about 2.5 s, inside the 8 s timeout; split longer ranges |
| Fixtures | `packages/adapters/test/fixtures/gfz-kp.json` (recorded 2026-10-05, one day) |
| Contract test | `packages/adapters/test/world-sources.contract.test.ts` (run with `pnpm test:contracts`) |

Quirks confirmed live on 2026-10-05:

- Timestamps must be exactly `YYYY-MM-DDTHH:MM:SSZ`. Bare dates or milliseconds (`.000Z`) give **HTTP 500**, so the adapter reformats `start`/`end` itself.
- The response also has `status` (`def` = definitive, `pre` = nowcast/preliminary) and `meta: {"license":"CC BY 4.0","source":"GFZ Potsdam"}`. Recent months are `pre` and may be revised. Adding `status=def` to the query returns definitive values only. `KpPoint` does not carry the status, so prefer windows that end at least a month ago for base rates.
- Kp values are thirds (0.333, 0.667, …) on 0..9. Values off that scale are treated as missing, but none were seen in 1990–2025.
- A reversed window returns 200 with empty arrays.

Last verified: 2026-10-05 (live contract test passing).
