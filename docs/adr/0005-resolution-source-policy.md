# ADR-0005: Resolution sources are declared up front and never changed

**Status:** Accepted, 2026-10-05

## Context
A forecast is only fairly judged if the referee was agreed before the game. Grid-model weather data (Open-Meteo past days, ERA5) can differ from what a person saw outside.

## Decision
- Every question's criteria name the exact source, metric, aggregation, threshold, window and timezone, plus a `missingPolicy`.
- The question is about the declared dataset ("will Open-Meteo report ≥ 1 mm for this grid point?"), and the UI says so in "How this is judged".
- If the source cannot answer within `retryUntilHours`, the question is annulled with a reason. It is never guessed.
- Later cross-checks (for example ERA5) are recorded as data-quality metrics and never overwrite the declared resolution.
- News is evidence, never a resolution source (except GDELT volume for news-surge questions).

## Consequences
- Occasional "but it rained at my house" disagreements are expected and explained, not hidden.
- Annul rates per source become a health signal on the Status screen.
