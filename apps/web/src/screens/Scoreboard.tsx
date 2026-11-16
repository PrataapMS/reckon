import type { CalibrationResponse, ScoreboardResponse } from '@reckon/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api';
import { TrustBadge } from '../components/TrustBadge';
import { Alert, Card, Heading, inputClass, Muted, SectionTitle } from '../components/ui';
import { DOMAIN_GRADIENT } from '../domain-style';
import { useMe } from '../hooks';

const pct = (x: number | null) => (x == null ? '–' : `${Math.round(x * 100)}%`);

function Progress({ resolved, needed }: { resolved: number; needed: number }) {
  return (
    <div className="mt-6 max-w-sm">
      <div
        className="h-2 rounded-full bg-[var(--color-line)]"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={needed}
        aria-valuenow={Math.min(resolved, needed)}
        aria-label="Days resolved toward a first trust label"
      >
        <div className="h-2 rounded-full bg-[linear-gradient(90deg,#0EA5E9,#6366F1)]" style={{ width: `${Math.min(100, (resolved / needed) * 100)}%` }} />
      </div>
      <Muted className="mt-2 text-sm">
        {resolved} of {needed} independent days resolved
      </Muted>
    </div>
  );
}

const SIZE = 280;
const PAD = 36;
const plot = SIZE - PAD - 12;
const x = (v: number) => PAD + v * plot;
const y = (v: number) => 12 + (1 - v) * plot;

/**
 * Reliability diagram (spec §3.5): for forecasts in each probability band, how often the event
 * happened. On the diagonal is perfectly calibrated; bars are Wilson 95% intervals.
 */
function Reliability({ data }: { data: CalibrationResponse }) {
  const [active, setActive] = useState<number | null>(null);
  const filled = data.bins.filter((b) => b.count > 0);
  const maxCount = Math.max(1, ...filled.map((b) => b.count));
  const shown = active == null ? null : data.bins[active];
  const summary =
    data.n === 0
      ? 'No resolved forecasts yet.'
      : `${data.n} resolved forecasts. ${filled
          .map((b) => `Said ${pct(b.lower)}–${pct(b.upper)}: happened ${pct(b.observed)} of ${b.count}`)
          .join('; ')}. Expected calibration error ${data.ece == null ? '–' : data.ece.toFixed(3)}.`;

  return (
    <figure className="mt-4">
      {/* biome-ignore lint/a11y/useSemanticElements: a group (not an image) because the dots inside are focusable; a fieldset cannot hold SVG */}
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="w-full max-w-sm" role="group" aria-label={`Reliability diagram. ${summary}`}>
        {[0, 0.25, 0.5, 0.75, 1].map((t) => (
          <g key={t}>
            <line x1={x(0)} x2={x(1)} y1={y(t)} y2={y(t)} stroke="var(--color-line)" strokeWidth={1} />
            <text x={PAD - 6} y={y(t) + 4} textAnchor="end" fontSize={10} fill="var(--color-muted)">
              {pct(t)}
            </text>
            <text x={x(t)} y={SIZE - PAD + 16} textAnchor="middle" fontSize={10} fill="var(--color-muted)">
              {pct(t)}
            </text>
          </g>
        ))}
        <line x1={x(0)} y1={y(0)} x2={x(1)} y2={y(1)} stroke="var(--color-muted)" strokeWidth={1.5} strokeDasharray="4 4" />
        <text x={x(0.98)} y={y(0.92)} textAnchor="end" fontSize={10} fill="var(--color-muted)">
          perfectly calibrated
        </text>
        {data.bins.map((b, i) =>
          b.count === 0 || b.meanForecast == null || b.observed == null ? null : (
            // biome-ignore lint/a11y/useSemanticElements: an SVG mark cannot be a <button>; it is focusable and labelled instead
            <g
              key={b.lower}
              tabIndex={0}
              role="button"
              aria-label={`Said ${pct(b.lower)} to ${pct(b.upper)}: happened ${pct(b.observed)} of ${b.count} times`}
              onMouseEnter={() => setActive(i)}
              onMouseLeave={() => setActive(null)}
              onFocus={() => setActive(i)}
              onBlur={() => setActive(null)}
              className="cursor-default focus-visible:outline-2 focus-visible:outline-[var(--color-text)]"
            >
              {b.ci && (
                <line
                  x1={x(b.meanForecast)}
                  x2={x(b.meanForecast)}
                  y1={y(b.ci[0])}
                  y2={y(b.ci[1])}
                  stroke="var(--color-muted)"
                  strokeWidth={2}
                  strokeLinecap="round"
                />
              )}
              <circle
                cx={x(b.meanForecast)}
                cy={y(b.observed)}
                r={4 + 5 * Math.sqrt(b.count / maxCount)}
                fill="var(--color-text)"
                stroke="var(--color-surface)"
                strokeWidth={2}
              />
              {/* A generous invisible hit target. */}
              <circle cx={x(b.meanForecast)} cy={y(b.observed)} r={16} fill="transparent" />
            </g>
          ),
        )}
        <text x={x(0.5)} y={SIZE - 4} textAnchor="middle" fontSize={11} fill="var(--color-muted)">
          What Reckon said
        </text>
        <text x={10} y={y(0.5)} textAnchor="middle" fontSize={11} fill="var(--color-muted)" transform={`rotate(-90 10 ${y(0.5)})`}>
          How often it happened
        </text>
      </svg>
      <figcaption className="mt-2 min-h-10 text-sm" aria-live="polite">
        {shown?.count ? (
          <span>
            Said {pct(shown.lower)}–{pct(shown.upper)} {shown.count} times; it happened {pct(shown.observed)} of the time
            {shown.ci && ` (95% interval ${pct(shown.ci[0])}–${pct(shown.ci[1])})`}.
          </span>
        ) : (
          <span className="text-[var(--color-muted)]">
            {data.n === 0 ? 'Dots appear as questions resolve.' : `Expected calibration error ${data.ece?.toFixed(3) ?? '–'} (0 is perfect).`}
          </span>
        )}
      </figcaption>
      <details className="mt-2 text-sm">
        <summary className="min-h-11 cursor-pointer py-2 text-[var(--color-muted)]">Show as a table</summary>
        <table className="w-full text-left tabular-nums">
          <caption className="sr-only">Reliability bins</caption>
          <thead className="text-[var(--color-muted)]">
            <tr>
              <th scope="col" className="py-1 pr-3 font-medium">
                Said
              </th>
              <th scope="col" className="py-1 pr-3 font-medium">
                Forecasts
              </th>
              <th scope="col" className="py-1 pr-3 font-medium">
                Happened
              </th>
              <th scope="col" className="py-1 font-medium">
                95% interval
              </th>
            </tr>
          </thead>
          <tbody>
            {data.bins.map((b) => (
              <tr key={b.lower} className="border-t border-[var(--color-line)]">
                <th scope="row" className="py-1 pr-3 font-normal">
                  {pct(b.lower)}–{pct(b.upper)}
                </th>
                <td className="py-1 pr-3">{b.count}</td>
                <td className="py-1 pr-3">{pct(b.observed)}</td>
                <td className="py-1">{b.ci ? `${pct(b.ci[0])}–${pct(b.ci[1])}` : '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

function Calibration() {
  const [forecaster, setForecaster] = useState<string | undefined>(undefined);
  const cal = useQuery({ queryKey: ['calibration', forecaster ?? 'shown'], queryFn: () => api.calibration(forecaster) });
  return (
    <Card className="mt-3">
      <label className="text-sm text-[var(--color-muted)]">
        Forecaster
        <select className={`${inputClass} mt-1`} value={forecaster ?? ''} onChange={(e) => setForecaster(e.target.value || undefined)}>
          <option value="">What Reckon showed you</option>
          {cal.data?.forecasters.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </label>
      {cal.isError && <Alert>{cal.error.message}</Alert>}
      {cal.data && <Reliability data={cal.data} />}
    </Card>
  );
}

function Templates({ board }: { board: ScoreboardResponse }) {
  if (!board.templates.length) return <Muted className="mt-3">Brier scores appear here once the first questions resolve.</Muted>;
  return (
    <div className="mt-3 space-y-4">
      {board.templates.map((t) => (
        <Card key={t.templateId}>
          <h3 className="flex items-center gap-2 font-semibold">
            <span
              aria-hidden
              className="inline-block h-3 w-3 rounded-full"
              style={{ background: `linear-gradient(135deg, ${DOMAIN_GRADIENT[t.domain].join(', ')})` }}
            />
            <code className="text-sm">{t.templateId}</code>
            <span className="text-sm font-normal text-[var(--color-muted)]">· {t.questions} resolved</span>
          </h3>
          <Muted className="mt-1 text-sm">{t.description}</Muted>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm tabular-nums">
              <caption className="sr-only">Mean Brier score per forecaster for {t.templateId}; lower is better</caption>
              <thead className="text-[var(--color-muted)]">
                <tr>
                  <th scope="col" className="py-1 pr-3 font-medium">
                    Forecaster
                  </th>
                  <th scope="col" className="py-1 pr-3 font-medium">
                    Brier
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    Track record
                  </th>
                </tr>
              </thead>
              <tbody>
                {t.forecasters.map((f) => (
                  <tr key={f.forecasterId} className="border-t border-[var(--color-line)] align-top">
                    <th scope="row" className="py-2 pr-3 font-medium">
                      {f.name}
                      {f.champion && <span className="ml-1 text-xs font-normal text-[var(--color-muted)]">(shown)</span>}
                      <span className="block text-xs font-normal text-[var(--color-muted)]">{f.n} forecasts</span>
                    </th>
                    <td className="py-2 pr-3">{f.meanBrier.toFixed(3)}</td>
                    <td className="py-2">
                      <TrustBadge trust={f.trust} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ))}
    </div>
  );
}

/** Scoreboard v1 (spec 04-design): is any of this working? Brier per template and forecaster, and calibration. */
export function Scoreboard() {
  const me = useMe();
  const board = useQuery({ queryKey: ['scoreboard'], queryFn: api.scoreboard, enabled: me.isSuccess });
  const resolved = board.data?.resolvedClusters ?? me.data?.stats.resolvedDays ?? 0;
  const needed = board.data?.clustersNeeded ?? me.data?.stats.daysForTrust ?? 30;
  return (
    <section aria-labelledby="score-heading">
      <Heading id="score-heading">{resolved >= needed ? 'Enough data to judge' : 'Nothing proven yet'}</Heading>
      <Muted className="mt-3 max-w-prose">
        Reckon earns a trust label only after {needed} independent days of resolved forecasts beat the historical base rate with 95% confidence. Until then
        every number says "learning". Brier score: 0 is perfect, 0.25 is a coin flip.
      </Muted>
      <Progress resolved={resolved} needed={needed} />
      {board.isError && <Alert>{board.error.message}</Alert>}
      <SectionTitle>Calibration</SectionTitle>
      <Calibration />
      <SectionTitle>By question type</SectionTitle>
      {board.data && <Templates board={board.data} />}
    </section>
  );
}
