import { err, ok, type Result } from '../domain/result';
import { cityTopic, customTopic, DEFAULT_TOPICS, SUGGESTED_TOPICS, type TopicRef, type TopicSeed } from '../domain/topics';
import type { LocationRepo, TopicRecord, TopicRepo } from '../ports';

export interface TopicDeps {
  readonly topics: TopicRepo;
  readonly locations: LocationRepo;
}

export function enabledTopics(records: readonly TopicRecord[]): TopicRef[] {
  return records.filter((t) => t.enabled).map(({ id, label, query, keywords }) => ({ id, label, query, keywords }));
}

/**
 * Spec §3.6 default topics, created once per user. Removing a topic only disables it, so a
 * user who removes every default is never re-seeded.
 */
export function ensureDefaultTopics(deps: TopicDeps) {
  return async (userId: string): Promise<void> => {
    if ((await deps.topics.list(userId)).length) return;
    const primary = (await deps.locations.list(userId)).find((l) => l.isPrimary);
    const city = primary ? cityTopic(primary.name) : null;
    for (const seed of [...(city ? [city] : []), ...DEFAULT_TOPICS]) await deps.topics.upsert(userId, seed);
  };
}

export interface TopicsView {
  readonly topics: readonly { readonly id: string; readonly label: string; readonly searchable: boolean }[];
  readonly suggestions: readonly { readonly key: string; readonly label: string }[];
}

/** At most this many active topics; each costs news fetches and rotates through the surge questions. */
export const MAX_TOPICS = 12;

export function listTopics(deps: TopicDeps) {
  const seed = ensureDefaultTopics(deps);
  return async (userId: string): Promise<TopicsView> => {
    await seed(userId);
    const all = await deps.topics.list(userId);
    const active = all.filter((t) => t.enabled);
    const activeKeys = new Set(active.map((t) => t.key));
    // Removed defaults come back as one-tap suggestions too.
    const offer = [...DEFAULT_TOPICS, ...SUGGESTED_TOPICS].filter((s, i, xs) => !activeKeys.has(s.key) && xs.findIndex((x) => x.key === s.key) === i);
    return {
      topics: active.map((t) => ({ id: t.id, label: t.label, searchable: t.query != null })),
      suggestions: offer.map((s) => ({ key: s.key, label: s.label })),
    };
  };
}

export type TopicError = { readonly code: 'unknown_suggestion' | 'too_many' | 'invalid' };

export function addTopic(deps: TopicDeps) {
  const view = listTopics(deps);
  return async (userId: string, input: { readonly suggestion: string } | { readonly label: string }): Promise<Result<TopicsView, TopicError>> => {
    let seed: TopicSeed | undefined;
    if ('suggestion' in input) {
      seed = [...DEFAULT_TOPICS, ...SUGGESTED_TOPICS].find((s) => s.key === input.suggestion);
      if (!seed) return err({ code: 'unknown_suggestion' });
    } else {
      seed = customTopic(input.label);
      if (seed.label.length < 2 || seed.label.length > 40) return err({ code: 'invalid' });
    }
    const all = await deps.topics.list(userId);
    const already = all.find((t) => t.key === seed.key && t.enabled);
    if (!already && all.filter((t) => t.enabled).length >= MAX_TOPICS) return err({ code: 'too_many' });
    await deps.topics.upsert(userId, seed);
    return ok(await view(userId));
  };
}

export function removeTopic(deps: TopicDeps) {
  const view = listTopics(deps);
  return async (userId: string, id: string): Promise<TopicsView | null> => ((await deps.topics.setEnabled(userId, id, false)) ? view(userId) : null);
}
