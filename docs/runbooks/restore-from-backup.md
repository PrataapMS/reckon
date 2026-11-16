# Restore from backup

Two layers: Neon's own restore window (6 hours on Free) and the nightly encrypted `pg_dump` artifact (30 days).

**Within 6 hours of the problem:** use Neon's console to restore the branch to a point in time before the incident.

**Older than 6 hours:**
1. In GitHub → Actions → "Database backup (nightly)", download the `reckon-db-backup` artifact from before the incident.
2. Decrypt and restore into a fresh database (never straight over production):
   ```bash
   age -d -i ~/.config/reckon/backup.key reckon-YYYYMMDDTHHMMSSZ.dump.gz.age | gunzip > reckon.dump
   pg_restore --no-owner --dbname "$NEW_DATABASE_URL" reckon.dump
   ```
3. Run `pnpm db:migrate` against it (it skips applied migrations) and `pnpm test:integration` with `DATABASE_URL=$NEW_DATABASE_URL`.
4. Point Netlify's `DATABASE_URL` at the restored database and redeploy.

Keep the `age` private key outside GitHub (a password manager). Only the public recipient goes into the `BACKUP_AGE_RECIPIENT` secret.
