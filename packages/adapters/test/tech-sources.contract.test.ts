import { describe, expect, it } from 'vitest';
import { GitHubReleasesAdapter } from '../src/sources/github';
import { HackerNewsAdapter } from '../src/sources/hackernews';
import { StatusPageAdapter } from '../src/sources/statuspage';

/**
 * Live contract tests for the tech sources: hit the real APIs. Run nightly in CI
 * (`pnpm test:contracts`), never in the normal unit run. Unauthenticated GitHub allows 60
 * requests per hour per IP; set GITHUB_TOKEN to avoid sharing that budget.
 */
const live = process.env.RECKON_LIVE === '1';
const ua = `Reckon/0.1 (contract test; ${process.env.CONTACT_EMAIL ?? 'unknown'})`;
const token = process.env.GITHUB_TOKEN;

describe.runIf(live)('Tech sources live contract', () => {
  it('GitHub releases still lists published releases for nodejs/node', async () => {
    const r = await new GitHubReleasesAdapter({ userAgent: ua, ...(token ? { token } : {}) }).releases('nodejs/node');
    expect(r.ok, r.ok ? '' : JSON.stringify(r.error)).toBe(true);
    if (!r.ok) return;
    expect(r.value.parsed.releases.length).toBeGreaterThan(0);
    expect(r.value.parsed.releases[0]?.url).toMatch(/^https:\/\/github\.com\/nodejs\/node\/releases\/tag\//);
  });

  it('GitHub releases follows a moved repository (facebook/react answers with a 301)', async () => {
    const r = await new GitHubReleasesAdapter({ userAgent: ua, ...(token ? { token } : {}) }).releases('facebook/react');
    expect(r.ok, r.ok ? '' : JSON.stringify(r.error)).toBe(true);
    if (r.ok) expect(r.value.parsed.releases.length).toBeGreaterThan(0);
  });

  it('Statuspage still lists incidents with known impact levels', async () => {
    const r = await new StatusPageAdapter({ userAgent: ua }).incidents('www.githubstatus.com');
    expect(r.ok, r.ok ? '' : JSON.stringify(r.error)).toBe(true);
    if (!r.ok) return;
    expect(r.value.parsed.pageName).toBe('GitHub');
    expect(r.value.parsed.incidents.length).toBeGreaterThan(0);
  });

  it('Algolia HN search still returns the front page', async () => {
    const r = await new HackerNewsAdapter({ userAgent: ua }).frontPage();
    expect(r.ok, r.ok ? '' : JSON.stringify(r.error)).toBe(true);
    if (r.ok) expect(r.value.parsed.length).toBeGreaterThan(10);
  });
});
