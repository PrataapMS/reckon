import type { Config } from '@netlify/functions';
import { runJob } from '@reckon/jobs';
import { compose } from '@reckon/runtime';

/**
 * 15:15 UTC (≈ 20:45 IST): resolve what is due, build the Reveal and send it.
 * Times are tuned for IST; jobs read each user's timezone and times, and tick repeats the check hourly.
 */
export default async () => {
  await runJob(compose(), 'reveal');
};

export const config: Config = { schedule: '15 15 * * *' };
