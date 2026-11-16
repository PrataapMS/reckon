import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GdeltAdapter } from '../src/sources/gdelt';
import type { FetchLike } from '../src/sources/http';
import { FeedAdapter, parseFeed, snippet } from '../src/sources/rss';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

interface Reply {
  readonly body: string;
  readonly status?: number;
  readonly headers?: Record<string, string>;
}
function recording(...replies: Reply[]) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
    const r = replies[Math.min(calls.length - 1, replies.length - 1)] ?? { body: '' };
    // Bytes rather than a string, so Response adds no content-type of its own.
    return new Response(r.status === 304 ? null : new TextEncoder().encode(r.body), { status: r.status ?? 200, headers: r.headers ?? {} });
  };
  return { calls, fetchImpl };
}

const fixedNow = () => new Date('2026-10-05T12:00:00Z');
const noSleep = async () => {};
function gdelt(...replies: Reply[]) {
  const rec = recording(...replies);
  const sleeps: number[] = [];
  const adapter = new GdeltAdapter({
    userAgent: 'test',
    fetchImpl: rec.fetchImpl,
    now: fixedNow,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { adapter, sleeps, ...rec };
}

describe('GdeltAdapter.dailyVolume (synthetic fixture)', () => {
  it('sums sub-daily buckets per UTC date and zero-fills days without buckets', async () => {
    const g = gdelt({ body: fixture('gdelt-timeline.json') });
    const r = await g.adapter.dailyVolume({ query: '"monsoon" sourcecountry:india', start: '2026-10-01', end: '2026-10-04' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.parsed).toEqual([
      { date: '2026-10-01', count: 24 },
      { date: '2026-10-02', count: 0 },
      { date: '2026-10-03', count: 34 },
      { date: '2026-10-04', count: 9 },
    ]);
    expect(r.value.sourceId).toBe('gdelt.doc');
    expect(r.value.fetchedAt).toBe('2026-10-05T12:00:00.000Z');
    const url = new URL(g.calls[0]?.url ?? '');
    expect(url.origin + url.pathname).toBe('https://api.gdeltproject.org/api/v2/doc/doc');
    expect(url.searchParams.get('mode')).toBe('timelinevolraw');
    expect(url.searchParams.get('format')).toBe('json');
    expect(url.searchParams.get('startdatetime')).toBe('20261001000000');
    expect(url.searchParams.get('enddatetime')).toBe('20261004235959');
    expect(url.searchParams.get('query')).toBe('"monsoon" sourcecountry:india');
  });

  it('returns no points (not zeros) when the timeline is empty or missing', async () => {
    for (const body of ['{"query_details":{},"timeline":[]}', '{"timeline":[{"series":"Article Count","data":[]}]}', '{}', '']) {
      const r = await gdelt({ body }).adapter.dailyVolume({ query: 'x y', start: '2026-10-01', end: '2026-10-03' });
      expect(r.ok && r.value.parsed, body).toEqual([]);
    }
  });

  it('reports schema_changed when the timeline shape changes', async () => {
    const r = await gdelt({ body: '{"timeline":[{"data":[{"date":"2026-10-01","value":"3"}]}]}' }).adapter.dailyVolume({
      query: 'x y',
      start: '2026-10-01',
      end: '2026-10-01',
    });
    expect(r.ok ? 'ok' : r.error.code).toBe('schema_changed');
  });
});

describe('GdeltAdapter.articles (synthetic fixture)', () => {
  it('maps the article list to raw news items', async () => {
    const g = gdelt({ body: fixture('gdelt-artlist.json') });
    const r = await g.adapter.articles({ query: 'repo rate', hours: 24, max: 500 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.parsed).toHaveLength(3);
    expect(r.value.parsed[0]).toEqual({
      url: 'https://www.example-news.in/business/rbi-holds-repo-rate-2026-10-05',
      title: 'RBI holds repo rate steady as inflation eases',
      source: 'example-news.in',
      publishedAt: '2026-10-05T10:30:00.000Z',
      snippet: null,
      lang: 'English',
      origin: 'gdelt',
    });
    expect(r.value.parsed[2]?.publishedAt).toBeNull();
    const url = new URL(g.calls[0]?.url ?? '');
    expect(url.searchParams.get('mode')).toBe('artlist');
    expect(url.searchParams.get('maxrecords')).toBe('250');
    expect(url.searchParams.get('timespan')).toBe('24h');
    expect(url.searchParams.get('sort')).toBe('datedesc');
  });

  it('treats {} and an empty body as zero articles', async () => {
    for (const body of ['{}', '', '  \n']) {
      const r = await gdelt({ body }).adapter.articles({ query: 'nothing matches this', hours: 6, max: 10 });
      expect(r.ok && r.value.parsed, JSON.stringify(body)).toEqual([]);
    }
  });

  it('maps HTTP 429 to rate_limited', async () => {
    const r = await gdelt({
      body: 'Please limit requests to one every 5 seconds or contact kalev.leetaru5@gmail.com for larger queries.',
      status: 429,
    }).adapter.articles({
      query: 'x y',
      hours: 6,
      max: 10,
    });
    expect(r.ok ? 'ok' : r.error.code).toBe('rate_limited');
  });

  it('turns a plain-text error with HTTP 200 into schema_changed carrying the message', async () => {
    const r = await gdelt({ body: 'The specified phrase is too short.' }).adapter.articles({ query: '"a"', hours: 6, max: 10 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatchObject({ code: 'schema_changed', sourceId: 'gdelt.doc', detail: 'The specified phrase is too short.' });
  });
});

describe('GdeltAdapter politeness', () => {
  it('waits out the rest of the 5 s gap before the next request', async () => {
    let t = Date.parse('2026-10-05T12:00:00Z');
    const rec = recording({ body: '{}' });
    const sleeps: number[] = [];
    const adapter = new GdeltAdapter({
      userAgent: 'test',
      fetchImpl: rec.fetchImpl,
      now: () => new Date(t),
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
    });
    await adapter.articles({ query: 'x y', hours: 1, max: 1 });
    expect(sleeps).toEqual([]);
    t += 2_000;
    await adapter.articles({ query: 'x y', hours: 1, max: 1 });
    expect(sleeps).toEqual([3_000]);
    t += 6_000;
    await adapter.dailyVolume({ query: 'x y', start: '2026-10-01', end: '2026-10-01' });
    expect(sleeps).toEqual([3_000]);
    expect(rec.calls).toHaveLength(3);
  });

  it('spaces concurrent calls and honours a custom interval', async () => {
    const rec = recording({ body: '{}' });
    const sleeps: number[] = [];
    const adapter = new GdeltAdapter({
      userAgent: 'test',
      fetchImpl: rec.fetchImpl,
      now: fixedNow,
      minIntervalMs: 1_000,
      sleep: async (ms) => void sleeps.push(ms),
    });
    await Promise.all([1, 2, 3].map(() => adapter.articles({ query: 'x y', hours: 1, max: 1 })));
    expect(sleeps).toEqual([1_000, 2_000]);
  });

  it('can be made instant for tests', async () => {
    const adapter = new GdeltAdapter({ userAgent: 'test', fetchImpl: recording({ body: '{}' }).fetchImpl, minIntervalMs: 0, sleep: noSleep });
    await adapter.articles({ query: 'x y', hours: 1, max: 1 });
    const r = await adapter.articles({ query: 'x y', hours: 1, max: 1 });
    expect(r.ok).toBe(true);
  });
});

const bbc = { id: 'bbc-world', url: 'https://feeds.bbci.co.uk/news/world/rss.xml', name: 'BBC News' };
const verge = { id: 'verge', url: 'https://www.theverge.com/rss/index.xml', name: 'The Verge' };
const noCache = { etag: null, lastModified: null };

describe('FeedAdapter (recorded BBC RSS and Verge Atom fixtures)', () => {
  it('parses RSS 2.0 items with source, ISO time, snippet and channel language', async () => {
    const rec = recording({
      body: fixture('rss-bbc-world.xml'),
      headers: { 'content-type': 'text/xml; charset=utf-8', etag: '"abc"', 'last-modified': 'Mon, 05 Oct 2026 18:03:40 GMT' },
    });
    const r = await new FeedAdapter({ userAgent: 'test', fetchImpl: rec.fetchImpl, now: fixedNow }).fetchFeed(bbc, noCache);
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.notModified) return;
    const { snapshot, etag, lastModified } = r.value;
    expect(snapshot.parsed).toHaveLength(3);
    expect(snapshot.parsed[0]).toEqual({
      url: 'https://www.bbc.co.uk/news/articles/cmy56yvv1kxxo?at_medium=RSS&at_campaign=rss',
      title: 'No10 insists UK military base RAF Fairford is safe after US withdraws bombers',
      source: 'BBC News',
      publishedAt: '2026-10-05T16:13:35.000Z',
      snippet: 'US media reported a new threat led to the bombers being removed on Sunday, following an incident near the base last week.',
      lang: 'en-gb',
      origin: 'rss',
    });
    expect(snapshot).toMatchObject({ sourceId: 'rss', requestUrl: bbc.url, contentType: 'text/xml; charset=utf-8', fetchedAt: '2026-10-05T12:00:00.000Z' });
    expect(snapshot.raw).toContain('<rss');
    expect(etag).toBe('"abc"');
    expect(lastModified).toBe('Mon, 05 Oct 2026 18:03:40 GMT');
    expect(rec.calls[0]?.headers.Accept).toBe('application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8');
    expect(rec.calls[0]?.headers['If-None-Match']).toBeUndefined();
  });

  it('parses Atom entries: html titles, alternate links, published time, summary over content', async () => {
    const rec = recording({ body: fixture('atom-verge.xml') });
    const r = await new FeedAdapter({ userAgent: 'test', fetchImpl: rec.fetchImpl }).fetchFeed(verge, noCache);
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.notModified) return;
    const items = r.value.snapshot.parsed;
    expect(items).toHaveLength(3);
    expect(items[0]?.title).toBe('OpenAI PR tells journalist to ‘move on’ while asking Sam Altman about a ChatGPT user’s suicide');
    expect(items[0]?.url).toBe('https://www.theverge.com/ai-artificial-intelligence/1004827/openai-sam-altman-vanity-fair-interview-pr');
    expect(items[0]?.publishedAt).toBe('2026-10-05T16:55:42.000Z');
    expect(items[0]?.lang).toBe('en-US');
    expect(items[0]?.source).toBe('The Verge');
    expect(items[0]?.snippet?.length).toBeLessThanOrEqual(280);
    expect(items[0]?.snippet).toMatch(/^An OpenAI publicist tried/);
    expect(items[0]?.snippet).toMatch(/…$/);
    expect(items[0]?.snippet).not.toMatch(/\[|&#/);
    expect(r.value.snapshot.contentType).toBe('application/xml');
    expect(r.value.etag).toBeNull();
  });

  it('sends conditional headers and reports 304 as notModified', async () => {
    const rec = recording({ body: '', status: 304 });
    const r = await new FeedAdapter({ userAgent: 'test', fetchImpl: rec.fetchImpl }).fetchFeed(bbc, {
      etag: '"v1"',
      lastModified: 'Mon, 05 Oct 2026 18:03:40 GMT',
    });
    expect(r.ok && r.value).toEqual({ notModified: true });
    expect(rec.calls[0]?.headers['If-None-Match']).toBe('"v1"');
    expect(rec.calls[0]?.headers['If-Modified-Since']).toBe('Mon, 05 Oct 2026 18:03:40 GMT');
  });

  it('reports malformed or non-feed XML as schema_changed', async () => {
    for (const body of [
      '<rss><channel><item><title>x</channel></rss>',
      fixture('rss-bbc-world.xml').slice(0, 1500),
      '<html><body>Gone fishing</body></html>',
      'not xml',
    ]) {
      const r = await new FeedAdapter({ userAgent: 'test', fetchImpl: recording({ body }).fetchImpl }).fetchFeed(bbc, noCache);
      expect(r.ok ? 'ok' : r.error.code, body.slice(0, 40)).toBe('schema_changed');
      if (!r.ok) expect(r.error.detail).toMatch(/^bbc-world: /);
    }
  });

  it('maps HTTP errors through httpGet with the feed id in the detail', async () => {
    const r = await new FeedAdapter({ userAgent: 'test', fetchImpl: recording({ body: 'nope', status: 404 }).fetchImpl }).fetchFeed(bbc, noCache);
    expect(r.ok ? 'ok' : r.error).toEqual({ code: 'not_found', sourceId: 'rss', detail: 'bbc-world' });
  });
});

describe('parseFeed', () => {
  const ref = { id: 't', url: 'https://example.com/feed', name: 'Example' };

  it('skips items without a title or an http(s) link and falls back to a permalink guid', () => {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>
      <item><title>No link</title></item>
      <item><title>Bad scheme</title><link>javascript:alert(1)</link></item>
      <item><link>https://example.com/untitled</link></item>
      <item><title>Guid only</title><guid>https://example.com/guid</guid><pubDate>garbage</pubDate></item>
      <item><title>Opaque guid</title><guid isPermaLink="false">https://example.com/opaque</guid></item>
      <item><title>2026</title><link>https://example.com/numeric</link><description>&lt;p&gt;Escaped &amp;amp; &lt;b&gt;bold&lt;/b&gt;&lt;/p&gt;</description></item>
    </channel></rss>`;
    const r = parseFeed(xml, ref);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.map((i) => i.title)).toEqual(['Guid only', '2026']);
    expect(r.value[0]).toMatchObject({ url: 'https://example.com/guid', publishedAt: null, snippet: null, lang: null });
    expect(r.value[1]?.snippet).toBe('Escaped & bold');
  });

  it('caps a feed at 100 items', () => {
    const items = Array.from({ length: 150 }, (_, i) => `<item><title>n${i}</title><link>https://example.com/${i}</link></item>`).join('');
    const r = parseFeed(`<rss><channel>${items}</channel></rss>`, ref);
    expect(r.ok && r.value.length).toBe(100);
  });

  it('prefers the alternate Atom link over self and enclosure links', () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title type="text">A</title>
      <link rel="self" href="https://example.com/self"/><link rel="alternate" href="https://example.com/a"/>
      <updated>2026-10-05T10:00:00Z</updated><content type="html">&lt;p&gt;Body&lt;/p&gt;</content></entry></feed>`;
    const r = parseFeed(xml, ref);
    expect(r.ok && r.value[0]).toMatchObject({ url: 'https://example.com/a', publishedAt: '2026-10-05T10:00:00.000Z', snippet: 'Body' });
  });

  it('does not expand entity bombs or external entities', () => {
    const lol = `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY a "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">]><rss><channel><item><title>${'&a;'.repeat(500)}</title><link>https://example.com/x</link></item></channel></rss>`;
    expect(parseFeed(lol, ref).ok).toBe(false);
    const xxe = `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss><channel><item><title>&x;</title><link>https://example.com/x</link></item></channel></rss>`;
    const r = parseFeed(xxe, ref);
    expect(r.ok ? JSON.stringify(r.value) : r.error.code).not.toContain('root:');
  });
});

describe('snippet', () => {
  it('strips tags and entities and collapses whitespace', () => {
    expect(snippet('<p>Hello&nbsp;<em>world</em>&#8217;s\n\n  <a href="x">news</a> &amp; more</p><script>alert(1)</script>')).toBe('Hello world’s news & more');
  });

  it('truncates to 280 characters on a word boundary with an ellipsis', () => {
    const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ');
    const s = snippet(long) ?? '';
    expect(s.length).toBeLessThanOrEqual(280);
    expect(s.endsWith('…')).toBe(true);
    expect(long.startsWith(s.slice(0, -1))).toBe(true);
    expect(long[s.length - 1]).toBe(' ');
  });

  it('turns a WordPress "[…]" trailer into an ellipsis and returns null for empty text', () => {
    expect(snippet('The story continues [&#8230;]')).toBe('The story continues…');
    expect(snippet('<p> </p>')).toBeNull();
  });
});
