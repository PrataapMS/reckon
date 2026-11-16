# Netlify credits are running low

Netlify emails at 50%, 75% and 100% of the monthly allowance. On the Free plan, hitting 300 credits pauses every site (including scheduled jobs) until the next month.

1. In the Netlify dashboard, open Usage and see which meter is high.
   - **Production deploys (15 credits each):** stop merging to `main` until the month resets; keep working on `dev` (branch deploys and previews are free).
   - **Compute:** check `job_runs` durations (`select job, avg(finished_at - started_at) from job_runs group by job`). A job taking much longer than ~5 s usually means a slow source; lower its batch size.
   - **Bandwidth:** confirm the service worker is caching assets (`dist/sw.js` deployed).
2. If a pause happens anyway, nothing is lost: resolvers backfill when the site resumes.
3. If this recurs, upgrade to Netlify Personal ($9/month, 1,000 credits) or move hosting to Cloudflare.
