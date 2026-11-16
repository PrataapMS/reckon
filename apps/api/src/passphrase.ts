import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: { N: number; r: number; p: number }) => Promise<Buffer>;
const PARAMS = { N: 2 ** 15, r: 8, p: 1 };

/**
 * Passphrase hashing with Node's built-in scrypt (see ADR-0006: scrypt instead of Argon2id,
 * because it needs no native module on Netlify). Format: scrypt$N$r$p$saltB64$hashB64
 */
export async function hashPassphrase(passphrase: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(passphrase, salt, 32, { ...PARAMS, maxmem: 64 * 1024 * 1024 } as typeof PARAMS);
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

export async function verifyPassphrase(passphrase: string, stored: string): Promise<boolean> {
  const [algo, n, r, p, saltB64, hashB64] = stored.split('$');
  if (algo !== 'scrypt' || !n || !r || !p || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(passphrase, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 64 * 1024 * 1024,
  } as typeof PARAMS);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
