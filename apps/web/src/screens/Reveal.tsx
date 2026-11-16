import type { RevealCard, RevealResponse } from '@reckon/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { Alert, Button, Heading, Muted } from '../components/ui';
import { DOMAIN_GRADIENT } from '../domain-style';
import { untilText, useNow, usePrefersReducedMotion } from '../hooks';

const humanDate = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const shiftDate = (d: string, n: number) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};

function Outcome({ card }: { card: RevealCard }) {
  if (card.status === 'annulled')
    return (
      <p className="text-sm text-[var(--color-muted)]">
        <span aria-hidden="true">⚪ </span>Annulled: {card.annulReason ?? 'no data'}. Left out of every score.
      </p>
    );
  if (card.outcome == null)
    return (
      <p className="text-sm text-[var(--color-muted)]">
        <span aria-hidden="true">⏳ </span>Still waiting for the source to publish.
      </p>
    );
  return (
    <p className={`text-sm font-semibold ${card.hit ? 'text-[var(--color-hit)]' : 'text-[var(--color-miss)]'}`}>
      <span aria-hidden="true">{card.hit ? '✓ ' : '✗ '}</span>
      {card.outcome ? 'YES' : 'NO'} · {card.hit ? 'Reckon called it' : 'Reckon missed'} · Brier {card.brier?.toFixed(3)}
    </p>
  );
}

/** A sealed card that flips open (spec §1.4, the Reveal ritual). Shape and words carry the outcome, not colour alone. */
function OpenedFace({ card }: { card: RevealCard }) {
  return (
    <>
      <p className="text-sm text-[var(--color-muted)]">
        {card.subject} {card.scope === 'world' ? `· ${card.placeName}` : `at ${card.placeName}`}
      </p>
      <p className="font-[family-name:var(--font-display)] text-2xl font-bold">
        Said {card.percent ?? '–'}% · saw {card.observed ?? '–'}
      </p>
      <Outcome card={card} />
      <Link to="/q/$id" params={{ id: card.questionId }} className="text-sm underline decoration-[var(--color-line)] underline-offset-4">
        Every forecaster and the raw data
      </Link>
    </>
  );
}

function FlipCard({ card, open, onOpen, still }: { card: RevealCard; open: boolean; onOpen: () => void; still: boolean }) {
  const [from, to] = DOMAIN_GRADIENT[card.domain];
  // Reduced motion: no 3D flip at all, just the opened card.
  if (still)
    return (
      <li className="flex min-h-40 flex-col justify-between gap-2 rounded-3xl border border-[var(--color-line)] bg-[var(--color-surface)] p-5">
        <OpenedFace card={card} />
      </li>
    );
  return (
    <li className="[perspective:1200px]">
      <div className={`relative min-h-40 transition-transform duration-700 [transform-style:preserve-3d] ${open ? '[transform:rotateY(180deg)]' : ''}`}>
        <button
          type="button"
          onClick={onOpen}
          aria-hidden={open}
          tabIndex={open ? -1 : 0}
          className="absolute inset-0 flex flex-col justify-between rounded-3xl p-5 text-left text-white [backface-visibility:hidden]"
          style={{ background: `linear-gradient(135deg, ${from}, ${to})` }}
        >
          <span className="text-xs font-semibold uppercase tracking-[0.14em] opacity-80">Sealed</span>
          <span className="font-[family-name:var(--font-display)] text-xl font-bold leading-tight">
            {card.subject} {card.scope === 'world' ? `· ${card.placeName}` : `at ${card.placeName}`}
          </span>
          <span className="text-sm opacity-90">Reckon said {card.percent ?? '–'}%. Tap to reveal.</span>
        </button>
        <div
          aria-hidden={!open}
          className="absolute inset-0 flex flex-col justify-between rounded-3xl border border-[var(--color-line)] bg-[var(--color-surface)] p-5 [backface-visibility:hidden] [transform:rotateY(180deg)]"
        >
          <p className="text-sm text-[var(--color-muted)]">
            {card.subject} {card.scope === 'world' ? `· ${card.placeName}` : `at ${card.placeName}`}
          </p>
          <p className="font-[family-name:var(--font-display)] text-2xl font-bold">
            Said {card.percent ?? '–'}% · saw {card.observed ?? '–'}
          </p>
          <Outcome card={card} />
          <Link
            to="/q/$id"
            params={{ id: card.questionId }}
            className="text-sm underline decoration-[var(--color-line)] underline-offset-4"
            tabIndex={open ? 0 : -1}
          >
            Every forecaster and the raw data
          </Link>
        </div>
      </div>
    </li>
  );
}

function Opened({ data }: { data: RevealResponse }) {
  const reduce = usePrefersReducedMotion();
  const [opened, setOpened] = useState<number>(reduce ? data.cards.length : 0);
  useEffect(() => {
    if (reduce || opened >= data.cards.length) return;
    const id = setTimeout(() => setOpened((n) => n + 1), opened === 0 ? 500 : 350);
    return () => clearTimeout(id);
  }, [opened, reduce, data.cards.length]);
  const s = data.summary;
  const allOpen = opened >= data.cards.length;

  return (
    <>
      <p className="mt-3 text-lg" aria-live="polite">
        {allOpen
          ? s.meanBrier != null
            ? `${s.hits} called, ${s.misses} missed. Average Brier ${s.meanBrier.toFixed(3)}: 0 is perfect, 0.25 is a coin flip.`
            : 'Nothing could be scored for this day yet.'
          : 'Opening…'}
        {allOpen && s.pending > 0 ? ` ${s.pending} still waiting for data.` : ''}
        {allOpen && s.annulled > 0 ? ` ${s.annulled} annulled.` : ''}
      </p>
      <ul className="mt-6 grid gap-4 sm:grid-cols-2">
        {data.cards.map((card, i) => (
          <FlipCard key={card.questionId} card={card} still={reduce} open={i < opened} onOpen={() => setOpened((n) => Math.max(n, i + 1))} />
        ))}
      </ul>
    </>
  );
}

export function Reveal() {
  const [date, setDate] = useState<string>('latest');
  const now = useNow();
  const qc = useQueryClient();
  const reveal = useQuery({ queryKey: ['reveal', date], queryFn: () => api.reveal(date) });
  const data = reveal.data;
  const opensAt = data ? new Date(data.opensAt) : null;

  // When the countdown reaches zero, fetch again: the cards are now allowed out.
  useEffect(() => {
    if (data?.sealed && opensAt && now >= opensAt) void qc.invalidateQueries({ queryKey: ['reveal', date] });
  }, [now, data?.sealed, opensAt, qc, date]);

  return (
    <section aria-labelledby="reveal-heading">
      {reveal.isPending && <Muted>Loading the reveal…</Muted>}
      {reveal.isError && <Alert>{reveal.error.message}</Alert>}
      {data && (
        <>
          <Heading id="reveal-heading">{data.sealed && opensAt ? `Sealed for ${untilText(opensAt, now)}` : 'The Reveal'}</Heading>
          <Muted className="mt-2">
            {humanDate(data.date)}
            {data.sealed ? ` · ${data.total} claims open at ${opensAt?.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}
          </Muted>
          {data.sealed && (
            <Muted className="mt-4 max-w-prose">
              Each claim opens against what actually happened: the observed value, the outcome, and how every forecaster scored.
            </Muted>
          )}
          {!data.sealed && data.cards.length === 0 && <Muted className="mt-6">Nothing was asked about this day.</Muted>}
          {!data.sealed && data.cards.length > 0 && <Opened key={data.date} data={data} />}
          <div className="mt-8 flex gap-3">
            <Button variant="quiet" onClick={() => setDate(shiftDate(data.date, -1))}>
              ← Earlier day
            </Button>
            {date !== 'latest' && (
              <Button variant="quiet" onClick={() => setDate('latest')}>
                Latest
              </Button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
