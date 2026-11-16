import { err, ok, type Release, type ReleaseList, type ReleasePort, type Result, type SourceError, type SourceSnapshot } from '@reckon/core';
import { z } from 'zod';
import { type FetchLike, httpGet } from '../http';
import { parse } from '../parse';

/** GitHub REST releases. Endpoint, limits and terms are recorded in SOURCE.md. */

export interface GitHubReleasesOptions {
  readonly userAgent: string;
  /** Optional token: lifts the limit from 60/h per IP to 5,000/h. Public data needs no scopes. */
  readonly token?: string;
  readonly fetchImpl?: FetchLike;
  readonly now?: () => Date;
  /** Replaces `https://api.github.com` (tests). */
  readonly base?: string;
}

const BASE = 'https://api.github.com';
const PER_PAGE = 100;
// GitHub's own rules: owners are alphanumeric or '-' (≤ 39), repo names add '.' and '_' (≤ 100).
const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

const instant = z.iso.datetime({ offset: true }).transform((s) => new Date(s).toISOString());
const ReleasesResponse = z.array(
  z.object({
    tag_name: z.string(),
    name: z.string().nullable(),
    draft: z.boolean(),
    prerelease: z.boolean(),
    published_at: instant.nullable(),
    html_url: z.string(),
  }),
);

export class GitHubReleasesAdapter implements ReleasePort {
  static readonly id = 'github.releases';
  constructor(private readonly o: GitHubReleasesOptions) {}

  url(repo: string): string {
    return `${this.o.base ?? BASE}/repos/${repo}/releases?per_page=${PER_PAGE}`;
  }

  async releases(repo: string): Promise<Result<SourceSnapshot<ReleaseList>, SourceError>> {
    const id = GitHubReleasesAdapter.id;
    const [, name] = repo.split('/');
    if (!REPO.test(repo) || name === '.' || name === '..') return err({ code: 'not_found', sourceId: id, detail: `invalid repo '${repo}'` });
    const url = this.url(repo);

    // httpGet reports 403 as schema_changed without headers, so watch the response for GitHub's rate-limit signals.
    const seen = { limited: false, reset: null as string | null };
    const inner = this.o.fetchImpl ?? fetch;
    const fetchImpl: FetchLike = async (input, init) => {
      const res = await inner(input, init);
      // Primary limit: remaining 0. Secondary limit: 403/429 with retry-after (docs: "Exceeding the rate limit").
      seen.limited = (res.status === 403 || res.status === 429) && (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after'));
      seen.reset = res.headers.get('x-ratelimit-reset');
      return res;
    };
    const res = await httpGet(url, {
      sourceId: id,
      userAgent: this.o.userAgent,
      fetchImpl,
      accept: 'application/vnd.github+json',
      headers: { 'X-GitHub-Api-Version': '2022-11-28', ...(this.o.token ? { Authorization: `Bearer ${this.o.token}` } : {}) },
    });
    if (!res.ok) {
      if (!seen.limited) return res;
      const reset = seen.reset && /^\d+$/.test(seen.reset) ? `resets ${new Date(Number(seen.reset) * 1000).toISOString()}` : 'retry later';
      return err({ code: 'rate_limited', sourceId: id, detail: reset });
    }

    const parsed = parse(ReleasesResponse, res.value.text, id);
    if (!parsed.ok) return parsed;
    // Drafts only appear to tokens with push access; they have no publish time and are not releases yet.
    const releases: Release[] = parsed.value
      .flatMap((r) =>
        r.draft || r.published_at === null
          ? []
          : [{ tag: r.tag_name, name: r.name || null, publishedAt: r.published_at, prerelease: r.prerelease, url: r.html_url }],
      )
      // The list is not in publish order (seen live for nodejs/node), so sort here.
      .sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : a.publishedAt > b.publishedAt ? -1 : 0));
    const list: ReleaseList = { repo, releases, complete: parsed.value.length < PER_PAGE };
    return ok({ sourceId: id, fetchedAt: (this.o.now?.() ?? new Date()).toISOString(), requestUrl: url, raw: res.value.text, parsed: list });
  }
}
