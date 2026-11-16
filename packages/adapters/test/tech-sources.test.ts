import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GitHubReleasesAdapter } from '../src/sources/github';
import { HackerNewsAdapter } from '../src/sources/hackernews';
import type { FetchLike } from '../src/sources/http';
import { StatusPageAdapter } from '../src/sources/statuspage';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
function recording(body: string, status = 200, headers: Record<string, string> = {}) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
    return new Response(body, { status, headers });
  };
  return { calls, fetchImpl };
}
const now = () => new Date('2026-10-05T12:00:00Z');

describe('GitHubReleasesAdapter (recorded facebook/react fixture)', () => {
  it('maps published releases newest first and drops the draft', async () => {
    const rec = recording(fixture('github-releases.json'));
    const r = await new GitHubReleasesAdapter({ userAgent: 'test', fetchImpl: rec.fetchImpl, now }).releases('facebook/react');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({ sourceId: 'github.releases', fetchedAt: '2026-10-05T12:00:00.000Z' });
    const { parsed } = r.value;
    expect(parsed.repo).toBe('facebook/react');
    expect(parsed.complete).toBe(true);
    expect(parsed.releases.map((x) => x.tag)).toEqual(['v19.3.0', 'v19.2.8', 'v19.1.9', 'v16.9.0-rc.0']);
    expect(parsed.releases[0]).toEqual({
      tag: 'v19.3.0',
      name: expect.any(String),
      publishedAt: '2026-09-09T18:01:33.000Z',
      prerelease: false,
      // facebook/react now lives at react/react; GitHub redirects the API call and links the new home.
      url: 'https://github.com/react/react/releases/tag/v19.3.0',
    });
    expect(parsed.releases.find((x) => x.tag === 'v16.9.0-rc.0')?.prerelease).toBe(true);
  });

  it('sorts by publish time whatever order GitHub lists them in', async () => {
    const reversed = JSON.stringify(JSON.parse(fixture('github-releases.json')).reverse());
    const r = await new GitHubReleasesAdapter({ userAgent: 'test', fetchImpl: recording(reversed).fetchImpl }).releases('facebook/react');
    expect(r.ok && r.value.parsed.releases.map((x) => x.tag)).toEqual(['v19.3.0', 'v19.2.8', 'v19.1.9', 'v16.9.0-rc.0']);
  });

  it('builds the URL and versioned headers, without Authorization unless a token is set', async () => {
    const anon = recording('[]');
    await new GitHubReleasesAdapter({ userAgent: 'test-ua', fetchImpl: anon.fetchImpl }).releases('nodejs/node');
    expect(anon.calls[0]?.url).toBe('https://api.github.com/repos/nodejs/node/releases?per_page=100');
    expect(anon.calls[0]?.headers).toMatchObject({ Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'test-ua' });
    expect(anon.calls[0]?.headers).not.toHaveProperty('Authorization');

    const authed = recording('[]');
    await new GitHubReleasesAdapter({ userAgent: 'test', token: 'ghp_x', fetchImpl: authed.fetchImpl, base: 'http://gh.test' }).releases('nodejs/node');
    expect(authed.calls[0]?.url).toBe('http://gh.test/repos/nodejs/node/releases?per_page=100');
    expect(authed.calls[0]?.headers.Authorization).toBe('Bearer ghp_x');
  });

  it('marks a full page as incomplete', async () => {
    const release = { tag_name: 'v1', name: null, draft: false, prerelease: false, published_at: '2026-01-01T00:00:00Z', html_url: 'https://github.com/a/b' };
    const r = await new GitHubReleasesAdapter({ userAgent: 'test', fetchImpl: recording(JSON.stringify(Array(100).fill(release))).fetchImpl }).releases('a/b');
    expect(r.ok && r.value.parsed.complete).toBe(false);
  });

  it.each(['facebook', 'a/b/c', '../etc', 'a/..', 'own er/repo', 'owner/re?po', ''])('rejects repo %j without fetching', async (repo) => {
    const rec = recording('[]');
    const r = await new GitHubReleasesAdapter({ userAgent: 'test', fetchImpl: rec.fetchImpl }).releases(repo);
    expect(r.ok ? 'ok' : r.error.code).toBe('not_found');
    expect(rec.calls).toHaveLength(0);
  });

  it('maps the primary rate limit (403 with remaining 0) to rate_limited', async () => {
    const rec = recording('{"message":"API rate limit exceeded"}', 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1791223738' });
    const r = await new GitHubReleasesAdapter({ userAgent: 'test', fetchImpl: rec.fetchImpl }).releases('nodejs/node');
    expect(r.ok ? null : r.error).toMatchObject({ code: 'rate_limited', sourceId: 'github.releases', detail: expect.stringContaining('2026-10-05') });
  });

  it('maps a secondary rate limit (retry-after) to rate_limited, but not any other 403', async () => {
    const secondary = recording('{"message":"secondary rate limit"}', 403, { 'retry-after': '60', 'x-ratelimit-remaining': '12' });
    const s = await new GitHubReleasesAdapter({ userAgent: 'test', fetchImpl: secondary.fetchImpl }).releases('nodejs/node');
    expect(s.ok ? 'ok' : s.error.code).toBe('rate_limited');

    const forbidden = recording('{"message":"Forbidden"}', 403, { 'x-ratelimit-remaining': '42' });
    const f = await new GitHubReleasesAdapter({ userAgent: 'test', fetchImpl: forbidden.fetchImpl }).releases('nodejs/node');
    expect(f.ok ? 'ok' : f.error.code).toBe('schema_changed');
  });

  it('reports 404 as not_found and a changed payload as schema_changed', async () => {
    const missing = await new GitHubReleasesAdapter({ userAgent: 'test', fetchImpl: recording('{}', 404).fetchImpl }).releases('nobody/nothing');
    expect(missing.ok ? 'ok' : missing.error.code).toBe('not_found');
    const changed = await new GitHubReleasesAdapter({ userAgent: 'test', fetchImpl: recording('[{"tag":"v1"}]').fetchImpl }).releases('a/b');
    expect(changed.ok ? 'ok' : changed.error.code).toBe('schema_changed');
  });
});

describe('StatusPageAdapter (recorded www.githubstatus.com fixture)', () => {
  it('maps incidents with shortlinks and page name', async () => {
    const rec = recording(fixture('statuspage-incidents.json'));
    const r = await new StatusPageAdapter({ userAgent: 'test', fetchImpl: rec.fetchImpl, now }).incidents('www.githubstatus.com');
    expect(rec.calls[0]?.url).toBe('https://www.githubstatus.com/api/v2/incidents.json');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.sourceId).toBe('statuspage');
    const { parsed } = r.value;
    expect(parsed).toMatchObject({ service: 'www.githubstatus.com', pageName: 'GitHub', complete: true });
    expect(parsed.incidents).toHaveLength(4);
    expect(parsed.incidents[0]).toEqual({
      id: '2dpbcq5j165n',
      name: 'Actions Job Delays',
      impact: 'minor',
      createdAt: '2026-10-01T14:47:48.138Z',
      url: 'https://stspg.io/kdqxfjn5qg6q',
    });
    expect(parsed.incidents.map((i) => i.impact)).toContain('critical');
  });

  it('falls back to the page URL without a shortlink, normalises offsets to UTC and sorts newest first', async () => {
    const body = JSON.stringify({
      page: { id: 'p', name: 'Example', url: 'https://status.example.com/' },
      incidents: [
        { id: 'old', name: 'Old', status: 'resolved', created_at: '2026-09-01T10:00:00.000-06:00', impact: 'none', shortlink: null },
        { id: 'new', name: 'New', status: 'investigating', created_at: '2026-10-01T00:00:00Z', impact: 'major' },
      ],
    });
    const rec = recording(body);
    const r = await new StatusPageAdapter({ userAgent: 'test', fetchImpl: rec.fetchImpl, base: 'http://sp.test' }).incidents('status.example.com');
    expect(rec.calls[0]?.url).toBe('http://sp.test/api/v2/incidents.json');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.parsed.incidents.map((i) => i.id)).toEqual(['new', 'old']);
    expect(r.value.parsed.incidents[1]).toMatchObject({ createdAt: '2026-09-01T16:00:00.000Z', url: 'https://status.example.com/incidents/old' });
  });

  it('marks 50 incidents as incomplete', async () => {
    const incident = { id: 'x', name: 'X', created_at: '2026-10-01T00:00:00Z', impact: 'minor', shortlink: 'https://stspg.io/x' };
    const body = JSON.stringify({ page: { name: 'P', url: 'https://status.example.com' }, incidents: Array(50).fill(incident) });
    const r = await new StatusPageAdapter({ userAgent: 'test', fetchImpl: recording(body).fetchImpl }).incidents('status.example.com');
    expect(r.ok && r.value.parsed.complete).toBe(false);
  });

  it.each(['localhost', 'foo.localhost', '127.0.0.1', '10.0.0.1', '[::1]', 'example', 'evil.com/path', 'evil.com:8080', 'user@evil.com', '-bad.com', ''])(
    'rejects host %j without fetching',
    async (host) => {
      const rec = recording('{}');
      const r = await new StatusPageAdapter({ userAgent: 'test', fetchImpl: rec.fetchImpl }).incidents(host);
      expect(r.ok ? 'ok' : r.error.code).toBe('not_found');
      expect(rec.calls).toHaveLength(0);
    },
  );

  it('reports an unknown impact as schema_changed rather than guessing', async () => {
    const body = JSON.stringify({
      page: { name: 'P', url: 'https://s.example.com' },
      incidents: [{ id: 'x', name: 'X', created_at: '2026-10-01T00:00:00Z', impact: 'maintenance' }],
    });
    const r = await new StatusPageAdapter({ userAgent: 'test', fetchImpl: recording(body).fetchImpl }).incidents('s.example.com');
    expect(r.ok ? 'ok' : r.error.code).toBe('schema_changed');
  });

  it('passes through upstream errors', async () => {
    const r = await new StatusPageAdapter({ userAgent: 'test', fetchImpl: recording('', 429).fetchImpl }).incidents('s.example.com');
    expect(r.ok ? 'ok' : r.error.code).toBe('rate_limited');
  });
});

describe('HackerNewsAdapter (recorded Algolia fixture)', () => {
  it('maps front-page hits to raw news items', async () => {
    const rec = recording(fixture('hackernews-front.json'));
    const r = await new HackerNewsAdapter({ userAgent: 'test', fetchImpl: rec.fetchImpl, now }).frontPage();
    expect(rec.calls[0]?.url).toBe('https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=30');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.sourceId).toBe('hackernews');
    expect(r.value.parsed).toHaveLength(4);
    expect(r.value.parsed[0]).toEqual({
      url: 'https://www.cpr.dk/cpr-nyt/nyhedsarkiv/2026/okt/omfattende-uautoriseret-adgang-til-borgeres-cpr-oplysninger',
      title: "Denmark Data Breach Exposes 8.8M People's Personal Data",
      source: 'cpr.dk',
      publishedAt: '2026-10-05T08:09:36.000Z',
      snippet: null,
      lang: null,
      origin: 'hn',
    });
    expect(r.value.parsed[1]?.source).toBe('wieslawsoltes.github.io');
  });

  it('links text posts to the HN discussion', async () => {
    const r = await new HackerNewsAdapter({ userAgent: 'test', fetchImpl: recording(fixture('hackernews-front.json')).fetchImpl }).frontPage();
    const ask = r.ok ? r.value.parsed.find((i) => i.title.startsWith('Ask HN')) : undefined;
    expect(ask).toMatchObject({ url: 'https://news.ycombinator.com/item?id=37392676', source: 'Hacker News' });
  });

  it('skips untitled hits, treats unusable links as text posts, and honours the base override', async () => {
    const body = JSON.stringify({
      hits: [
        { objectID: '1', title: null, url: 'https://a.example', created_at: '2026-10-05T00:00:00Z' },
        { objectID: '2', title: 'Odd link', url: 'javascript:alert(1)', created_at: '2026-10-05T00:00:00Z' },
        { objectID: '3', title: 'Empty link', url: '', created_at: '2026-10-05T00:00:00Z' },
      ],
    });
    const rec = recording(body);
    const r = await new HackerNewsAdapter({ userAgent: 'test', fetchImpl: rec.fetchImpl, base: 'http://hn.test' }).frontPage();
    expect(rec.calls[0]?.url).toBe('http://hn.test/api/v1/search?tags=front_page&hitsPerPage=30');
    expect(r.ok && r.value.parsed.map((i) => [i.title, i.url])).toEqual([
      ['Odd link', 'https://news.ycombinator.com/item?id=2'],
      ['Empty link', 'https://news.ycombinator.com/item?id=3'],
    ]);
  });

  it('reports a changed payload as schema_changed', async () => {
    for (const body of ['{"results":[]}', '{"hits":[{"objectID":1,"title":"t","created_at":"2026-10-05T00:00:00Z"}]}', 'not json']) {
      const r = await new HackerNewsAdapter({ userAgent: 'test', fetchImpl: recording(body).fetchImpl }).frontPage();
      expect(r.ok ? 'ok' : r.error.code, body).toBe('schema_changed');
    }
  });
});
