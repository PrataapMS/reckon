import { describe, expect, it } from 'vitest';
import { type Clock, drainWorkQueue, type Logger, nextRunAfter, type WorkItem, type WorkQueue } from '../src';

class FakeQueue implements WorkQueue {
  items: Array<{ -readonly [K in keyof WorkItem]: WorkItem[K] } & { done?: boolean; gaveUp?: boolean; runAfter?: Date }> = [];
  async enqueue(kind: string, payload: unknown) {
    this.items.push({ id: this.items.length + 1, kind, payload, attempts: 0, maxAttempts: 3 });
  }
  async claim(limit: number) {
    const ready = this.items.filter((i) => !i.done && !i.gaveUp && !i.runAfter).slice(0, limit);
    return ready.map((i) => {
      i.attempts++;
      return { ...i };
    });
  }
  async complete(id: number) {
    const i = this.items.find((x) => x.id === id);
    if (i) i.done = true;
  }
  async retryLater(id: number, _e: string, runAfter: Date) {
    const i = this.items.find((x) => x.id === id);
    if (i) i.runAfter = runAfter;
  }
  async giveUp(id: number) {
    const i = this.items.find((x) => x.id === id);
    if (i) i.gaveUp = true;
  }
  async depth() {
    return this.items.filter((i) => !i.done && !i.gaveUp).length;
  }
}

const silent: Logger = { info() {}, warn() {}, error() {} };

describe('drainWorkQueue', () => {
  it('completes, retries and gives up according to handler outcomes', async () => {
    const queue = new FakeQueue();
    await queue.enqueue('ok', {});
    await queue.enqueue('flaky', {});
    await queue.enqueue('mystery', {});
    const clock: Clock = { now: () => new Date('2026-10-05T00:00:00Z') };
    const stats = await drainWorkQueue({ queue, clock, logger: silent })({
      ok: async () => ({ status: 'done' }),
      flaky: async () => ({ status: 'retry', error: 'upstream_5xx' }),
    });
    expect(stats).toMatchObject({ done: 1, retried: 1, unknownKind: 1 });
  });

  it('stops when the time budget is spent', async () => {
    const queue = new FakeQueue();
    for (let i = 0; i < 5; i++) await queue.enqueue('slow', {});
    let t = 0;
    const clock: Clock = { now: () => new Date(t) };
    const stats = await drainWorkQueue({ queue, clock, logger: silent })(
      {
        slow: async () => {
          t += 10_000;
          return { status: 'done' };
        },
      },
      22_000,
    );
    expect(stats.stoppedForBudget).toBe(true);
    expect(stats.done).toBeLessThan(5);
  });

  it('backs off on the spec schedule', () => {
    const now = new Date('2026-10-05T00:00:00Z');
    expect(nextRunAfter(now, 1).getTime() - now.getTime()).toBe(3_600_000);
    expect(nextRunAfter(now, 99).getTime() - now.getTime()).toBe(48 * 3_600_000);
  });
});
