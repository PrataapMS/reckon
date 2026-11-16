import { compose } from '@reckon/runtime';
import { type JobName, runJob } from './tick';

/** Run a scheduled job by hand, locally or against Neon: `pnpm job generate`. */
const JOBS: readonly JobName[] = ['tick', 'generate', 'brief', 'reveal', 'news'];
const job = process.argv[2] as JobName | undefined;
if (!job || !JOBS.includes(job)) {
  console.error(`Usage: pnpm job <${JOBS.join('|')}>`);
  process.exit(1);
}
const c = compose();
const stats = await runJob(c, job);
console.log(JSON.stringify(stats, null, 2));
await c.db?.pool?.end();
