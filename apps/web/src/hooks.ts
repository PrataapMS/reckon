import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ApiError, api } from './api';

/** The signed-in user's settings and places. Shared by every screen through the query cache. */
export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: api.me,
    retry: (n, e) => !(e instanceof ApiError && e.status > 0 && e.status < 500) && n < 2,
    staleTime: 60_000,
  });
}

/** Personal features need a database and a passphrase; without them Reckon shows the live preview. */
export function isPreviewOnly(e: unknown): boolean {
  return e instanceof ApiError && (e.type === 'config/missing' || e.type === 'setup/no_user');
}

export function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const m = window.matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setReduce(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return reduce;
}

export function untilText(target: Date, now: Date): string {
  const mins = Math.max(0, Math.round((target.getTime() - now.getTime()) / 60_000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? `${h} h ${m} min` : `${m} min`;
}
