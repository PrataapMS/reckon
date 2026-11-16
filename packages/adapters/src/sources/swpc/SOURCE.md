# NOAA Space Weather Prediction Center (SWPC)

Verify against https://www.swpc.noaa.gov/content/data-access and https://www.swpc.noaa.gov/products/3-day-geomagnetic-forecast before changing the adapter (spec §3.1 rule).

| Use | Endpoint | Parameters Reckon relies on | Adapter |
| --- | --- | --- | --- |
| Observed planetary Kp, last 7 days | `https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json` | array of `{ time_tag, Kp, a_running, station_count }`; `time_tag` is UTC with no zone suffix | `SwpcSpaceWeatherAdapter.observedKp` (`swpc.kp`) |
| 3-day geomagnetic forecast | `https://services.swpc.noaa.gov/text/3-day-geomag-forecast.txt` (text/plain) | `:Issued:` line, `NOAA Geomagnetic Activity Probabilities` block (Active, Minor storm, Moderate storm, Strong-Extreme storm as `dd/dd/dd` percent), `NOAA Kp index forecast` 3-hourly table | `SwpcSpaceWeatherAdapter.geomagForecast` (`swpc.geomag_forecast`) |

| Item | Value |
| --- | --- |
| Auth | None |
| Terms | US Government work, public domain (NWS/NOAA disclaimer). Do not imply NOAA endorsement, and do not present modified data as official. Credit "NOAA SWPC" is good practice |
| Limits | No published rate limit. Files are cached 60 s and regenerated as products update. The forecast is issued daily (around 22:00 UTC) |
| Fixtures | `packages/adapters/test/fixtures/swpc-kp.json` (recorded 2026-10-05, trimmed to 8 slots), `swpc-geomag-forecast.txt` (recorded 2026-10-05, complete) |
| Contract test | `packages/adapters/test/world-sources.contract.test.ts` (run with `pnpm test:contracts`) |

Quirks confirmed live on 2026-10-05:

- The Kp JSON now uses an array of objects with numeric `Kp` (about 61 slots including the current partial day). The older format, a header row followed by string rows with `'2026-09-28 00:00:00.000'` tags, is still accepted in case it returns.
- The forecast text gives dates without a year (`Oct 05`). The year comes from the `:Issued:` line, choosing the year nearest the issue time, which handles the Dec→Jan rollover. Each Kp column is resolved separately, so a table spanning a month or year boundary works.
- In storm slots the Kp table appends a NOAA scale tag, e.g. `5.33 (G1)`. The tag is stripped. This was seen in the sibling `3-day-forecast.txt`.
- The four probabilities are separate categories, not cumulative. A missing row is `schema_changed`; a missing Kp table gives `kpMax: null`.
- NCEI keeps the long-term archive of past forecasts (`ftp.swpc.noaa.gov/pub/forecasts/geomag_forecast/` has the last 75 days).

Last verified: 2026-10-05 (live contract tests passing).
