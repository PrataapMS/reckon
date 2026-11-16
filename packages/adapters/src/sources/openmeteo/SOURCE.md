# Open-Meteo

Verify these against https://open-meteo.com/en/docs before changing an adapter (spec §3.1 rule).

| Use | Endpoint | Parameters Reckon relies on | Adapter |
| --- | --- | --- | --- |
| Daily forecast (provider) | `https://api.open-meteo.com/v1/forecast` | `daily=precipitation_probability_max,precipitation_sum,temperature_2m_max`, `forecast_days`, `past_days` | `OpenMeteoForecastAdapter` |
| Air-quality forecast | `https://air-quality-api.open-meteo.com/v1/air-quality` | `hourly=us_aqi` (reduced to a daily max), `forecast_days` ≤ 7, `past_days` | `OpenMeteoAirQualityAdapter` |
| Ensemble | `https://ensemble-api.open-meteo.com/v1/ensemble` | `models=ecmwf_ifs025`, `daily=precipitation_sum,temperature_2m_max`; columns `<var>` (control) and `<var>_memberNN` (50 members) | `OpenMeteoEnsembleAdapter` |
| Climatology (weather) | `https://archive-api.open-meteo.com/v1/archive` | ERA5 `daily=<metric>`, `start_date`, `end_date`; about 5 days behind real time | `OpenMeteoHistoryAdapter` |
| Climatology (air) | air-quality endpoint with `start_date`/`end_date` | hourly `us_aqi`; data starts 2022-08 (earlier dates return nulls; ADR-0008) | `OpenMeteoHistoryAdapter` |
| Resolution (weather) | forecast endpoint with `start_date = end_date = day` | past days allowed up to about 3 months back | `OpenMeteoPastDayAdapter` |
| Resolution (air) | air-quality endpoint with `start_date = end_date = day` | needs ≥ 20 of 24 hourly values, else "missing" and retried | `OpenMeteoPastDayAdapter` |
| City search | `https://geocoding-api.open-meteo.com/v1/search` | `name`, `count`, `language=en`; `results` is absent when nothing matches | `OpenMeteoGeocodingAdapter` |

| Item | Value |
| --- | --- |
| Auth | None for the free non-commercial API |
| Terms | Free for non-commercial use; data licensed CC BY 4.0, attribution required (shown in the app footer) |
| Limits | Fair use on the free tier; Reckon makes about 4 calls per location per day plus 3 history calls per location per month |
| Fixtures | `packages/adapters/test/fixtures/openmeteo-*.json` (recorded 2026-10-05, trimmed) |
| Contract test | `packages/adapters/test/openmeteo.contract.test.ts` (run with `pnpm test:contracts`) |

Last verified: 2026-10-05 (all live contract tests passing).
