import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalUrl, clip, hamming, isNearDuplicate, normalizeNews, relevance, simhash, tagItem, tagRules } from '../src/domain/news';
import { cityTopic, customTopic } from '../src/domain/topics';
import { DEFAULT_WATCH } from '../src/domain/world-templates';

describe('canonical URLs', () => {
  it('collapse tracking, fragments, www and trailing slashes into one article', () => {
    expect(canonicalUrl('http://www.Example.com/news/story/?utm_source=x&b=2&a=1#top')).toBe('https://example.com/news/story?a=1&b=2');
    expect(canonicalUrl('https://example.com/')).toBe('https://example.com/');
    expect(canonicalUrl('javascript:alert(1)')).toBeNull();
    expect(canonicalUrl('not a url')).toBeNull();
  });
});

describe('near-duplicate titles', () => {
  it('give similar titles similar fingerprints', () => {
    const a = simhash('Strong earthquake shakes coastal towns in Japan');
    expect(hamming(a, simhash('Strong earthquake shakes coastal towns in Japan!'))).toBe(0);
    expect(isNearDuplicate(simhash('Rupee slips against the dollar as oil rises'), [a])).toBe(false);
  });

  it('fit a signed 64-bit integer, and Hamming distance is a metric', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (x, y) => {
        const a = simhash(x);
        const b = simhash(y);
        expect(a).toBeGreaterThanOrEqual(-(2n ** 63n));
        expect(a).toBeLessThan(2n ** 63n);
        expect(hamming(a, a)).toBe(0);
        expect(hamming(a, b)).toBe(hamming(b, a));
      }),
    );
  });
});

describe('tagging', () => {
  const rules = tagRules(DEFAULT_WATCH, [{ id: 't-ai', label: 'AI', query: null, keywords: ['ai'] }]);

  it('matches whole words only', () => {
    expect(tagItem('Officials said the AI model was paused', null, rules)).toContain('topic:t-ai');
    expect(tagItem('Officials said the plan was paused', null, rules)).not.toContain('topic:t-ai');
  });

  it('needs an outage word for a status tag and a release word for a repo tag', () => {
    expect(tagItem('GitHub outage disrupts pull requests', null, rules)).toContain('status:www.githubstatus.com');
    expect(tagItem('GitHub hires a new CEO', null, rules)).not.toContain('status:www.githubstatus.com');
    expect(tagItem('Node.js 26 release brings faster startup', null, rules)).toContain('repo:nodejs/node');
    expect(tagItem('Magnitude 6.6 quake strikes offshore', 'USGS said', rules)).toContain('quake');
  });
});

describe('normalising a headline', () => {
  it('clips the snippet, clamps future dates and tags it', () => {
    const now = new Date('2026-10-05T10:00:00Z');
    const n = normalizeNews(
      {
        url: 'https://www.bbc.co.uk/news/x?at_medium=RSS',
        title: '  Aurora  visible tonight ',
        source: 'BBC News',
        publishedAt: '2027-01-01T00:00:00Z',
        snippet: 'word '.repeat(100),
        lang: 'en',
        origin: 'rss',
      },
      now,
      tagRules(DEFAULT_WATCH, []),
    );
    expect(n?.canonicalUrl).toBe('https://bbc.co.uk/news/x');
    expect(n?.title).toBe('Aurora visible tonight');
    expect(n?.publishedAt).toEqual(now);
    expect(n?.snippet?.length).toBeLessThanOrEqual(280);
    expect(n?.snippet?.endsWith('…')).toBe(true);
    expect(n?.tags).toEqual(['space-weather']);
    expect(clip('short')).toBe('short');
  });

  it('scores title matches above snippet matches, fading with age', () => {
    const rule = { tag: 'quake', any: ['earthquake'] };
    const start = new Date('2026-10-05T00:00:00Z');
    const fresh = relevance({ title: 'Earthquake hits', publishedAt: start }, rule, start);
    const snippetOnly = relevance({ title: 'Tremor news', publishedAt: start }, rule, start);
    const old = relevance({ title: 'Earthquake hits', publishedAt: new Date('2026-09-28T00:00:00Z') }, rule, start);
    expect(fresh).toBe(0.8);
    expect(snippetOnly).toBe(0.5);
    expect(old).toBeLessThan(fresh);
  });
});

describe('topics', () => {
  it('turn a real place name into a topic, but not a role like Home', () => {
    expect(cityTopic('Bengaluru')?.query).toBe('"Bengaluru"');
    expect(cityTopic('Home')).toBeNull();
    expect(customTopic('AI').query).toBeNull(); // too short for GDELT
    expect(customTopic('  space   weather ').query).toBe('"space weather"');
  });
});
