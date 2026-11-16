import { bigserial, doublePrecision, integer, jsonb, pgTable, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Typed table definitions for Drizzle queries. The source of truth for DDL, triggers and grants
 * is migrations/*.sql; keep this file in sync when a migration changes a table.
 */
export const questions = pgTable('questions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  templateId: text('template_id'),
  templateVersion: integer('template_version'),
  domain: text('domain').notNull(),
  title: text('title').notNull(),
  criteria: jsonb('criteria').notNull(),
  criteriaHash: text('criteria_hash').notNull(),
  horizonDays: integer('horizon_days').notNull(),
  correlationGroup: text('correlation_group').notNull(),
  lockAt: timestamp('lock_at', { withTimezone: true }).notNull(),
  windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
  windowEnd: timestamp('window_end', { withTimezone: true }).notNull(),
  status: text('status').notNull(),
  annulReason: text('annul_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const forecasts = pgTable('forecasts', {
  id: uuid('id').primaryKey().defaultRandom(),
  questionId: uuid('question_id').notNull(),
  forecasterId: text('forecaster_id').notNull(),
  p: doublePrecision('p').notNull(),
  madeAt: timestamp('made_at', { withTimezone: true }).notNull().defaultNow(),
  rationale: text('rationale'),
});

export const resolutions = pgTable('resolutions', {
  id: uuid('id').primaryKey().defaultRandom(),
  questionId: uuid('question_id').notNull(),
  outcome: smallint('outcome'),
  observedValue: doublePrecision('observed_value'),
  observedUnit: text('observed_unit'),
  evidenceId: uuid('evidence_id'),
  resolverVersion: text('resolver_version').notNull(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }).notNull().defaultNow(),
  supersedes: uuid('supersedes'),
});

export const jobRuns = pgTable('job_runs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  job: text('job').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  status: text('status'),
  stats: jsonb('stats'),
});
