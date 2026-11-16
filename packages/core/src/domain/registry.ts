import { FORECASTERS } from './forecasters';
import { TEMPLATES, type TemplateInfo } from './templates';
import { WORLD_FORECASTERS } from './world-forecasters';
import { WORLD_TEMPLATES, type WorldTemplate } from './world-templates';

/**
 * Registries (spec §2.3): every template and forecaster Reckon knows, place-based and world.
 * A new topic is a registration here, not a change to the use cases (G6).
 */

export const ALL_TEMPLATES: readonly TemplateInfo[] = [...TEMPLATES, ...WORLD_TEMPLATES];

const templates = new Map<string, TemplateInfo>(ALL_TEMPLATES.map((t) => [t.id, t]));
const worldTemplates = new Map<string, WorldTemplate>(WORLD_TEMPLATES.map((t) => [t.id, t]));

export function templateById(id: string | null | undefined): TemplateInfo | undefined {
  return id ? templates.get(id) : undefined;
}

export function worldTemplateById(id: string): WorldTemplate | undefined {
  return worldTemplates.get(id);
}

export interface ForecasterInfo {
  readonly id: string;
  readonly kind: string;
  readonly displayName: string;
}

/** One row per forecaster ID (persistence serves both families under one ID and one track record per template). */
export const ALL_FORECASTERS: readonly ForecasterInfo[] = [
  ...new Map([...FORECASTERS, ...WORLD_FORECASTERS].map((f) => [f.id, { id: f.id, kind: f.kind, displayName: f.displayName }])).values(),
];

const names = new Map(ALL_FORECASTERS.map((f) => [f.id, f.displayName]));

/** Display names for forecasters stored in the database, including the human one. */
export function forecasterName(id: string): string {
  return names.get(id) ?? (id === 'user' ? 'You' : id);
}
