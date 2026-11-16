import type { EvidenceRepo, EvidenceStore, Hasher, SourceSnapshot } from '../ports';

export interface EvidenceDeps {
  readonly evidenceStore: EvidenceStore;
  readonly evidence: EvidenceRepo;
  readonly hasher: Hasher;
}

/**
 * Spec §3.4 step 2: the raw response goes to blob storage under a content-addressed key, and
 * its SHA-256 plus where and when it came from become an append-only `evidence` row.
 */
export async function saveSnapshot(deps: EvidenceDeps, snap: SourceSnapshot<unknown>, meta: Record<string, unknown> = {}): Promise<string> {
  const sha256 = deps.hasher.sha256(snap.raw);
  const contentType = snap.contentType ?? 'application/json';
  const ext = contentType.includes('json') ? 'json' : contentType.includes('xml') ? 'xml' : 'txt';
  const blobKey = `snapshots/${snap.sourceId}/${snap.fetchedAt.slice(0, 10)}/${sha256}.${ext}`;
  await deps.evidenceStore.put(blobKey, snap.raw, contentType);
  return deps.evidence.insertSnapshot({ sourceId: snap.sourceId, fetchedAt: snap.fetchedAt, blobKey, sha256, url: snap.requestUrl, meta });
}
