# Neon compute quota is running low

Neon Free gives 100 CU-hours per project per month; when used up, compute suspends until the next period.

1. In the Neon console, check compute usage and confirm the minimum compute size is 0.25 CU and scale-to-zero is on.
2. Check how often jobs wake the database: `select job, count(*) from job_runs where started_at > now() - interval '1 day' group by job`. Expected: ~24 ticks plus a few daily jobs.
3. Make sure nothing polls the database continuously (an open `psql` session or a dev server pointed at production keeps compute awake).
4. If real usage has grown, move to Neon Launch (pay per CU-hour, no minimum) and set a spending cap.
