import { err, ok, type Result } from '../domain/result';
import type { Location, LocationInput, LocationRepo, ScoreReader, User, UserPatch, UserRepo } from '../ports';
import { MIN_CLUSTERS } from './trust';

export interface MeView {
  readonly user: Omit<User, 'telegramChatId'> & { readonly telegramLinked: boolean };
  readonly locations: readonly Location[];
  readonly stats: { readonly resolvedDays: number; readonly daysForTrust: number };
}

export interface SettingsDeps {
  readonly users: UserRepo;
  readonly locations: LocationRepo;
  readonly scores: ScoreReader;
}

function meView(user: User, locations: readonly Location[], resolvedDays: number): MeView {
  const { telegramChatId, ...rest } = user;
  return { user: { ...rest, telegramLinked: telegramChatId != null }, locations, stats: { resolvedDays, daysForTrust: MIN_CLUSTERS } };
}

export function getMe(deps: SettingsDeps) {
  return async (userId: string): Promise<MeView | null> => {
    const user = await deps.users.byId(userId);
    if (!user) return null;
    const [locations, resolvedDays] = await Promise.all([deps.locations.list(userId), deps.scores.resolvedClusterCount(userId)]);
    return meView(user, locations, resolvedDays);
  };
}

export function updateMe(deps: SettingsDeps) {
  return async (userId: string, patch: UserPatch): Promise<MeView | null> => {
    const user = await deps.users.update(userId, patch);
    if (!user) return null;
    return getMe(deps)(userId);
  };
}

export type LocationError = { readonly code: 'not_found' | 'last_location' };

/** Spec §1.5: up to a handful of places; the first one becomes primary. */
export const MAX_LOCATIONS = 3;

export function addLocation(deps: SettingsDeps & { onAdded?: (loc: Location) => Promise<void> }) {
  return async (userId: string, input: LocationInput): Promise<Result<Location, { code: 'too_many' }>> => {
    const existing = await deps.locations.list(userId);
    if (existing.length >= MAX_LOCATIONS) return err({ code: 'too_many' });
    const loc = await deps.locations.create(userId, { ...input, isPrimary: input.isPrimary ?? existing.length === 0 });
    // Generate straight away so the first claims exist within minutes of onboarding (spec G4).
    await deps.onAdded?.(loc);
    return ok(loc);
  };
}

export function updateLocation(deps: SettingsDeps) {
  return async (userId: string, id: string, patch: Partial<LocationInput>): Promise<Result<Location, LocationError>> => {
    const loc = await deps.locations.get(id);
    if (!loc || loc.userId !== userId) return err({ code: 'not_found' });
    const updated = await deps.locations.update(id, patch);
    return updated ? ok(updated) : err({ code: 'not_found' });
  };
}

export function removeLocation(deps: SettingsDeps) {
  return async (userId: string, id: string): Promise<Result<true, LocationError>> => {
    const loc = await deps.locations.get(id);
    if (!loc || loc.userId !== userId) return err({ code: 'not_found' });
    const all = await deps.locations.list(userId);
    if (all.length <= 1) return err({ code: 'last_location' });
    await deps.locations.remove(id);
    // Questions keep their copied coordinates; they resolve as asked (spec §2.4: questions copy coordinates).
    return ok(true);
  };
}
