import type { ButtonHTMLAttributes, ReactNode } from 'react';

/** Small shared building blocks. Touch targets are at least 44 × 44 px (spec 04-design). */

export function Button({
  variant = 'primary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'quiet' | 'danger' }) {
  const styles = {
    primary: 'bg-[var(--color-text)] text-[var(--color-bg)] hover:opacity-90',
    quiet: 'border border-[var(--color-line)] text-[var(--color-text)] hover:bg-[var(--color-surface)]',
    danger: 'border border-[var(--color-miss)] text-[var(--color-miss)] hover:bg-[var(--color-surface)]',
  }[variant];
  return (
    <button
      type="button"
      {...props}
      className={`min-h-11 rounded-full px-5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${styles} ${className}`}
    />
  );
}

export function Heading({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h1 id={id} className="font-[family-name:var(--font-display)] text-4xl font-bold tracking-tight">
      {children}
    </h1>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="mt-10 text-xs font-semibold uppercase tracking-[0.14em] text-[var(--color-muted)]">{children}</h2>;
}

export function Muted({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <p className={`text-[var(--color-muted)] ${className}`}>{children}</p>;
}

export function Alert({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="mt-6 rounded-2xl border border-[var(--color-miss)]/40 px-4 py-3 text-sm text-[var(--color-miss)]">
      {children}
    </p>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-3xl border border-[var(--color-line)] bg-[var(--color-surface)] p-5 ${className}`}>{children}</div>;
}

export const inputClass =
  'min-h-11 w-full rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] px-3 text-[var(--color-text)] placeholder:text-[var(--color-muted)]';

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
