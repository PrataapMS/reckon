import type { Config } from '@netlify/functions';
import { runJob } from '@reckon/jobs';
import { compose } from '@reckon/runtime';

/**
 * 00:45 UTC (≈ 06:15 IST): build the Morning Brief into the outbox and send it.
 * Times are tuned for IST; jobs read each user's timezone and times, and tick repeats the check hourly.
 */
export default async () => {
  await runJob(compose(), 'brief');
};

export const config: Config = { schedule: '45 0 * * *' };
