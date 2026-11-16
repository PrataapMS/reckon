import { z } from 'zod';
import { err, ok, type Result } from './result';
import type { Outcome } from './scoring';

/**
 * Criteria are the frozen contract of a question (spec §5). They are validated with Zod,
 * stored as JSONB, hashed, and never updated after creation.
 */
export const SourceRef = z.object({
  id: z.string().min(1), // e.g. 'openmeteo.forecast.past_days'
  version: z.string().min(1), // resolver version, e.g. '1'
});

export const Window = z.object({
  start: z.iso.datetime({ offset: true }),
  end: z.iso.datetime({ offset: true }),
  tz: z.string().min(1),
});

export const MissingPolicy = z.object({
  retryUntilHours: z.number().int().positive(),
  thenOutcome: z.literal('annul'),
});

const base = { source: SourceRef, missingPolicy: MissingPolicy };

export const ThresholdCriteria = z.object({
  kind: z.literal('threshold'),
  ...base,
  metric: z.string().min(1), // 'precipitation_sum'
  unit: z.string().min(1), // 'mm'
  // Present for place-based metrics; absent for global ones such as the planetary Kp index.
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional(),
  aggregation: z.enum(['daily_sum', 'daily_max', 'daily_min', 'max_over_window', 'value_at']),
  comparator: z.enum(['>', '>=', '<', '<=']),
  threshold: z.number(),
  window: Window,
});

export const CompareCriteria = z.object({
  kind: z.literal('compare'),
  ...base,
  metric: z.string().min(1), // 'USD/INR'
  a: z.object({ at: z.iso.date() }),
  b: z.object({ at: z.iso.date() }),
  comparator: z.enum(['>', '<']), // value at b <comparator> value at a
});

export const CountCriteria = z.object({
  kind: z.literal('count'),
  ...base,
  filter: z.record(z.string(), z.unknown()),
  comparator: z.enum(['>=', '<=']),
  threshold: z.number().int().nonnegative(),
  window: Window,
});

export const EventCriteria = z.object({
  kind: z.literal('event'),
  ...base,
  predicate: z.string().min(1), // 'github.release.exists'
  params: z.record(z.string(), z.unknown()),
  window: Window,
});

export type ThresholdCriteria = z.infer<typeof ThresholdCriteria>;
export type CompareCriteria = z.infer<typeof CompareCriteria>;
export type CountCriteria = z.infer<typeof CountCriteria>;

export const Criteria = z.discriminatedUnion('kind', [ThresholdCriteria, CompareCriteria, CountCriteria, EventCriteria]);
export type Criteria = z.infer<typeof Criteria>;

/** What a resolver observed. Its shape must match the criteria kind. */
export type Observation =
  | { readonly kind: 'value'; readonly value: number }
  | { readonly kind: 'pair'; readonly a: number; readonly b: number }
  | { readonly kind: 'count'; readonly count: number }
  | { readonly kind: 'event'; readonly occurred: boolean };

export type EvaluateError = { readonly code: 'observation_mismatch'; readonly expected: Observation['kind'] };

function compare(x: number, op: '>' | '>=' | '<' | '<=', y: number): boolean {
  switch (op) {
    case '>':
      return x > y;
    case '>=':
      return x >= y;
    case '<':
      return x < y;
    case '<=':
      return x <= y;
  }
}

/** Pure outcome function (spec §9: the resolver never computes the outcome itself). */
export function evaluate(criteria: Criteria, obs: Observation): Result<Outcome, EvaluateError> {
  switch (criteria.kind) {
    case 'threshold':
      if (obs.kind !== 'value') return err({ code: 'observation_mismatch', expected: 'value' });
      return ok(compare(obs.value, criteria.comparator, criteria.threshold) ? 1 : 0);
    case 'compare':
      if (obs.kind !== 'pair') return err({ code: 'observation_mismatch', expected: 'pair' });
      return ok(compare(obs.b, criteria.comparator, obs.a) ? 1 : 0);
    case 'count':
      if (obs.kind !== 'count') return err({ code: 'observation_mismatch', expected: 'count' });
      return ok(compare(obs.count, criteria.comparator, criteria.threshold) ? 1 : 0);
    case 'event':
      if (obs.kind !== 'event') return err({ code: 'observation_mismatch', expected: 'event' });
      return ok(obs.occurred ? 1 : 0);
  }
}

/** Deterministic JSON (sorted keys) so equal criteria always hash identically. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}
