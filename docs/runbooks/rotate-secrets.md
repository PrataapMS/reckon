# Rotate secrets

| Secret | Where it lives | How to rotate | Effect |
| --- | --- | --- | --- |
| `SESSION_SECRET` | Netlify env | `openssl rand -base64 48`, update, redeploy | Signs everyone out |
| `PASSPHRASE_HASH` | Netlify env | `pnpm --filter @reckon/api hash-passphrase "new passphrase"`, update, redeploy | Old passphrase stops working |
| `DATABASE_URL` | Netlify env, GitHub secret | Reset the role password in Neon, update both places | Brief downtime until redeploy |
| `TELEGRAM_BOT_TOKEN` | Netlify env | BotFather → /revoke, then set the webhook again | Bot offline until updated |
| `BACKUP_AGE_RECIPIENT` | GitHub secret | `age-keygen -o new.key`, put the public key in the secret | Old backups still need the old key |
