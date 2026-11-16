/**
 * News topics (spec §3.6): what the user wants headlines about, and what `news.topic_surge`
 * asks about. A topic has keywords for deterministic tagging and, when it is specific enough, a
 * GDELT query.
 */

export interface TopicRef {
  readonly id: string;
  readonly label: string;
  /** GDELT DOC query, or null when the label is too short or vague to search on its own. */
  readonly query: string | null;
  readonly keywords: readonly string[];
}

export interface TopicSeed {
  readonly key: string;
  readonly label: string;
  readonly query: string | null;
  readonly keywords: readonly string[];
}

/** Spec §3.6 defaults: India economy, AI and a few major tech companies (plus the user's city when known). */
export const DEFAULT_TOPICS: readonly TopicSeed[] = [
  {
    key: 'india-economy',
    label: 'India economy',
    query: '("Indian economy" OR "India\'s economy" OR "India GDP" OR "Reserve Bank of India")',
    keywords: ['indian economy', "india's economy", 'india gdp', 'reserve bank of india', 'rbi', 'sensex', 'nifty'],
  },
  {
    key: 'ai',
    label: 'AI',
    query: '("artificial intelligence" OR "generative AI" OR OpenAI OR Anthropic)',
    keywords: ['ai', 'artificial intelligence', 'generative ai', 'openai', 'anthropic', 'chatgpt', 'llm'],
  },
  { key: 'google', label: 'Google', query: 'Google', keywords: ['google', 'alphabet'] },
  { key: 'apple', label: 'Apple', query: '"Apple Inc" OR iPhone', keywords: ['apple', 'iphone'] },
  { key: 'microsoft', label: 'Microsoft', query: 'Microsoft', keywords: ['microsoft'] },
  { key: 'nvidia', label: 'Nvidia', query: 'Nvidia', keywords: ['nvidia'] },
];

/** One-tap suggestions offered once the defaults exist. */
export const SUGGESTED_TOPICS: readonly TopicSeed[] = [
  { key: 'space', label: 'Space exploration', query: '(NASA OR ISRO OR SpaceX)', keywords: ['nasa', 'isro', 'spacex', 'rocket launch'] },
  { key: 'climate', label: 'Climate', query: '"climate change"', keywords: ['climate change', 'global warming', 'heatwave', 'emissions'] },
  { key: 'monsoon', label: 'Monsoon', query: 'monsoon', keywords: ['monsoon'] },
  { key: 'cricket', label: 'Cricket', query: 'cricket', keywords: ['cricket', 'bcci', 'ipl'] },
  { key: 'startups', label: 'Startups', query: '(startup funding OR "Series A")', keywords: ['startup', 'series a', 'venture capital'] },
  {
    key: 'cybersecurity',
    label: 'Cybersecurity',
    query: '(cyberattack OR ransomware OR "data breach")',
    keywords: ['cyberattack', 'ransomware', 'data breach', 'vulnerability'],
  },
  { key: 'ev', label: 'Electric vehicles', query: '"electric vehicle"', keywords: ['electric vehicle', 'ev', 'tesla', 'battery'] },
  { key: 'chips', label: 'Semiconductors', query: '(semiconductor OR chipmaker)', keywords: ['semiconductor', 'chipmaker', 'tsmc'] },
  { key: 'markets', label: 'Stock markets', query: '("stock market" OR Sensex OR Nifty)', keywords: ['stock market', 'sensex', 'nifty', 'wall street'] },
  { key: 'openai', label: 'OpenAI', query: 'OpenAI', keywords: ['openai', 'chatgpt'] },
];

/** Place labels that name a role rather than a city, so they cannot become a news topic. */
const GENERIC_PLACE = /^(home|work|office|school|gym|parents|my place|place \d+)$/i;

/** The user's city as a default topic, when the location's name is a real place name. */
export function cityTopic(locationName: string): TopicSeed | null {
  const name = locationName.trim();
  if (name.length < 3 || GENERIC_PLACE.test(name)) return null;
  return { key: `city:${name.toLowerCase()}`, label: name, query: `"${name}"`, keywords: [name.toLowerCase()] };
}

/** A topic typed by the user: tagged by its own words; searched on GDELT only when long enough. */
export function customTopic(label: string): TopicSeed {
  const clean = label.trim().replace(/\s+/g, ' ');
  // GDELT rejects very short keywords, and quotes keep multi-word labels together.
  const query = clean.length < 3 ? null : clean.includes(' ') ? `"${clean.replaceAll('"', '')}"` : clean;
  return { key: `custom:${clean.toLowerCase()}`, label: clean, query, keywords: [clean.toLowerCase()] };
}

/** GDELT queries are restricted to English so headlines and counts stay comparable. */
export function gdeltQuery(query: string): string {
  return `${query} sourcelang:english`;
}
