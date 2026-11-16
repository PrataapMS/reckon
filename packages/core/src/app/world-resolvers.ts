import type { Criteria, Observation } from '../domain/criteria';
import { err, ok, type Result } from '../domain/result';
import { INCIDENT_IMPACTS, type IncidentImpact } from '../domain/world-data';
import { kpMax } from '../domain/world-templates';
import type { FxPort, NewsVolumePort, QuakePort, ReleasePort, Resolver, SourceError, SourceSnapshot, SpaceWeatherPort, StatusPagePort } from '../ports';

/**
 * Resolvers for world questions (spec §3.4). Each asks what the declared source reported for the
 * declared window, never what it says now, and returns null (missing, retried, then annulled)
 * when the source cannot see the whole window.
 */

type Observed = Promise<Result<SourceSnapshot<Observation | null>, SourceError>>;

const mismatch = (c: Criteria, id: string): Result<never, SourceError> =>
  err({ code: 'schema_changed', sourceId: c.source.id, detail: `${id} cannot judge ${c.kind} criteria` });

function windowOf(c: Criteria): { start: number; end: number } | null {
  return 'window' in c ? { start: Date.parse(c.window.start), end: Date.parse(c.window.end) } : null;
}

const inWindow = (iso: string, w: { start: number; end: number }) => {
  const t = Date.parse(iso);
  return t >= w.start && t < w.end;
};

function withParsed<T>(snap: SourceSnapshot<T>, parsed: Observation | null): SourceSnapshot<Observation | null> {
  return { ...snap, parsed };
}

/** ECB rates: the published rate on day b against day a. A holiday on either day stays missing. */
export function frankfurterResolver(fx: FxPort): Resolver {
  return {
    id: 'frankfurter.compare@1',
    sourceIds: ['frankfurter'],
    // ECB publishes around 16:00 CET; the window already ends after that.
    delayHours: 2,
    async observe(c): Observed {
      if (c.kind !== 'compare') return mismatch(c, this.id);
      const [base, quote] = c.metric.split('/');
      if (!base || !quote) return mismatch(c, this.id);
      const r = await fx.dailyRates({ base, quote, start: c.a.at, end: c.b.at });
      if (!r.ok) return r;
      const a = r.value.parsed.find((x) => x.date === c.a.at)?.rate;
      const b = r.value.parsed.find((x) => x.date === c.b.at)?.rate;
      return ok(withParsed(r.value, a != null && b != null ? { kind: 'pair', a, b } : null));
    },
  };
}

export function usgsResolver(quakes: QuakePort): Resolver {
  return {
    id: 'usgs.count@1',
    sourceIds: ['usgs.earthquake'],
    // Strong quakes appear within minutes; a few hours lets automatic magnitudes settle.
    delayHours: 6,
    async observe(c): Observed {
      if (c.kind !== 'count' || typeof c.filter.minMagnitude !== 'number') return mismatch(c, this.id);
      const r = await quakes.events({
        minMagnitude: c.filter.minMagnitude,
        start: new Date(c.window.start).toISOString(),
        end: new Date(c.window.end).toISOString(),
      });
      if (!r.ok) return r;
      return ok(withParsed(r.value, { kind: 'count', count: r.value.parsed.length }));
    },
  };
}

/** NOAA's estimated planetary Kp covers the last 7 days, well past the 72-hour retry limit. */
export function swpcKpResolver(space: SpaceWeatherPort): Resolver {
  return {
    id: 'swpc.kp_max@1',
    sourceIds: ['swpc.kp'],
    delayHours: 6,
    async observe(c): Observed {
      const w = windowOf(c);
      if (c.kind !== 'threshold' || !w) return mismatch(c, this.id);
      const r = await space.observedKp();
      if (!r.ok) return r;
      const max = kpMax(r.value.parsed, { start: new Date(w.start), end: new Date(w.end) });
      return ok(withParsed(r.value, max === undefined ? null : { kind: 'value', value: max }));
    },
  };
}

/** True when a newest-first listing reaches back past the window start (or holds everything). */
function reachesBack(complete: boolean, oldest: string | undefined, start: number): boolean {
  return complete || (oldest !== undefined && Date.parse(oldest) <= start);
}

export function githubReleasesResolver(releases: ReleasePort): Resolver {
  return {
    id: 'github.releases@1',
    sourceIds: ['github.releases'],
    delayHours: 1,
    async observe(c): Observed {
      const w = windowOf(c);
      if (c.kind !== 'count' || !w || typeof c.filter.repo !== 'string') return mismatch(c, this.id);
      const r = await releases.releases(c.filter.repo);
      if (!r.ok) return r;
      const list = r.value.parsed;
      if (!reachesBack(list.complete, list.releases.at(-1)?.publishedAt, w.start)) return ok(withParsed(r.value, null));
      const count = list.releases.filter((x) => (c.filter.includePrereleases === true || !x.prerelease) && inWindow(x.publishedAt, w)).length;
      return ok(withParsed(r.value, { kind: 'count', count }));
    },
  };
}

const RANK: Record<IncidentImpact, number> = { none: 0, minor: 1, major: 2, critical: 3 };

export function statuspageResolver(status: StatusPagePort): Resolver {
  return {
    id: 'statuspage.incidents@1',
    sourceIds: ['statuspage'],
    delayHours: 1,
    async observe(c): Observed {
      const w = windowOf(c);
      const minImpact = INCIDENT_IMPACTS.find((i) => i === (c.kind === 'count' ? c.filter.minImpact : undefined));
      if (c.kind !== 'count' || !w || typeof c.filter.host !== 'string' || !minImpact) return mismatch(c, this.id);
      const r = await status.incidents(c.filter.host);
      if (!r.ok) return r;
      const list = r.value.parsed;
      // Statuspage lists only the latest 50; if the window has scrolled off, the answer is unknown.
      if (!reachesBack(list.complete, list.incidents.at(-1)?.createdAt, w.start)) return ok(withParsed(r.value, null));
      const count = list.incidents.filter((i) => RANK[i.impact] >= RANK[minImpact] && inWindow(i.createdAt, w)).length;
      return ok(withParsed(r.value, { kind: 'count', count }));
    },
  };
}

export function gdeltVolumeResolver(volume: NewsVolumePort): Resolver {
  return {
    id: 'gdelt.volume@1',
    sourceIds: ['gdelt.doc'],
    // GDELT indexes in 15-minute batches; half a day lets late articles land.
    delayHours: 12,
    async observe(c): Observed {
      if (c.kind !== 'count' || typeof c.filter.query !== 'string') return mismatch(c, this.id);
      const day = new Date(c.window.start).toISOString().slice(0, 10);
      const r = await volume.dailyVolume({ query: c.filter.query, start: day, end: day });
      if (!r.ok) return r;
      const point = r.value.parsed.find((p) => p.date === day);
      return ok(withParsed(r.value, point ? { kind: 'count', count: point.count } : null));
    },
  };
}
