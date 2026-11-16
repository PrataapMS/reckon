import { addDays, localDate } from '../domain/dates';
import { DEDUPE_WINDOW_HOURS, DEFAULT_FEEDS, evidenceQueries, isNearDuplicate, normalizeNews, RETAIN_DAYS, relevance, tagRules } from '../domain/news';
import { isWorldMeta } from '../domain/templates';
import { gdeltQuery } from '../domain/topics';
import type { RawNewsItem } from '../domain/world-data';
import { DEFAULT_WATCH } from '../domain/world-templates';
import type {
  Clock,
  FeedPort,
  FeedState,
  FeedStateRepo,
  HackerNewsPort,
  LocationRepo,
  Logger,
  NewsRepo,
  NewsSearchPort,
  QuestionRepo,
  SourceError,
  TopicRepo,
  UserRepo,
} from '../ports';
import { enabledTopics, ensureDefaultTopics } from './topics';

export interface NewsDeps {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly users: UserRepo;
  readonly locations: LocationRepo;
  readonly topics: TopicRepo;
  readonly questions: QuestionRepo;
  readonly news: NewsRepo;
  readonly feedState: FeedStateRepo;
  readonly feeds: FeedPort;
  readonly hackerNews: HackerNewsPort;
  readonly search: NewsSearchPort;
}

export interface NewsStats {
  readonly fetched: number;
  readonly inserted: number;
  readonly duplicates: number;
  readonly linked: number;
  readonly pruned: number;
  readonly errors: readonly string[];
}

/** Feeds and Hacker News are polled at most this often (the job is hourly; ETags make repeats cheap). */
const FEED_EVERY_MS = 50 * 60_000;
/** GDELT allows one request per 5 s, so each run refreshes only the stalest searches. */
const GDELT_PER_RUN = 2;
const GDELT_EVERY_MS = 3 * 3_600_000;
/** Enough context without drowning the panel. */
const MAX_LINKS_PER_QUESTION = 8;
/** Headlines this long before a window opens can still explain it. */
const LOOKBACK_DAYS = 3;

/**
 * The hourly `news` job (spec §3.6): fetch, normalise, deduplicate, tag, link, retain. Every step
 * is deterministic and idempotent, so a run cut short by the time budget loses nothing.
 */
export function runNewsCycle(deps: NewsDeps) {
  const seedTopics = ensureDefaultTopics(deps);
  return async (budgetMs = 18_000): Promise<NewsStats> => {
    const started = deps.clock.now();
    const deadline = started.getTime() + budgetMs;
    const errors: string[] = [];
    const users = await deps.users.all();
    const topics = [];
    for (const u of users) {
      await seedTopics(u.id);
      topics.push(...enabledTopics(await deps.topics.list(u.id)));
    }
    const rules = tagRules(DEFAULT_WATCH, topics);
    const states = new Map((await deps.feedState.all()).map((s) => [s.id, s]));
    const due = (id: string, every: number) => {
      const last = states.get(id)?.lastFetchedAt;
      return !last || started.getTime() - last.getTime() >= every;
    };
    const record = async (s: FeedState) => {
      states.set(s.id, s);
      await deps.feedState.put(s);
    };
    const failed = (id: string, e: SourceError) => {
      errors.push(`${id}:${e.code}`);
      deps.logger.warn('news.fetch_failed', { id, code: e.code, detail: e.detail });
      const prev = states.get(id);
      return record({ id, etag: prev?.etag ?? null, lastModified: prev?.lastModified ?? null, lastFetchedAt: deps.clock.now(), lastStatus: e.code });
    };

    // 1. Fetch: feeds and Hacker News in parallel, GDELT one search at a time.
    const raw: RawNewsItem[] = [];
    await Promise.all(
      DEFAULT_FEEDS.filter((f) => due(`rss:${f.id}`, FEED_EVERY_MS)).map(async (f) => {
        const id = `rss:${f.id}`;
        const prev = states.get(id);
        const r = await deps.feeds.fetchFeed(f, { etag: prev?.etag ?? null, lastModified: prev?.lastModified ?? null });
        if (!r.ok) return failed(id, r.error);
        if (r.value.notModified)
          return record({
            id,
            etag: prev?.etag ?? null,
            lastModified: prev?.lastModified ?? null,
            lastFetchedAt: deps.clock.now(),
            lastStatus: 'not_modified',
          });
        raw.push(...r.value.snapshot.parsed);
        return record({ id, etag: r.value.etag, lastModified: r.value.lastModified, lastFetchedAt: deps.clock.now(), lastStatus: 'ok' });
      }),
    );
    if (due('hn', FEED_EVERY_MS)) {
      const r = await deps.hackerNews.frontPage();
      if (r.ok) {
        raw.push(...r.value.parsed);
        await record({ id: 'hn', etag: null, lastModified: null, lastFetchedAt: deps.clock.now(), lastStatus: 'ok' });
      } else await failed('hn', r.error);
    }
    const searches = [...new Set([...evidenceQueries(DEFAULT_WATCH), ...topics.flatMap((t) => (t.query ? [t.query] : []))])]
      .map((q) => ({ q, id: `gdelt:${q}` }))
      .filter((s) => due(s.id, GDELT_EVERY_MS))
      .sort((a, b) => (states.get(a.id)?.lastFetchedAt?.getTime() ?? 0) - (states.get(b.id)?.lastFetchedAt?.getTime() ?? 0))
      .slice(0, GDELT_PER_RUN);
    for (const s of searches) {
      // Each search may wait out GDELT's 5-second spacing; leave room for the rest of the run.
      if (deadline - deps.clock.now().getTime() < 8_000) break;
      const r = await deps.search.articles({ query: gdeltQuery(s.q), hours: 24, max: 50 });
      if (r.ok) {
        raw.push(...r.value.parsed);
        await record({ id: s.id, etag: null, lastModified: null, lastFetchedAt: deps.clock.now(), lastStatus: 'ok' });
      } else await failed(s.id, r.error);
    }

    // 2–4. Normalise, deduplicate (canonical URL, then title SimHash within 48 h), tag, insert.
    const now = deps.clock.now();
    const items = raw.flatMap((r) => normalizeNews(r, now, rules) ?? []);
    const known = await deps.news.hasCanonicalUrl(items.map((i) => i.canonicalUrl));
    const seen = await deps.news.simhashesSince(new Date(now.getTime() - DEDUPE_WINDOW_HOURS * 3_600_000));
    const urls = new Set<string>();
    let inserted = 0;
    let duplicates = 0;
    for (const item of items.sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime())) {
      if (known.has(item.canonicalUrl) || urls.has(item.canonicalUrl) || isNearDuplicate(item.simhash, seen)) {
        duplicates++;
        continue;
      }
      urls.add(item.canonicalUrl);
      seen.push(item.simhash);
      await deps.news.insert(item, now);
      inserted++;
    }

    // 5. Link to world questions whose window is still open.
    let linked = 0;
    const ruleByTag = new Map(rules.map((r) => [r.tag, r]));
    for (const u of users) {
      const today = localDate(now, u.tz);
      const open = (await deps.questions.listByTargetDates(u.id, addDays(today, -1), addDays(today, 8))).filter(
        (q) => isWorldMeta(q.meta) && q.windowEnd.getTime() > now.getTime() && q.status !== 'annulled',
      );
      for (const q of open) {
        if (!isWorldMeta(q.meta) || !q.meta.tags.length) continue;
        const room = MAX_LINKS_PER_QUESTION - (await deps.news.linkedCount(q.id));
        if (room <= 0) continue;
        const since = new Date(q.windowStart.getTime() - LOOKBACK_DAYS * 86_400_000);
        const tags = q.meta.tags;
        const candidates = (await deps.news.unlinkedTagged(q.id, since, tags))
          .filter((n) => n.publishedAt.getTime() < q.windowEnd.getTime())
          .map((n) => ({ n, score: Math.max(...tags.filter((t) => n.tags.includes(t)).map((t) => relevance(n, ruleByTag.get(t), q.windowStart))) }))
          .sort((a, b) => b.score - a.score || b.n.publishedAt.getTime() - a.n.publishedAt.getTime())
          .slice(0, room);
        for (const c of candidates) {
          await deps.news.link(c.n.id, q.id, c.score);
          linked++;
        }
      }
    }

    // 6. Retain: unlinked headlines expire; linked ones are permanent evidence.
    const pruned = await deps.news.prune(new Date(now.getTime() - RETAIN_DAYS * 86_400_000));
    const stats = { fetched: raw.length, inserted, duplicates, linked, pruned, errors };
    deps.logger.info('news.done', stats);
    return stats;
  };
}
