import { type HackerNewsPort, ok, type RawNewsItem, type Result, type SourceError, type SourceSnapshot } from '@reckon/core';
import { z } from 'zod';
import { type FetchLike, httpGetText } from '../http';
import { parse } from '../parse';

/**
 * Hacker News front page via the Algolia HN Search API: one call instead of the official
 * Firebase API's id list plus one request per item. See SOURCE.md in this folder.
 */

export interface HackerNewsOptions {
  readonly userAgent: string;
  readonly fetchImpl?: FetchLike;
  readonly now?: () => Date;
  /** Replaces `https://hn.algolia.com` (tests). */
  readonly base?: string;
}

const BASE = 'https://hn.algolia.com';
const ITEM_URL = 'https://news.ycombinator.com/item?id=';

const SearchResponse = z.object({
  hits: z.array(
    z.object({
      objectID: z.string(),
      title: z.string().nullish(),
      url: z.string().nullish(),
      created_at: z.iso.datetime({ offset: true }).transform((s) => new Date(s).toISOString()),
    }),
  ),
});

/** The article link and its site, or the HN discussion for text posts (Ask HN) and unusable links. */
function link(objectID: string, url: string | null | undefined): { url: string; source: string } {
  if (url) {
    try {
      const u = new URL(url);
      if (u.protocol === 'http:' || u.protocol === 'https:') return { url, source: u.hostname.replace(/^www\./, '') };
    } catch {
      // Not a URL: fall through to the discussion page.
    }
  }
  return { url: `${ITEM_URL}${objectID}`, source: 'Hacker News' };
}

export class HackerNewsAdapter implements HackerNewsPort {
  static readonly id = 'hackernews';
  constructor(private readonly o: HackerNewsOptions) {}

  url(): string {
    return `${this.o.base ?? BASE}/api/v1/search?tags=front_page&hitsPerPage=30`;
  }

  async frontPage(): Promise<Result<SourceSnapshot<RawNewsItem[]>, SourceError>> {
    const id = HackerNewsAdapter.id;
    const url = this.url();
    const raw = await httpGetText(url, { sourceId: id, userAgent: this.o.userAgent, ...(this.o.fetchImpl ? { fetchImpl: this.o.fetchImpl } : {}) });
    if (!raw.ok) return raw;
    const parsed = parse(SearchResponse, raw.value, id);
    if (!parsed.ok) return parsed;
    const items: RawNewsItem[] = parsed.value.hits.flatMap((h) =>
      // A hit without a title (deleted or flagged since indexing) has nothing to show.
      h.title ? [{ ...link(h.objectID, h.url), title: h.title, publishedAt: h.created_at, snippet: null, lang: null, origin: 'hn' as const }] : [],
    );
    return ok({ sourceId: id, fetchedAt: (this.o.now?.() ?? new Date()).toISOString(), requestUrl: url, raw: raw.value, parsed: items });
  }
}
