import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { api } from '../api';
import { ProbabilityRing } from '../components/ProbabilityRing';
import { Alert, Card, Heading, Muted, SectionTitle } from '../components/ui';

const time = (iso: string) => new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const SOURCE_NAMES: Record<string, string> = {
  'openmeteo.forecast': 'Open-Meteo forecast',
  'openmeteo.air_quality': 'Open-Meteo air quality',
  'openmeteo.ensemble': 'Open-Meteo ensemble (ECMWF)',
  'openmeteo.archive': 'Open-Meteo historical (ERA5)',
  frankfurter: 'Frankfurter (ECB reference rates)',
  'usgs.earthquake': 'USGS earthquake catalogue',
  'gfz.kp': 'GFZ Potsdam Kp index',
  'swpc.kp': 'NOAA SWPC planetary Kp',
  'swpc.geomag_forecast': 'NOAA SWPC 3-day forecast',
  'github.releases': 'GitHub releases',
  statuspage: 'Service status page',
  'gdelt.doc': 'GDELT news coverage',
};
const PURPOSE: Record<string, string> = { forecast: 'Used to forecast', climatology: 'Climatology history', resolution: 'Used to resolve' };

/** Question detail (spec 04-design): full transparency about one claim. */
export function QuestionDetail({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['question', id], queryFn: () => api.question(id) });
  if (q.isPending) return <Muted>Loading…</Muted>;
  if (q.isError) return <Alert>{q.error.message}</Alert>;
  const d = q.data;
  const champion = d.forecasts.find((f) => f.champion);

  return (
    <article aria-labelledby="q-heading">
      <Link to="/" className="text-sm text-[var(--color-muted)] underline-offset-4 hover:underline">
        ← Today
      </Link>
      <div className="mt-4 flex items-center gap-6">
        {champion && <ProbabilityRing percent={champion.percent} domain={d.domain} size={112} />}
        <div>
          <Heading id="q-heading">{d.subject}</Heading>
          <Muted className="mt-1">
            {d.placeName}, {d.scope === 'world' ? `resolves ${d.when}` : d.when} · asked {d.horizonDays} day{d.horizonDays === 1 ? '' : 's'} ahead ·{' '}
            {d.class === 'decision' ? 'decision' : 'calibration'} question
          </Muted>
        </div>
      </div>

      <SectionTitle>How this is judged</SectionTitle>
      <Card className="mt-3 space-y-3 text-sm">
        <p className="text-base">{d.judged.rule}</p>
        <p>
          <span className="text-[var(--color-muted)]">Source: </span>
          {d.judged.dataset}
        </p>
        {d.judged.caveat && <p className="text-[var(--color-muted)]">{d.judged.caveat}</p>}
        <p className="text-[var(--color-muted)]">{d.judged.missing}</p>
        <p className="text-[var(--color-muted)]">
          Locked {time(d.lockAt)}. Frozen criteria hash <code className="break-all font-mono text-xs">{d.criteriaHash}</code>
        </p>
        {d.baseRate != null && (
          <p className="text-[var(--color-muted)]">
            This threshold was chosen because it happened in {Math.round(d.baseRate * 100)}% of comparable {d.scope === 'world' ? 'windows' : 'days'}, where an
            outcome teaches the most.
          </p>
        )}
        <details>
          <summary className="cursor-pointer text-[var(--color-muted)]">Machine-readable criteria</summary>
          <pre className="mt-2 overflow-x-auto rounded-xl bg-[var(--color-bg)] p-3 text-xs">{JSON.stringify(d.criteria, null, 2)}</pre>
        </details>
      </Card>

      <SectionTitle>Why we believe this</SectionTitle>
      {champion ? <p className="mt-3 max-w-prose">{champion.rationale}</p> : <Muted className="mt-3">No forecaster had data for this question.</Muted>}
      {d.news.length > 0 && (
        <section aria-labelledby="news-heading" className="mt-5">
          <h3 id="news-heading" className="text-sm font-semibold">
            In the news
          </h3>
          <Muted className="mt-1 text-sm">Context only: headlines never decide the answer.</Muted>
          <ul className="mt-2 space-y-3">
            {d.news.map((n) => (
              <li key={n.evidenceId} className="border-t border-[var(--color-line)] pt-3">
                <a href={n.url} target="_blank" rel="noreferrer" className="font-medium underline-offset-4 hover:underline">
                  {n.title}
                </a>
                <p className="mt-0.5 text-xs text-[var(--color-muted)]">
                  {n.source}
                  {n.publishedAt && ` · ${time(n.publishedAt)}`}
                </p>
                {n.snippet && <p className="mt-1 text-sm text-[var(--color-muted)]">{n.snippet}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <SectionTitle>Every forecaster</SectionTitle>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Each forecaster's probability, when it was made, and its Brier score once resolved</caption>
          <thead className="text-[var(--color-muted)]">
            <tr>
              <th scope="col" className="py-2 pr-4 font-medium">
                Forecaster
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                Said
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                Made
              </th>
              <th scope="col" className="py-2 font-medium">
                Brier
              </th>
            </tr>
          </thead>
          <tbody>
            {d.forecasts.map((f) => (
              <tr key={f.forecasterId} className="border-t border-[var(--color-line)] align-top">
                <th scope="row" className="py-2 pr-4 font-medium">
                  {f.name}
                  {f.champion && <span className="ml-2 text-xs text-[var(--color-muted)]">(shown)</span>}
                  <p className="mt-0.5 text-xs font-normal text-[var(--color-muted)]">{f.rationale}</p>
                </th>
                <td className="py-2 pr-4 tabular-nums">{f.percent}%</td>
                <td className="py-2 pr-4 whitespace-nowrap text-[var(--color-muted)]">{time(f.madeAt)}</td>
                <td className="py-2 tabular-nums">{f.brier == null ? '–' : f.brier.toFixed(3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <SectionTitle>What happened</SectionTitle>
      <div className="mt-3">
        {d.sealed ? (
          <Muted>Sealed until the reveal at {time(d.opensAt)}.</Muted>
        ) : d.resolution ? (
          d.resolution.outcome == null ? (
            <p>Annulled ({d.resolution.annulReason ?? 'no data'}): the source could not answer in time, so this question is left out of every score.</p>
          ) : (
            <p className="text-lg">
              Observed <strong>{d.resolution.observed}</strong>, so the answer is <strong>{d.resolution.outcome ? 'YES' : 'NO'}</strong>.
              <span className="block text-sm text-[var(--color-muted)]">
                Resolved {time(d.resolution.resolvedAt)} by {d.resolution.resolver}.
              </span>
            </p>
          )
        ) : (
          <Muted>{d.status === 'open' || d.status === 'locked' ? 'Not happened yet.' : 'Waiting for the source to publish.'}</Muted>
        )}
      </div>

      <SectionTitle>Raw data</SectionTitle>
      <ul className="mt-3 space-y-3 text-sm">
        {d.evidence.map((e) => (
          <li key={e.id} className="border-t border-[var(--color-line)] pt-3">
            <p>
              {PURPOSE[e.purpose ?? ''] ?? 'Evidence'}: {SOURCE_NAMES[e.sourceId] ?? e.sourceId}, fetched {time(e.fetchedAt)}
            </p>
            <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[var(--color-muted)]">
              <a href={e.downloadPath} className="underline underline-offset-4 hover:text-[var(--color-text)]">
                Download the raw response
              </a>
              {e.url && (
                <a href={e.url} target="_blank" rel="noreferrer" className="underline underline-offset-4 hover:text-[var(--color-text)]">
                  Exact request URL
                </a>
              )}
              <span className="font-mono text-xs">sha256 {e.sha256.slice(0, 16)}…</span>
            </p>
          </li>
        ))}
      </ul>
    </article>
  );
}
