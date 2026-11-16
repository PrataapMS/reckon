import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { addDays, calendarDistance, isoWithOffset, localDate, localDayWindow, localMinutes, relativeDay, zonedTimeToUtc } from '../src/domain/dates';

describe('local calendar helpers', () => {
  it('finds the local date and time in a timezone', () => {
    const t = new Date('2026-10-05T23:15:00Z'); // 04:45 IST on 6 Oct
    expect(localDate(t, 'Asia/Kolkata')).toBe('2026-10-06');
    expect(localMinutes(t, 'Asia/Kolkata')).toBe(4 * 60 + 45);
    expect(localDate(t, 'America/New_York')).toBe('2026-10-05');
  });

  it('converts a local wall time to UTC, including half-hour offsets', () => {
    expect(zonedTimeToUtc('2026-10-06', 6 * 60 + 30, 'Asia/Kolkata').toISOString()).toBe('2026-10-06T01:00:00.000Z');
    expect(zonedTimeToUtc('2026-10-06', 0, 'Europe/London').toISOString()).toBe('2026-10-05T23:00:00.000Z');
  });

  it('gives 23- and 25-hour local days across DST changes', () => {
    const spring = localDayWindow('2026-03-08', 'America/New_York');
    const fall = localDayWindow('2026-11-01', 'America/New_York');
    expect((spring.end.getTime() - spring.start.getTime()) / 3_600_000).toBe(23);
    expect((fall.end.getTime() - fall.start.getTime()) / 3_600_000).toBe(25);
  });

  it('round-trips any instant through its local date and minutes', () => {
    const zones = ['Asia/Kolkata', 'Europe/London', 'America/New_York', 'Australia/Adelaide', 'UTC'];
    fc.assert(
      fc.property(fc.integer({ min: Date.UTC(2020, 0, 1), max: Date.UTC(2030, 0, 1) }), fc.constantFrom(...zones), (ms, tz) => {
        const t = new Date(Math.floor(ms / 60_000) * 60_000);
        const back = zonedTimeToUtc(localDate(t, tz), localMinutes(t, tz), tz);
        // Ambiguous fall-back hours may map to the other occurrence; both are an hour apart at most.
        expect(Math.abs(back.getTime() - t.getTime())).toBeLessThanOrEqual(3_600_000);
      }),
    );
  });

  it('writes ISO timestamps with the local offset', () => {
    const { start } = localDayWindow('2026-10-06', 'Asia/Kolkata');
    expect(isoWithOffset(start, 'Asia/Kolkata')).toBe('2026-10-06T00:00:00+05:30');
    expect(isoWithOffset(new Date('2026-07-01T12:00:00Z'), 'America/New_York')).toBe('2026-07-01T08:00:00-04:00');
  });

  it('measures calendar distance around the new year', () => {
    expect(calendarDistance('2020-12-30', '2026-01-02')).toBe(3);
    expect(calendarDistance('2015-10-01', '2026-10-08')).toBe(7);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('describes days relative to today', () => {
    expect(relativeDay('2026-10-06', '2026-10-06')).toBe('today');
    expect(relativeDay('2026-10-07', '2026-10-06')).toBe('tomorrow');
    expect(relativeDay('2026-10-09', '2026-10-06')).toBe('on Friday');
  });
});
