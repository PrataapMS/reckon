import { hashPassphrase } from './passphrase';

const pass = process.argv[2];
if (!pass) {
  console.error('Usage: pnpm --filter @reckon/api hash-passphrase "your passphrase"');
  process.exit(1);
}
console.log(await hashPassphrase(pass));
