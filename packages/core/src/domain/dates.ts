/**
 * Local-calendar helpers. Questions are about a location's local day, so every date here is a
 * 'YYYY-MM-DD' string in that location's timezone. Intl is deterministic given its inputs, so
 * this stays pure domain code.
 */

const partsCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = partsCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    partsCache.set(tz, f);
  }
  return f;
}

interface LocalParts {
  readonly date: string;
  readonly minutes: number; // minutes since local midnight
  readonly seconds: number;
}

function localParts(at: Date, tz: string): LocalParts {
  const p: Record<string, string> = {};
  for (const part of formatter(tz).formatToParts(at)) p[part.type] = part.value;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    minutes: Number(p.hour) * 60 + Number(p.minute),
    seconds: Number(p.second),
  };
}

/** The local calendar date at an instant. */
export function localDate(at: Date, tz: string): string {
  return localParts(at, tz).date;
}

/** Minutes since local midnight at an instant. */
export function localMinutes(at: Date, tz: string): number {
  return localParts(at, tz).minutes;
}

/** 'HH:MM' or 'HH:MM:SS' to minutes since midnight. */
export function timeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m ?? 0);
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Whole days from a to b (b - a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/**
 * The UTC instant of a local wall-clock time on a local date. Handles DST by correcting the
 * offset twice; for a skipped wall time (spring forward) it returns the instant just after.
 */
export function zonedTimeToUtc(date: string, minutes: number, tz: string): Date {
  const wallAsUtc = Date.parse(`${date}T00:00:00Z`) + minutes * 60_000;
  let guess = wallAsUtc;
  for (let i = 0; i < 2; i++) {
    const p = localParts(new Date(guess), tz);
    const shownAsUtc = Date.parse(`${p.date}T00:00:00Z`) + p.minutes * 60_000 + p.seconds * 1000;
    guess += wallAsUtc - shownAsUtc;
  }
  return new Date(guess);
}

/** [start, end) of a local day as UTC instants. */
export function localDayWindow(date: string, tz: string): { readonly start: Date; readonly end: Date } {
  return { start: zonedTimeToUtc(date, 0, tz), end: zonedTimeToUtc(addDays(date, 1), 0, tz) };
}

/** ISO 8601 with the local UTC offset, e.g. '2026-10-06T00:00:00+05:30' (criteria windows). */
export function isoWithOffset(at: Date, tz: string): string {
  const p = localParts(at, tz);
  const wallAsUtc = Date.parse(`${p.date}T00:00:00Z`) + p.minutes * 60_000 + p.seconds * 1000;
  const offsetMin = Math.round((wallAsUtc - at.getTime()) / 60_000);
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  const h = String(Math.floor(p.minutes / 60)).padStart(2, '0');
  const m = String(p.minutes % 60).padStart(2, '0');
  const s = String(p.seconds).padStart(2, '0');
  return `${p.date}T${h}:${m}:${s}${sign}${hh}:${mm}`;
}

/** Day-of-year distance on a circular calendar (so 30 Dec and 2 Jan are 3 days apart). */
export function calendarDistance(a: string, b: string): number {
  // Day of year on a fixed non-leap calendar, so leap years do not shift later dates (29 Feb ≈ 28 Feb).
  const doy = (s: string) => {
    const month = Number(s.slice(5, 7)) - 1;
    const day = Math.min(Number(s.slice(8, 10)), month === 1 ? 28 : 31);
    return Math.round((Date.UTC(2001, month, day) - Date.UTC(2001, 0, 1)) / 86_400_000);
  };
  const diff = Math.abs(doy(a) - doy(b));
  return Math.min(diff, 365 - diff);
}

/** 'YYYY-MM-DD' to 'Tue 6 Oct'. The date is already local, so it is formatted as UTC. */
export function humanDate(isoDate: string): string {
  return new Date(`${isoDate}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/** 'today', 'tomorrow', or a weekday name relative to a local date. */
export function relativeDay(target: string, today: string): string {
  const d = daysBetween(today, target);
  if (d === 0) return 'today';
  if (d === 1) return 'tomorrow';
  if (d === -1) return 'yesterday';
  const weekday = new Date(`${target}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
  return d > 1 && d < 7 ? `on ${weekday}` : `on ${humanDate(target)}`;
}
