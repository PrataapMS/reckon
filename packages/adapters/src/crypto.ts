import { createHash, randomBytes } from 'node:crypto';
import type { Hasher, TokenSource } from '@reckon/core';

export const nodeHasher: Hasher = {
  sha256: (text) => createHash('sha256').update(text, 'utf8').digest('hex'),
};

export const nodeTokens: TokenSource = {
  token: (bytes = 18) => randomBytes(bytes).toString('base64url'),
};
