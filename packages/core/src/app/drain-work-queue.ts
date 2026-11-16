import type { Clock, Logger, WorkItem, WorkQueue } from '../ports';

/** Retry schedule from spec §9: 1 h, 3 h, 6 h, 12 h, 24 h, 48 h. */
export const BACKOFF_HOURS = [1, 3, 6, 12, 24, 48] as const;

export type HandlerOutcome =
  | { readonly status: 'done' }
  | { readonly status: 'retry'; readonly error: string; readonly runAfter?: Date }
  | { readonly status: 'fail'; readonly error: string };
export type WorkHandler = (item: WorkItem) => Promise<HandlerOutcome>;

export interface DrainStats {
  processed: number;
  done: number;
  retried: number;
  failed: number;
  unknownKind: number;
  stoppedForBudget: boolean;
}

export function nextRunAfter(now: Date, attempts: number): Date {
  const idx = Math.min(Math.max(attempts - 1, 0), BACKOFF_HOURS.length - 1);
  return new Date(now.getTime() + (BACKOFF_HOURS[idx] as number) * 3_600_000);
}

/**
 * Drains the Postgres work queue inside a time budget so a 30-second scheduled function never
 * times out. Unfinished items are picked up by the next tick (spec §9, "Work queue with leases").
 */
export function drainWorkQueue(deps: { queue: WorkQueue; clock: Clock; logger: Logger }) {
  return async (handlers: Readonly<Record<string, WorkHandler>>, budgetMs = 22_000, batchSize = 10): Promise<DrainStats> => {
    const started = deps.clock.now().getTime();
    const stats: DrainStats = { processed: 0, done: 0, retried: 0, failed: 0, unknownKind: 0, stoppedForBudget: false };

    while (deps.clock.now().getTime() - started < budgetMs) {
      const batch = await deps.queue.claim(batchSize, 60);
      if (batch.length === 0) break;
      for (const item of batch) {
        if (deps.clock.now().getTime() - started >= budgetMs) {
          stats.stoppedForBudget = true; // lease expires; the next tick reclaims it
          return stats;
        }
        stats.processed++;
        const handler = handlers[item.kind];
        if (!handler) {
          stats.unknownKind++;
          await deps.queue.giveUp(item.id, `no handler for kind '${item.kind}'`);
          deps.logger.error('work.unknown_kind', { id: item.id, kind: item.kind });
          continue;
        }
        let outcome: HandlerOutcome;
        try {
          outcome = await handler(item);
        } catch (e) {
          outcome = { status: 'retry', error: e instanceof Error ? e.message : String(e) };
        }
        if (outcome.status === 'done') {
          stats.done++;
          await deps.queue.complete(item.id);
        } else if (outcome.status === 'retry' && item.attempts < item.maxAttempts) {
          stats.retried++;
          await deps.queue.retryLater(item.id, outcome.error, outcome.runAfter ?? nextRunAfter(deps.clock.now(), item.attempts));
        } else {
          stats.failed++;
          await deps.queue.giveUp(item.id, outcome.error);
        }
      }
    }
    if (deps.clock.now().getTime() - started >= budgetMs) stats.stoppedForBudget = true;
    return stats;
  };
}
