/**
 * Plain data shapes for the Phase 2 world sources (money, world, space, tech, news). Adapters
 * produce them; pure templates, forecasters and the news pipeline consume them.
 * Every instant is an ISO 8601 UTC string; every date is 'YYYY-MM-DD'.
 */

/** One daily reference rate, e.g. USD/INR on an ECB working day. */
export interface FxRate {
  readonly date: string;
  readonly rate: number;
}

export interface Quake {
  readonly id: string;
  readonly time: string;
  readonly magnitude: number;
  readonly place: string;
  readonly url: string;
}

/** One 3-hour planetary Kp slot; `time` is the slot start (00, 03, …, 21 UT). */
export interface KpPoint {
  readonly time: string;
  readonly kp: number;
}

/**
 * One UT day of NOAA SWPC's 3-day geomagnetic forecast. The four probabilities (0..1) are the
 * chances that the day's highest level is Active (Kp 4), Minor storm (Kp 5), Moderate storm
 * (Kp 6) or Strong-Extreme storm (Kp ≥ 7); they are separate categories, not cumulative.
 */
export interface GeomagDay {
  readonly date: string;
  readonly pActive: number;
  readonly pMinor: number;
  readonly pModerate: number;
  readonly pStrong: number;
  /** Highest predicted 3-hour Kp that day, if the product listed it. */
  readonly kpMax: number | null;
}

export interface GeomagForecast {
  readonly issuedAt: string;
  readonly days: readonly GeomagDay[];
}

export interface Release {
  readonly tag: string;
  readonly name: string | null;
  readonly publishedAt: string;
  readonly prerelease: boolean;
  readonly url: string;
}

export interface ReleaseList {
  readonly repo: string; // 'owner/name'
  readonly releases: readonly Release[]; // newest first, drafts excluded
  /** False when the source returned a full page, so releases older than the oldest one listed may be missing. */
  readonly complete: boolean;
}

export type IncidentImpact = 'none' | 'minor' | 'major' | 'critical';
export const INCIDENT_IMPACTS: readonly IncidentImpact[] = ['none', 'minor', 'major', 'critical'];

export interface Incident {
  readonly id: string;
  readonly name: string;
  readonly impact: IncidentImpact;
  readonly createdAt: string;
  readonly url: string;
}

export interface IncidentList {
  readonly service: string; // status page host, e.g. 'www.githubstatus.com'
  readonly pageName: string; // 'GitHub'
  readonly incidents: readonly Incident[]; // newest first
  /** False when the source returned its maximum (Statuspage lists only the latest 50). */
  readonly complete: boolean;
}

/** Article count for one UTC day (GDELT DOC timeline, summed over the day). */
export interface VolumePoint {
  readonly date: string;
  readonly count: number;
}

export type NewsOrigin = 'rss' | 'gdelt' | 'hn';

/** A headline as fetched, before normalisation and deduplication (spec §3.6 step 1). */
export interface RawNewsItem {
  readonly url: string;
  readonly title: string;
  readonly source: string; // publisher or site name
  readonly publishedAt: string | null;
  readonly snippet: string | null;
  readonly lang: string | null;
  readonly origin: NewsOrigin;
}
