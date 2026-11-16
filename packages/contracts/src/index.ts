import { z } from 'zod';

/** Shared API contracts (spec §15). The API validates outgoing data; the web app validates incoming. */

export const VerbalLabel = z.enum(['Very unlikely', 'Unlikely', 'Toss-up', 'Likely', 'Very likely']);

export const PreviewBriefItem = z.object({
  id: z.string(),
  domain: z.enum(['weather', 'air']),
  title: z.string(),
  p: z.number().min(0).max(1),
  percent: z.number().int().min(1).max(99),
  label: VerbalLabel,
  action: z.string(),
  forecaster: z.string(),
  basis: z.string(),
  sourceUrl: z.url(),
});
export type PreviewBriefItem = z.infer<typeof PreviewBriefItem>;

export const PreviewBriefResponse = z.object({
  generatedAt: z.iso.datetime(),
  location: z.object({ lat: z.number(), lon: z.number(), tz: z.string() }),
  items: z.array(PreviewBriefItem),
  warnings: z.array(z.string()),
  trust: z.literal('learning'),
});
export type PreviewBriefResponse = z.infer<typeof PreviewBriefResponse>;

export const PreviewBriefQuery = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lon: z.coerce.number().min(-180).max(180),
  tz: z.string().min(1).max(64).default('UTC'),
});

export const HealthResponse = z.object({
  status: z.enum(['ok', 'degraded']),
  time: z.iso.datetime(),
  database: z.enum(['ok', 'unavailable', 'not_configured']),
  queueDepth: z.number().int().nullable(),
  jobs: z.array(z.object({ job: z.string(), lastStartedAt: z.string(), lastStatus: z.string().nullable(), lastOkAt: z.string().nullable() })),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

export const SessionRequest = z.object({ passphrase: z.string().min(1).max(512) });

/** RFC 9457 problem details. */
export const Problem = z.object({ type: z.string(), title: z.string(), status: z.number().int(), detail: z.string().optional() });
export type Problem = z.infer<typeof Problem>;

// ---------------------------------------------------------------------------
// Phase 1 (spec §2.5)
// ---------------------------------------------------------------------------

export const Domain = z.enum(['weather', 'air', 'money', 'tech', 'world', 'life']);
export const QuestionStatus = z.enum(['open', 'locked', 'resolving', 'resolved', 'annulled']);
export const TemplateClass = z.enum(['decision', 'informative']);
/** Place questions (weather, air) vs World Pulse questions (money, tech, space, news). */
export const Scope = z.enum(['place', 'world']);
const isoDate = z.iso.date();
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use HH:MM (24-hour)');

export const Trust = z.object({
  status: z.enum(['learning', 'proven', 'no_edge', 'worse', 'baseline']),
  clusters: z.number().int().nonnegative(),
  needed: z.number().int().positive(),
  bss: z.number().nullable(),
  ci: z.tuple([z.number(), z.number()]).nullable(),
  text: z.string(),
});

export const BriefItem = z.object({
  questionId: z.uuid(),
  templateId: z.string().nullable(),
  scope: Scope,
  domain: Domain,
  class: TemplateClass,
  subject: z.string(),
  placeName: z.string(),
  title: z.string(),
  targetDate: isoDate,
  when: z.string(),
  horizonDays: z.number().int().nonnegative(),
  status: QuestionStatus,
  lockAt: z.iso.datetime(),
  p: z.number().gt(0).lt(1),
  percent: z.number().int().min(1).max(99),
  label: VerbalLabel,
  action: z.string().nullable(),
  forecaster: z.object({ id: z.string(), name: z.string() }),
  basis: z.string(),
  trust: Trust,
});
export type BriefItem = z.infer<typeof BriefItem>;

export const BriefResponse = z.object({
  date: isoDate,
  tz: z.string(),
  generatedAt: z.iso.datetime(),
  today: z.array(BriefItem),
  tomorrow: z.array(BriefItem),
  later: z.array(BriefItem),
  world: z.array(BriefItem),
});
export type BriefResponse = z.infer<typeof BriefResponse>;

export const ForecastScore = z.object({
  forecasterId: z.string(),
  name: z.string(),
  p: z.number(),
  percent: z.number().int(),
  madeAt: z.iso.datetime(),
  rationale: z.string().nullable(),
  brier: z.number().nullable(),
  champion: z.boolean(),
});
export type ForecastScore = z.infer<typeof ForecastScore>;

export const Outcome = z.union([z.literal(0), z.literal(1)]);

export const RevealCard = z.object({
  questionId: z.uuid(),
  scope: Scope,
  domain: Domain,
  subject: z.string(),
  placeName: z.string(),
  title: z.string(),
  status: QuestionStatus,
  percent: z.number().int().nullable(),
  outcome: Outcome.nullable(),
  observed: z.string().nullable(),
  annulReason: z.string().nullable(),
  hit: z.boolean().nullable(),
  brier: z.number().nullable(),
  forecasts: z.array(ForecastScore),
});
export type RevealCard = z.infer<typeof RevealCard>;

export const RevealResponse = z.object({
  date: isoDate,
  sealed: z.boolean(),
  opensAt: z.iso.datetime(),
  total: z.number().int().nonnegative(),
  cards: z.array(RevealCard),
  summary: z.object({
    hits: z.number().int(),
    misses: z.number().int(),
    pending: z.number().int(),
    annulled: z.number().int(),
    meanBrier: z.number().nullable(),
  }),
});
export type RevealResponse = z.infer<typeof RevealResponse>;

export const EvidenceItem = z.object({
  id: z.uuid(),
  sourceId: z.string(),
  fetchedAt: z.iso.datetime(),
  url: z.string().nullable(),
  sha256: z.string(),
  purpose: z.string().nullable(),
  downloadPath: z.string(),
});
export type EvidenceItem = z.infer<typeof EvidenceItem>;

export const NewsLink = z.object({
  evidenceId: z.uuid(),
  title: z.string(),
  source: z.string(),
  url: z.string(),
  publishedAt: z.string(),
  snippet: z.string().nullable(),
  relevance: z.number(),
});
export type NewsLink = z.infer<typeof NewsLink>;

export const QuestionDetailResponse = z.object({
  id: z.uuid(),
  scope: Scope,
  title: z.string(),
  subject: z.string(),
  placeName: z.string(),
  domain: Domain,
  class: TemplateClass,
  templateId: z.string().nullable(),
  templateDescription: z.string().nullable(),
  targetDate: isoDate,
  when: z.string(),
  horizonDays: z.number().int(),
  status: QuestionStatus,
  lockAt: z.iso.datetime(),
  sealed: z.boolean(),
  opensAt: z.iso.datetime(),
  judged: z.object({ rule: z.string(), dataset: z.string(), caveat: z.string(), missing: z.string() }),
  criteria: z.unknown(),
  criteriaHash: z.string(),
  baseRate: z.number().nullable(),
  forecasts: z.array(ForecastScore),
  resolution: z
    .object({
      outcome: Outcome.nullable(),
      observed: z.string().nullable(),
      resolvedAt: z.iso.datetime(),
      resolver: z.string(),
      annulReason: z.string().nullable(),
    })
    .nullable(),
  evidence: z.array(EvidenceItem),
  news: z.array(NewsLink),
});
export type QuestionDetailResponse = z.infer<typeof QuestionDetailResponse>;

export const UserSettings = z.object({
  actionThresholds: z.object({ rain: z.number().min(0.05).max(0.95).optional(), aqi: z.number().min(0.05).max(0.95).optional() }).optional(),
});

export const LocationResponse = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  name: z.string(),
  lat: z.number(),
  lon: z.number(),
  tz: z.string(),
  isPrimary: z.boolean(),
});
export type LocationResponse = z.infer<typeof LocationResponse>;

export const MeResponse = z.object({
  user: z.object({
    id: z.uuid(),
    displayName: z.string().nullable(),
    tz: z.string(),
    briefTime: hhmm,
    revealTime: hhmm,
    quietStart: hhmm,
    quietEnd: hhmm,
    onboardedAt: z.iso.datetime().nullable(),
    paused: z.boolean(),
    settings: UserSettings,
    telegramLinked: z.boolean(),
  }),
  locations: z.array(LocationResponse),
  stats: z.object({ resolvedDays: z.number().int(), daysForTrust: z.number().int() }),
  telegramAvailable: z.boolean(),
  /** VAPID public key when Web Push is configured on this server, else null. */
  pushPublicKey: z.string().nullable(),
});
export type MeResponse = z.infer<typeof MeResponse>;

const timezone = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, 'unknown timezone');

export const MePatch = z
  .object({
    displayName: z.string().max(60).nullable(),
    tz: timezone,
    briefTime: hhmm,
    revealTime: hhmm,
    quietStart: hhmm,
    quietEnd: hhmm,
    paused: z.boolean(),
    settings: UserSettings,
    onboarded: z.literal(true),
  })
  .partial()
  .strict();
export type MePatch = z.infer<typeof MePatch>;

/** Coordinates are rounded to ~1 km before storage (spec 05-operations, Privacy). */
const round2 = (v: number) => Math.round(v * 100) / 100;
export const LocationInput = z
  .object({
    name: z.string().trim().min(1).max(40),
    lat: z.number().min(-90).max(90).transform(round2),
    lon: z.number().min(-180).max(180).transform(round2),
    tz: timezone,
    isPrimary: z.boolean().optional(),
  })
  .strict();
export const LocationPatch = LocationInput.partial().strict();

export const GeocodeResponse = z.object({
  results: z.array(z.object({ name: z.string(), region: z.string(), country: z.string(), lat: z.number(), lon: z.number(), tz: z.string() })),
});
export type GeocodeResponse = z.infer<typeof GeocodeResponse>;

export const TelegramLinkResponse = z.object({ url: z.url(), expiresAt: z.iso.datetime() });

/** The subset of a Telegram Update that Reckon reads (https://core.telegram.org/bots/api#update). */
export const TelegramUpdate = z.object({
  update_id: z.number(),
  message: z
    .object({
      chat: z.object({ id: z.number(), type: z.string() }),
      text: z.string().optional(),
    })
    .optional(),
});

export const QuestionListResponse = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  questions: z.array(
    z.object({
      id: z.uuid(),
      scope: Scope,
      title: z.string(),
      subject: z.string(),
      placeName: z.string(),
      domain: Domain,
      templateId: z.string().nullable(),
      targetDate: z.iso.date(),
      horizonDays: z.number().int(),
      status: QuestionStatus,
    }),
  ),
});

// ---------------------------------------------------------------------------
// Phase 2 (spec §2.5)
// ---------------------------------------------------------------------------

export const ScoreboardResponse = z.object({
  resolvedQuestions: z.number().int().nonnegative(),
  resolvedClusters: z.number().int().nonnegative(),
  clustersNeeded: z.number().int().positive(),
  templates: z.array(
    z.object({
      templateId: z.string(),
      domain: Domain,
      description: z.string(),
      questions: z.number().int().nonnegative(),
      forecasters: z.array(
        z.object({
          forecasterId: z.string(),
          name: z.string(),
          n: z.number().int().positive(),
          meanBrier: z.number().min(0).max(1),
          champion: z.boolean(),
          trust: Trust,
        }),
      ),
    }),
  ),
});
export type ScoreboardResponse = z.infer<typeof ScoreboardResponse>;

export const CalibrationQuery = z.object({
  forecaster: z.string().min(1).max(64).optional(),
  template: z.string().min(1).max(64).optional(),
});

export const CalibrationResponse = z.object({
  forecaster: z.string(),
  name: z.string(),
  templateId: z.string().nullable(),
  n: z.number().int().nonnegative(),
  ece: z.number().nullable(),
  bins: z.array(
    z.object({
      lower: z.number(),
      upper: z.number(),
      count: z.number().int().nonnegative(),
      meanForecast: z.number().nullable(),
      observed: z.number().nullable(),
      ci: z.tuple([z.number(), z.number()]).nullable(),
    }),
  ),
  forecasters: z.array(z.object({ id: z.string(), name: z.string() })),
});
export type CalibrationResponse = z.infer<typeof CalibrationResponse>;

export const TopicsResponse = z.object({
  topics: z.array(z.object({ id: z.uuid(), label: z.string(), searchable: z.boolean() })),
  suggestions: z.array(z.object({ key: z.string(), label: z.string() })),
});
export type TopicsResponse = z.infer<typeof TopicsResponse>;

export const TopicCreate = z.union([
  z.object({ suggestion: z.string().min(1).max(64) }).strict(),
  z.object({ label: z.string().trim().min(2).max(40) }).strict(),
]);

/** The browser's PushSubscription.toJSON() shape. */
export const PushSubscribeRequest = z.object({
  endpoint: z.url().max(1024),
  keys: z.object({ p256dh: z.string().min(1).max(256), auth: z.string().min(1).max(64) }),
});
export const PushUnsubscribeRequest = z.object({ endpoint: z.url().max(1024) });
