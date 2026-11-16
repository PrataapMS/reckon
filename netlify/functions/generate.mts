import type { Config } from '@netlify/functions';
import { runJob } from '@reckon/jobs';
import { compose } from '@reckon/runtime';

/**
 * 23:15 UTC (≈ 04:45 IST): enqueue and run per-location question generation and forecasts.
 * Times are tuned for IST; jobs read each user's timezone and times, and tick repeats the check hourly.
 */
export default async () => {
  await runJob(compose(), 'generate');
};

export const config: Config = { schedule: '15 23 * * *' };
