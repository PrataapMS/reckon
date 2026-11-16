import type { Config } from '@netlify/functions';
import { runTick } from '@reckon/jobs';
import { compose } from '@reckon/runtime';

/** Hourly at :05 UTC. Scheduled functions have a 30 s limit, so the drain budget is 22 s. */
export default async () => {
  await runTick(compose());
};

export const config: Config = { schedule: '5 * * * *' };
