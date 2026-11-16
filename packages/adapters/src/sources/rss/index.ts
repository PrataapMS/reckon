import { err, type FeedFetch, type FeedPort, type FeedRef, ok, type RawNewsItem, type Result, type SourceError } from '@reckon/core';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { type FetchLike, httpGet } from '../http';

/** RSS 2.0 and Atom feeds. Default feeds and their reuse terms are recorded in SOURCE.md. */

const SOURCE_ID = 'rss';
const ACCEPT = 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8';
const MAX_ITEMS = 100;
export const SNIPPET_MAX = 280;

export interface FeedOptions {
  readonly userAgent: string;
  readonly fetchImpl?: FetchLike;
  readonly now?: () => Date;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // Keep every value a string: a headline like "2026" must not become a number.
  parseTagValue: false,
  parseAttributeValue: false,
  // Only the XML built-ins and small internal DOCTYPE entities expand; external entities throw (and become schema_changed).
  processEntities: { enabled: true, maxEntitySize: 1_000, maxEntityCount: 20, maxTotalExpansions: 100, maxExpandedLength: 10_000 },
  htmlEntities: false,
});

type Node = Record<string, unknown>;

const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null && !Array.isArray(v);
const asArray = (v: unknown): unknown[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

/** Text of an element that may carry attributes (`{ '#text', '@_type' }`) or repeat. */
function text(v: unknown): string | null {
  if (Array.isArray(v)) return text(v[0]);
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (isNode(v)) return text(v['#text']);
  return null;
}

const HTTP_URL = /^https?:\/\//i;

const NAMED: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  copy: '©',
  reg: '®',
  trade: '™',
};

/** One decoding pass for the HTML entities that survive XML parsing (CDATA content, `&#8217;` and friends). */
export function decodeEntities(s: string): string {
  return s.replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]{2,8});/gi, (m, e: string) => {
    if (e.startsWith('#')) {
      const cp = e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

/** HTML fragment to plain text: tags out, entities decoded, whitespace collapsed. */
export function plainText(html: string): string {
  // Block tags separate words; inline tags (<em>, <a>) sit inside them.
  const noTags = html
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<\/?(p|br|hr|div|li|ul|ol|h[1-6]|table|tr|td|th|blockquote|pre|figure|figcaption|section|article|header|footer)\b[^>]*>/gi, ' ')
    .replace(/<[a-z/!][^>]*>/gi, '');
  return decodeEntities(noTags).replace(/\s+/g, ' ').trim();
}

/** At most `max` characters, cut at a word boundary, with an ellipsis when anything was dropped. */
export function snippet(html: string, max = SNIPPET_MAX): string | null {
  // WordPress ends excerpts with "[…]"; treat it as truncation rather than content.
  let s = plainText(html);
  const trailer = /\s*\[(…|\.\.\.)\]$/.exec(s);
  if (trailer) s = `${s.slice(0, trailer.index)}…`;
  if (!s || s === '…') return null;
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.–—-]+$/, '')}…`;
}

function isoOrNull(v: unknown): string | null {
  const s = text(v)?.trim();
  if (!s) return null;
  const t = Date.parse(s); // V8 reads both RFC 822 (RSS) and RFC 3339 (Atom)
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function rssLink(item: Node): string | null {
  for (const l of asArray(item.link)) {
    const s = text(l)?.trim();
    if (s && HTTP_URL.test(s)) return s;
  }
  // A permalink guid is the article URL when <link> is missing.
  const guid = asArray(item.guid)[0];
  const permalink = !isNode(guid) || guid['@_isPermaLink'] !== 'false';
  const g = text(guid)?.trim();
  return permalink && g && HTTP_URL.test(g) ? g : null;
}

function atomLink(entry: Node): string | null {
  const links = asArray(entry.link).filter(isNode);
  const preferred = links.filter((l) => l['@_rel'] === undefined || l['@_rel'] === 'alternate');
  for (const l of [...preferred, ...links]) {
    const href = typeof l['@_href'] === 'string' ? l['@_href'].trim() : '';
    if (HTTP_URL.test(href)) return href;
  }
  return null;
}

function item(title: unknown, url: string | null, publishedAt: string | null, summary: unknown, feed: FeedRef, lang: string | null): RawNewsItem | null {
  const t = plainText(text(title) ?? '');
  if (!t || !url) return null;
  const body = text(summary);
  return { url, title: t, source: feed.name, publishedAt, snippet: body ? snippet(body) : null, lang, origin: 'rss' };
}

/** Parse an RSS 2.0 or Atom document into headlines. Anything else is schema_changed. */
export function parseFeed(xml: string, feed: FeedRef): Result<RawNewsItem[], SourceError> {
  const fail = (detail: string) => err<SourceError>({ code: 'schema_changed', sourceId: SOURCE_ID, detail: `${feed.id}: ${detail}`.slice(0, 500) });
  const valid = XMLValidator.validate(xml);
  if (valid !== true) return fail(`invalid XML at line ${valid.err.line}: ${valid.err.msg}`);
  let doc: unknown;
  try {
    doc = parser.parse(xml);
  } catch (e) {
    return fail(`unparseable XML: ${String(e)}`);
  }
  if (!isNode(doc)) return fail('empty document');

  const rss = isNode(doc.rss) ? doc.rss : null;
  const channel = rss ? asArray(rss.channel).find(isNode) : undefined;
  if (rss) {
    if (!channel) return fail('rss without channel');
    const lang = text(channel.language)?.trim() || null;
    const items = asArray(channel.item).filter(isNode).slice(0, MAX_ITEMS);
    return ok(
      items.map((i) => item(i.title, rssLink(i), isoOrNull(i.pubDate ?? i['dc:date']), i.description, feed, lang)).filter((i): i is RawNewsItem => i !== null),
    );
  }

  if (isNode(doc.feed)) {
    const atom = doc.feed;
    const lang = (typeof atom['@_xml:lang'] === 'string' && atom['@_xml:lang'].trim()) || null;
    const entries = asArray(atom.entry).filter(isNode).slice(0, MAX_ITEMS);
    return ok(
      entries
        .map((e) => item(e.title, atomLink(e), isoOrNull(e.published ?? e.updated), e.summary ?? e.content, feed, lang))
        .filter((i): i is RawNewsItem => i !== null),
    );
  }
  return fail('neither an RSS nor an Atom document');
}

export class FeedAdapter implements FeedPort {
  static readonly id = SOURCE_ID;
  constructor(private readonly o: FeedOptions) {}

  async fetchFeed(feed: FeedRef, cache: { readonly etag: string | null; readonly lastModified: string | null }): Promise<Result<FeedFetch, SourceError>> {
    const headers: Record<string, string> = {};
    if (cache.etag) headers['If-None-Match'] = cache.etag;
    if (cache.lastModified) headers['If-Modified-Since'] = cache.lastModified;
    const res = await httpGet(feed.url, {
      sourceId: SOURCE_ID,
      userAgent: this.o.userAgent,
      accept: ACCEPT,
      headers,
      ...(this.o.fetchImpl ? { fetchImpl: this.o.fetchImpl } : {}),
    });
    if (!res.ok) return err({ ...res.error, detail: res.error.detail ? `${feed.id}: ${res.error.detail}` : feed.id });
    if (res.value.status === 304) return ok({ notModified: true });
    const parsed = parseFeed(res.value.text, feed);
    if (!parsed.ok) return parsed;
    return ok({
      notModified: false,
      snapshot: {
        sourceId: SOURCE_ID,
        fetchedAt: (this.o.now?.() ?? new Date()).toISOString(),
        requestUrl: feed.url,
        raw: res.value.text,
        parsed: parsed.value,
        contentType: res.value.contentType ?? 'application/xml',
      },
      etag: res.value.headers.get('etag'),
      lastModified: res.value.headers.get('last-modified'),
    });
  }
}
