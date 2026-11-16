import { describe, expect, it } from 'vitest';
import { GdeltAdapter } from '../src/sources/gdelt';
import { FeedAdapter } from '../src/sources/rss';

/**
 * Live contract tests for the news sources: hit the real endpoints. Run nightly (`pnpm test:contracts`),
 * never in the unit run. GDELT throttles shared egress IPs hard, so a rate_limited failure there may be
 * the network rather than a contract change; see gdelt/SOURCE.md.
 */
const live = process.env.RECKON_LIVE === '1';
const ua = `Reckon/0.1 (contract test; ${process.env.CONTACT_EMAIL ?? 'unknown'})`;
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

const FEEDS = [
  { id: 'bbc-world', url: 'https://feeds.bbci.co.uk/news/world/rss.xml', name: 'BBC News' },
  { id: 'bbc-technology', url: 'https://feeds.bbci.co.uk/news/technology/rss.xml', name: 'BBC News' },
  { id: 'hindu-economy', url: 'https://www.thehindu.com/business/Economy/feeder/default.rss', name: 'The Hindu' },
  { id: 'ars-technica', url: 'https://feeds.arstechnica.com/arstechnica/index', name: 'Ars Technica' },
  { id: 'nasa-news', url: 'https://www.nasa.gov/news-release/feed/', name: 'NASA' },
  { id: 'verge', url: 'https://www.theverge.com/rss/index.xml', name: 'The Verge' },
] as const;

describe.runIf(live)('RSS / Atom feeds live contract', () => {
  const adapter = new FeedAdapter({ userAgent: ua });
  for (const feed of FEEDS) {
    it(`${feed.id} still parses into headlines`, async () => {
      const r = await adapter.fetchFeed(feed, { etag: null, lastModified: null });
      expect(r.ok, r.ok ? '' : JSON.stringify(r.error)).toBe(true);
      if (!r.ok || r.value.notModified) return;
      expect(r.value.snapshot.parsed.length).toBeGreaterThan(0);
      expect(r.value.snapshot.parsed.every((i) => i.title && /^https?:\/\//.test(i.url))).toBe(true);
      expect(r.value.snapshot.parsed.some((i) => i.publishedAt !== null)).toBe(true);
    });
  }
});

describe.runIf(live)('GDELT DOC 2.0 live contract', () => {
  // One instance, so its own politeness gap spaces the two requests.
  const gdelt = new GdeltAdapter({ userAgent: ua, minIntervalMs: 6_000 });

  it('timeline still returns daily volume', { timeout: 30_000 }, async () => {
    const r = await gdelt.dailyVolume({ query: '"climate change"', start: day(-7), end: day(-1) });
    expect(r.ok, r.ok ? '' : JSON.stringify(r.error)).toBe(true);
    if (r.ok) expect(r.value.parsed).toHaveLength(7);
  });

  it('article list still maps to headlines', { timeout: 30_000 }, async () => {
    const r = await gdelt.articles({ query: '"climate change"', hours: 24, max: 10 });
    expect(r.ok, r.ok ? '' : JSON.stringify(r.error)).toBe(true);
    if (r.ok) expect(r.value.parsed.length).toBeGreaterThan(0);
  });
});
