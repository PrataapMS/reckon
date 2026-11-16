import type { TopicRef } from './topics';
import type { RawNewsItem } from './world-data';
import type { WatchList } from './world-templates';

/**
 * The deterministic parts of the news pipeline (spec §3.6): normalise, deduplicate, tag and
 * score relevance. News is evidence, never a resolution source (ADR-0005).
 */

/** Spec §3.6: store and show at most a short snippet. */
export const SNIPPET_MAX = 280;
/** Near-duplicate titles: SimHash within this Hamming distance inside the dedupe window. */
export const SIMHASH_MAX_DISTANCE = 3;
export const DEDUPE_WINDOW_HOURS = 48;
/** Spec §3.6 step 6: unlinked items are kept for 90 days. */
export const RETAIN_DAYS = 90;

const TRACKING_PARAMS = /^(utm_[a-z_]+|fbclid|gclid|mc_cid|mc_eid|ref|ref_src|cmpid|ocid|taid|at_medium|at_campaign|guccounter)$/i;

/** One URL per article: https, no `www.`, no fragment, no tracking parameters, no trailing slash. */
export function canonicalUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.protocol = 'https:';
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  u.hash = '';
  for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAMS.test(k)) u.searchParams.delete(k);
  u.searchParams.sort();
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
  return u.toString();
}

/** Collapse whitespace and cut to `max` characters on a word boundary. */
export function clip(text: string, max = SNIPPET_MAX): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s.,;:–-]+$/, '')}…`;
}

const STOPWORDS = new Set('a an and are as at be by for from has have in is it its of on or that the to was were will with after over new says'.split(' '));

function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = (1n << 64n) - 1n;

function fnv1a64(s: string): bigint {
  let h = FNV_OFFSET;
  for (const ch of new TextEncoder().encode(s)) {
    h ^= BigInt(ch);
    h = (h * FNV_PRIME) & MASK64;
  }
  return h;
}

/** 64-bit SimHash of a title (signed, so it fits a Postgres bigint). Similar titles differ in few bits. */
export function simhash(title: string): bigint {
  const words = tokens(title);
  const v = new Array<number>(64).fill(0);
  for (const w of words) {
    const h = fnv1a64(w);
    for (let i = 0; i < 64; i++) v[i] = (v[i] as number) + ((h >> BigInt(i)) & 1n ? 1 : -1);
  }
  let out = 0n;
  for (let i = 0; i < 64; i++) if ((v[i] as number) > 0) out |= 1n << BigInt(i);
  return BigInt.asIntN(64, out);
}

export function hamming(a: bigint, b: bigint): number {
  let x = BigInt.asUintN(64, a ^ b);
  let n = 0;
  while (x) {
    x &= x - 1n;
    n++;
  }
  return n;
}

export function isNearDuplicate(h: bigint, seen: readonly bigint[]): boolean {
  return seen.some((s) => hamming(h, s) <= SIMHASH_MAX_DISTANCE);
}

/** A deterministic tagging rule (spec §3.6 step 4): any keyword, and every `all` keyword if given. */
export interface TagRule {
  readonly tag: string;
  readonly any: readonly string[];
  readonly all?: readonly string[];
}

const OUTAGE_WORDS = ['outage', 'down', 'downtime', 'incident', 'disruption', 'degraded', 'goes dark', 'went down'];
const RELEASE_WORDS = ['release', 'released', 'releases', 'version', 'ships', 'launches', 'update'];

/** Rules for the world templates' questions, the watched repos and services, and the user's topics. */
export function tagRules(watch: WatchList, topics: readonly TopicRef[]): TagRule[] {
  return [
    { tag: 'quake', any: ['earthquake', 'earthquakes', 'quake', 'tremor', 'seismic', 'tsunami', 'usgs'] },
    {
      tag: 'space-weather',
      any: ['geomagnetic', 'solar storm', 'solar flare', 'aurora', 'auroras', 'northern lights', 'coronal mass ejection', 'space weather', 'swpc', 'kp index'],
    },
    { tag: 'fx:usdinr', any: ['rupee', 'usd/inr', 'usd-inr', 'forex reserves', 'reserve bank of india', 'rbi'] },
    ...watch.repos.map((r) => ({ tag: `repo:${r.repo}`, any: [...r.keywords, r.repo.toLowerCase()], all: RELEASE_WORDS })),
    ...watch.services.map((s) => ({ tag: `status:${s.host}`, any: s.keywords, all: OUTAGE_WORDS })),
    ...topics.map((t) => ({ tag: `topic:${t.id}`, any: t.keywords })),
  ];
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const patterns = new Map<string, RegExp>();
/** Whole-word, case-insensitive match, so 'ai' never matches 'said'. */
function mentions(text: string, phrase: string): boolean {
  let re = patterns.get(phrase);
  if (!re) {
    re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(phrase.toLowerCase())}(?![\\p{L}\\p{N}])`, 'iu');
    patterns.set(phrase, re);
  }
  return re.test(text);
}

export function matches(rule: TagRule, text: string): boolean {
  return rule.any.some((k) => mentions(text, k)) && (rule.all ? rule.all.some((k) => mentions(text, k)) : true);
}

export function tagItem(title: string, snippet: string | null, rules: readonly TagRule[]): string[] {
  const text = `${title}\n${snippet ?? ''}`;
  return rules.filter((r) => matches(r, text)).map((r) => r.tag);
}

/** Spec §3.6 step 2: a raw headline as a normalised item, or null if it cannot be one. */
export function normalizeNews(raw: RawNewsItem, fetchedAt: Date, rules: readonly TagRule[]) {
  const canonical = canonicalUrl(raw.url);
  const title = clip(raw.title, 300);
  if (!canonical || !title) return null;
  const published = raw.publishedAt ? new Date(raw.publishedAt) : fetchedAt;
  // A feed's future dates are typos; clamp so they cannot jump the queue.
  const publishedAt = Number.isNaN(published.getTime()) || published > fetchedAt ? fetchedAt : published;
  const snippet = raw.snippet ? clip(raw.snippet) : null;
  return {
    url: raw.url,
    canonicalUrl: canonical,
    title,
    source: clip(raw.source, 80),
    publishedAt,
    snippet: snippet || null,
    lang: raw.lang,
    origin: raw.origin,
    simhash: simhash(title),
    tags: tagItem(title, snippet, rules),
  };
}

/**
 * How relevant a headline is to a question it shares a tag with (0..1): higher when the tag
 * matched in the title, and fading for news older than the question's window.
 */
export function relevance(item: { readonly title: string; readonly publishedAt: Date }, rule: TagRule | undefined, windowStart: Date): number {
  const inTitle = rule ? matches(rule, item.title) : false;
  const ageDays = Math.max(0, (windowStart.getTime() - item.publishedAt.getTime()) / 86_400_000);
  const score = (inTitle ? 0.8 : 0.5) * Math.exp(-ageDays / 7);
  return Math.round(Math.min(1, score) * 100) / 100;
}

/**
 * Default feeds (closes the roadmap's open decision; ADR-0009). Kept only where the publisher's
 * terms allow personal, non-commercial display of headline, link and a short snippet. Ars Technica
 * (no automated caching) and The Hindu (no caching) were checked and left out.
 */
export const DEFAULT_FEEDS: readonly { readonly id: string; readonly url: string; readonly name: string }[] = [
  { id: 'bbc-world', url: 'https://feeds.bbci.co.uk/news/world/rss.xml', name: 'BBC News' },
  { id: 'bbc-tech', url: 'https://feeds.bbci.co.uk/news/technology/rss.xml', name: 'BBC News' },
  { id: 'nasa', url: 'https://www.nasa.gov/news-release/feed/', name: 'NASA' },
  { id: 'verge', url: 'https://www.theverge.com/rss/index.xml', name: 'The Verge' },
];

/** GDELT searches that bring in evidence for the world templates' own questions. */
export function evidenceQueries(watch: WatchList): string[] {
  return [
    'earthquake magnitude',
    '("geomagnetic storm" OR aurora OR "solar flare")',
    '(rupee dollar)',
    ...watch.repos.map((r) => `"${r.label}" release`),
    ...watch.services.map((s) => `"${s.label}" outage`),
  ];
}
