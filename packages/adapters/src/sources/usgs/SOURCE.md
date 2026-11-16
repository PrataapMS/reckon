# USGS earthquake catalogue (FDSN event service)

Verify against https://earthquake.usgs.gov/fdsnws/event/1/ before changing the adapter (spec §3.1 rule).

| Use | Endpoint | Parameters Reckon relies on | Adapter |
| --- | --- | --- | --- |
| Events at or above a magnitude | `https://earthquake.usgs.gov/fdsnws/event/1/query` | `format=geojson`, `starttime`, `endtime` (ISO 8601, UTC assumed without a zone), `minmagnitude`, `orderby=time-asc`; feature `id`, `properties.mag/time/place/url/type` | `UsgsEarthquakeAdapter` (`usgs.earthquake`) |

| Item | Value |
| --- | --- |
| Auth | None |
| Terms | USGS-authored data is US public domain; credit "U.S. Geological Survey" is requested. (The usgs.gov copyright page returned a bot challenge from the sandbox, so this is from USGS's standing policy, not re-read on 2026-10-05.) |
| Limits | At most 20 000 events per query; more is HTTP 400 (mapped to `schema_changed`). Use `/count` first if a window could be that large. Responses cached 60 s |
| Fixtures | `packages/adapters/test/fixtures/usgs-events.json` (recorded 2026-10-05, trimmed to 3 events) |
| Contract test | `packages/adapters/test/world-sources.contract.test.ts` (run with `pnpm test:contracts`) |

Quirks confirmed on 2026-10-05:

- `endtime` is inclusive and `minmagnitude` behaves as "at or above" (an M5.5 event is returned for `minmagnitude=5.5`). The port's window is `[start, end)`, so the adapter drops events at exactly `end`.
- `properties.time` is epoch milliseconds; the adapter emits ISO UTC strings.
- The catalogue also holds explosions, quarry blasts and similar (`properties.type`), and some events have a null magnitude; both are skipped. `place` can be null (mapped to `''`).
- Magnitudes and locations are revised after the fact (`properties.updated`, `status: automatic|reviewed`), so resolution should read the catalogue some hours after the window closes.
- A reversed window (start after end) returns 200 with no features rather than an error.

Last verified: 2026-10-05 (live contract test passing).
