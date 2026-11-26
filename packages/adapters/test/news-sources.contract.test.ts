import type { Result, SourceError } from '@reckon/core';
import { describe, expect, it, type TestContext } from 'vitest';
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

/** Errors that say GDELT is busy or unreachable, not that its contract changed. */
const UNAVAILABLE = new Set(['rate_limited', 'timeout', 'network', 'upstream_5xx']);
const BACKOFF_MS = [15_000, 30_000];
// Three attempts at up to 12 s each, plus backoff and the politeness gap.
const GDELT_TEST_TIMEOUT_MS = 120_000;

/**
 * GDELT throttles shared egress IPs (GitHub runners included) and often times out. Retry with backoff;
 * if it is still unavailable, skip with the reason instead of failing, so only a real contract change
 * (schema_changed, not_found) turns the nightly run red. Production source health still tracks outages.
 */
async function gdeltOrSkip<T>(ctx: TestContext, call: () => Promise<Result<T, SourceError>>): Promise<Result<T, SourceError>> {
  let r = await call();
  for (const wait of BACKOFF_MS) {
    if (r.ok || !UNAVAILABLE.has(r.error.code)) return r;
    await new Promise((res) => setTimeout(res, wait));
    r = await call();
  }
  if (!r.ok && UNAVAILABLE.has(r.error.code)) ctx.skip(`GDELT unavailable after ${BACKOFF_MS.length + 1} attempts: ${r.error.code}`);
  return r;
}

describe.runIf(live)('GDELT DOC 2.0 live contract', () => {
  // One instance, so its own politeness gap spaces the requests.
  const gdelt = new GdeltAdapter({ userAgent: ua, minIntervalMs: 6_000 });

  it('timeline still returns daily volume', { timeout: GDELT_TEST_TIMEOUT_MS }, async (ctx) => {
    const r = await gdeltOrSkip(ctx, () => gdelt.dailyVolume({ query: '"climate change"', start: day(-7), end: day(-1) }));
    expect(r.ok, r.ok ? '' : JSON.stringify(r.error)).toBe(true);
    if (r.ok) expect(r.value.parsed).toHaveLength(7);
  });

  it('article list still maps to headlines', { timeout: GDELT_TEST_TIMEOUT_MS }, async (ctx) => {
    const r = await gdeltOrSkip(ctx, () => gdelt.articles({ query: '"climate change"', hours: 24, max: 10 }));
    expect(r.ok, r.ok ? '' : JSON.stringify(r.error)).toBe(true);
    if (r.ok) expect(r.value.parsed.length).toBeGreaterThan(0);
  });
});
