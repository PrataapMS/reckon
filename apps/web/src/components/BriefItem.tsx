import type { BriefItem as BriefItemData, PreviewBriefItem } from '@reckon/contracts';
import { Link } from '@tanstack/react-router';
import { ProbabilityRing } from './ProbabilityRing';
import { TrustBadge } from './TrustBadge';

/**
 * One brief item (spec 04-design): lead with the action, then the probability in words, then the
 * basis and a way to see how it is judged. The lead item gets the big ring.
 */
export function BriefItem({ item, lead = false }: { item: BriefItemData; lead?: boolean }) {
  const world = item.scope === 'world';
  const headline = item.action ?? (world ? item.subject : `${item.subject} ${item.when}`);
  return (
    <article className={lead ? 'flex items-center gap-6 py-6' : 'flex items-center gap-4 border-t border-[var(--color-line)] py-4'}>
      <ProbabilityRing percent={item.percent} domain={item.domain} size={lead ? 132 : 72} />
      <div className="min-w-0">
        <p className="text-sm text-[var(--color-muted)]">
          {world ? `${item.placeName}, resolves ${item.when}` : `${item.subject} at ${item.placeName} ${item.when}`}, {item.label.toLowerCase()}
        </p>
        <h3 className={lead ? 'mt-1 font-[family-name:var(--font-display)] text-3xl font-bold leading-tight' : 'mt-0.5 text-lg font-semibold'}>{headline}</h3>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          {item.basis}{' '}
          <Link
            to="/q/$id"
            params={{ id: item.questionId }}
            className="underline decoration-[var(--color-line)] underline-offset-4 hover:text-[var(--color-text)]"
          >
            How this is judged
          </Link>
        </p>
        <p className="mt-2">
          <TrustBadge trust={item.trust} />
        </p>
      </div>
    </article>
  );
}

/** Phase 0 live preview item: not stored, not scored, labelled as such. */
export function PreviewItem({ item }: { item: PreviewBriefItem }) {
  return (
    <article className="flex items-center gap-4 border-t border-[var(--color-line)] py-4">
      <ProbabilityRing percent={item.percent} domain={item.domain} size={64} />
      <div className="min-w-0">
        <p className="text-sm text-[var(--color-muted)]">
          {item.title}, {item.label.toLowerCase()}
        </p>
        <h3 className="mt-0.5 text-lg font-semibold">{item.action}</h3>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          {item.basis}.{' '}
          <a
            className="underline decoration-[var(--color-line)] underline-offset-4 hover:text-[var(--color-text)]"
            href={item.sourceUrl}
            target="_blank"
            rel="noreferrer"
          >
            See the raw data
          </a>
        </p>
        <p className="mt-2 inline-block rounded-full border border-dashed border-[var(--color-line)] px-2.5 py-0.5 text-xs text-[var(--color-muted)]">
          {item.forecaster}: live preview, not scored
        </p>
      </div>
    </article>
  );
}
