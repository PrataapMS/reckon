# ADR-0007: Bounded logistic mapping before a fitted mapping exists

**Status:** Accepted, 2026-10-05. Refines spec §3.3 (provider forecaster), which said "p = 0.8 if past threshold, else 0.2".

## Context
For thresholds where the provider gives a value rather than a probability (heat, AQI), Reckon needs a probability before it has history to fit a calibrated mapping. A hard 0.8 / 0.2 step says a forecast of 151 against a limit of 150 is as certain as 300.

## Decision
`provisionalProbability(value, threshold, scale)` in `packages/core/src/app/preview-brief.ts`:

p = 1 / (1 + exp(−(value − threshold) / scale)), then clipped to [0.2, 0.8].

Scales: 1.5 °C for temperature, 15 AQI points for air quality. The [0.2, 0.8] bounds stop Reckon from sounding confident before it has earned it. Forecasters using this are labelled "(provisional mapping)" in the UI.

## Consequences
- Near-threshold forecasts read as toss-ups, which is honest.
- Phase 1/4 replace this with a logistic fitted on resolved history; that is a new forecaster version (new ID), so the track record resets honestly.
