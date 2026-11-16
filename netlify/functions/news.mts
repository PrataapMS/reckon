import type { Config } from '@netlify/functions';
import { runJob } from '@reckon/jobs';
import { compose } from '@reckon/runtime';

/** Hourly at :35 UTC (spec §3.4): fetch feeds, Hacker News and GDELT; tag, link and retain headlines. */
export default async () => {
  await runJob(compose(), 'news');
};

export const config: Config = { schedule: '35 * * * *' };
