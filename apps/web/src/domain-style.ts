/** Each topic owns one gradient (spec §12). Colour carries topic, never meaning. */
export const DOMAIN_GRADIENT = {
  weather: ['#0EA5E9', '#6366F1'],
  air: ['#F59E0B', '#A855F7'],
  money: ['#10B981', '#14B8A6'],
  tech: ['#6366F1', '#EC4899'],
  world: ['#F97316', '#EF4444'],
  life: ['#EC4899', '#F43F5E'],
} as const;
export type Domain = keyof typeof DOMAIN_GRADIENT;
