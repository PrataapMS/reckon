import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { getStore } from '@netlify/blobs';
import type { EvidenceStore } from '@reckon/core';

/**
 * Raw evidence lives outside Postgres so the 0.5 GB database holds only hashes and metadata
 * (spec §2.1). Keys are content-addressed, so writing the same snapshot twice is harmless.
 */

/** Netlify Blobs, configured automatically inside Netlify Functions (v2 API). */
export class NetlifyBlobsEvidenceStore implements EvidenceStore {
  private cached: ReturnType<typeof getStore> | undefined;
  // Created on first use: getStore throws outside a Netlify runtime, and most requests never touch blobs.
  private get store() {
    this.cached ??= getStore({ name: 'evidence', consistency: 'strong' });
    return this.cached;
  }

  async put(key: string, body: string, contentType: string): Promise<void> {
    await this.store.set(key, body, { metadata: { contentType } });
  }

  async get(key: string): Promise<{ body: string; contentType: string } | null> {
    const r = await this.store.getWithMetadata(key, { type: 'text' });
    if (!r) return null;
    const ct = typeof r.metadata.contentType === 'string' ? r.metadata.contentType : 'application/octet-stream';
    return { body: r.data, contentType: ct };
  }
}

/** Local development: files under a directory (default `.data/evidence`, git-ignored). */
export class FsEvidenceStore implements EvidenceStore {
  private readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }

  private path(key: string): string {
    const p = resolve(join(this.root, key));
    if (!p.startsWith(this.root + sep)) throw new Error(`evidence key escapes the store: ${key}`);
    return p;
  }

  async put(key: string, body: string, contentType: string): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body, 'utf8');
    await writeFile(`${p}.meta`, JSON.stringify({ contentType }), 'utf8');
  }

  async get(key: string): Promise<{ body: string; contentType: string } | null> {
    const p = this.path(key);
    try {
      const body = await readFile(p, 'utf8');
      const meta = JSON.parse(await readFile(`${p}.meta`, 'utf8').catch(() => '{}')) as { contentType?: string };
      return { body, contentType: meta.contentType ?? 'application/octet-stream' };
    } catch {
      return null;
    }
  }
}

/** Tests and the E2E fake stack. */
export class MemoryEvidenceStore implements EvidenceStore {
  readonly items = new Map<string, { body: string; contentType: string }>();
  async put(key: string, body: string, contentType: string): Promise<void> {
    this.items.set(key, { body, contentType });
  }
  async get(key: string) {
    return this.items.get(key) ?? null;
  }
}
