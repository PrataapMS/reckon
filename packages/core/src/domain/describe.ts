import type { CountCriteria, Criteria } from './criteria';

/**
 * "How this is judged" (spec §3.4 auditability; ADR-0005): the frozen criteria in plain words,
 * naming the dataset explicitly so a grid-model value is never mistaken for a rain gauge.
 */
const DATASETS: Record<string, { readonly name: string; readonly caveat: string }> = {
  'openmeteo.forecast': {
    name: 'Open-Meteo Forecast API (past-day values)',
    caveat: 'This is a weather-model estimate for a grid cell of a few kilometres, not a rain gauge at your door. Local showers can differ.',
  },
  'openmeteo.air_quality': {
    name: 'Open-Meteo Air Quality API (CAMS model)',
    caveat: 'This is a modelled US AQI for a ~10–40 km grid cell, not a nearby monitoring station.',
  },
  frankfurter: {
    name: 'Frankfurter API (European Central Bank reference rates)',
    caveat: 'ECB reference rates are set once per working day around 14:10 CET. They are not the rate your bank or a trading screen shows.',
  },
  'usgs.earthquake': {
    name: 'USGS Earthquake Catalog (ComCat)',
    caveat: 'Magnitudes are the catalogue values when the question resolves; USGS sometimes revises them later, and the original resolution stands.',
  },
  'swpc.kp': {
    name: 'NOAA Space Weather Prediction Center, estimated planetary Kp (3-hour values)',
    caveat: "These are NOAA's near-real-time estimates. GFZ Potsdam later publishes a definitive Kp that can differ slightly; it is not used to judge.",
  },
  'github.releases': {
    name: 'GitHub REST API (repository releases)',
    caveat: 'Only GitHub releases count, not bare git tags; drafts and pre-releases are excluded.',
  },
  statuspage: {
    name: 'The service’s public Atlassian Statuspage (incidents feed)',
    caveat:
      'Incidents count by the time they were opened. Severity is the one shown when the question resolves, as the company labels it. Scheduled maintenance does not count.',
  },
  'gdelt.doc': {
    name: 'GDELT DOC 2.0 API (worldwide online news, article counts)',
    caveat: 'GDELT counts English-language articles it monitors that match the query. It is a measure of coverage, not of importance.',
  },
};

const OPS: Record<string, string> = { '>': 'above', '>=': 'at or above', '<': 'below', '<=': 'at or below' };
const AGG: Record<string, string> = {
  daily_sum: 'total over the local day',
  daily_max: 'highest hourly value during the local day',
  daily_min: 'lowest value during the local day',
  max_over_window: 'highest value over the window',
  value_at: 'value at the stated time',
};

export interface CriteriaDescription {
  readonly rule: string;
  readonly dataset: string;
  readonly caveat: string;
  readonly missing: string;
}

const str = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');

/** What a count question counts, in words, from its source and filter. */
function counted(c: CountCriteria): string {
  const f = c.filter;
  switch (c.source.id) {
    case 'usgs.earthquake':
      return `earthquakes of magnitude ${str(f.minMagnitude)} or more anywhere in the world`;
    case 'github.releases':
      return `stable releases published on github.com/${str(f.repo)}`;
    case 'statuspage':
      return f.minImpact === 'none' ? `incidents opened on ${str(f.host)}` : `incidents of ${str(f.minImpact)} impact or worse opened on ${str(f.host)}`;
    case 'gdelt.doc':
      return `English-language articles matching ${str(f.query)} during the UTC day`;
    default:
      return 'matching events';
  }
}

export function describeCriteria(c: Criteria): CriteriaDescription {
  const ds = DATASETS[c.source.id] ?? { name: c.source.id, caveat: '' };
  const missing = `If the source has not answered ${c.missingPolicy.retryUntilHours} hours after the window closes, the question is annulled and left out of every score. It is never guessed.`;
  switch (c.kind) {
    case 'threshold': {
      const where = c.lat != null && c.lon != null ? ` for ${c.lat.toFixed(2)}, ${c.lon.toFixed(2)}` : '';
      return {
        rule: `YES if the ${c.metric.replaceAll('_', ' ')} (${AGG[c.aggregation] ?? c.aggregation})${where} between ${c.window.start} and ${c.window.end} (${c.window.tz}) is ${OPS[c.comparator]} ${c.threshold} ${c.unit}; otherwise NO.`,
        dataset: ds.name,
        caveat: ds.caveat,
        missing,
      };
    }
    case 'compare':
      return {
        rule: `YES if the ${c.metric} rate published for ${c.b.at} is ${OPS[c.comparator]} the rate published for ${c.a.at}; otherwise NO (equal counts as NO).`,
        dataset: ds.name,
        caveat: ds.caveat,
        missing,
      };
    case 'count':
      return {
        rule: `YES if the number of ${counted(c)} between ${c.window.start} and ${c.window.end} is ${OPS[c.comparator]} ${c.threshold}; otherwise NO.`,
        dataset: ds.name,
        caveat: ds.caveat,
        missing,
      };
    case 'event':
      return { rule: `YES if ${c.predicate} occurs between ${c.window.start} and ${c.window.end}.`, dataset: ds.name, caveat: ds.caveat, missing };
  }
}
