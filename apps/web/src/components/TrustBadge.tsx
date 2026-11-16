import type { BriefItem } from '@reckon/contracts';

const DOT: Record<BriefItem['trust']['status'], string> = {
  learning: 'bg-[var(--color-muted)]',
  baseline: 'bg-[var(--color-muted)]',
  proven: 'bg-[var(--color-hit)]',
  no_edge: 'bg-amber-400',
  worse: 'bg-[var(--color-miss)]',
};

/** Spec §3.5: every probability carries its forecaster's track record. Shape and words, not just colour. */
export function TrustBadge({ trust }: { trust: BriefItem['trust'] }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-[var(--color-line)] px-2.5 py-0.5 text-xs text-[var(--color-muted)]">
      <span aria-hidden="true" className={`size-1.5 rounded-full ${DOT[trust.status]}`} />
      {trust.text}
    </span>
  );
}
