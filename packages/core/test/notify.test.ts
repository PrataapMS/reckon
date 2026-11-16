import { describe, expect, it } from 'vitest';
import { briefMessage, escapeHtml, revealMessage } from '../src/app/notify';
import type { BriefItemView, BriefView, RevealView } from '../src/app/views';
import { describeCriteria } from '../src/domain/describe';
import { decideSend, inQuietHours } from '../src/domain/notify';

const now = new Date('2026-10-06T01:00:00Z');
const base = {
  createdAt: now,
  now,
  localMinutes: 6 * 60 + 30,
  quietStart: 22 * 60 + 30,
  quietEnd: 6 * 60,
  paused: false,
  linked: true,
  scheduledSentToday: 0,
  scheduled: true,
};

describe('notification guardrails', () => {
  it('treats quiet hours that wrap midnight correctly', () => {
    expect(inQuietHours(23 * 60, 22 * 60 + 30, 6 * 60)).toBe(true);
    expect(inQuietHours(5 * 60, 22 * 60 + 30, 6 * 60)).toBe(true);
    expect(inQuietHours(6 * 60, 22 * 60 + 30, 6 * 60)).toBe(false);
    expect(inQuietHours(13 * 60, 12 * 60, 14 * 60)).toBe(true);
  });

  it('sends, waits or skips with a reason', () => {
    expect(decideSend(base)).toEqual({ action: 'send' });
    expect(decideSend({ ...base, localMinutes: 23 * 60 })).toEqual({ action: 'wait' });
    expect(decideSend({ ...base, paused: true })).toEqual({ action: 'skip', reason: 'paused' });
    expect(decideSend({ ...base, scheduledSentToday: 2 })).toEqual({ action: 'skip', reason: 'daily_cap' });
    expect(decideSend({ ...base, scheduledSentToday: 2, scheduled: false })).toEqual({ action: 'send' });
    expect(decideSend({ ...base, createdAt: new Date(now.getTime() - 13 * 3_600_000) })).toEqual({ action: 'skip', reason: 'stale' });
    expect(decideSend({ ...base, linked: false })).toEqual({ action: 'skip', reason: 'not_linked' });
  });
});

const item = (over: Partial<BriefItemView> = {}): BriefItemView => ({
  questionId: 'q1',
  templateId: 'wx.rain_any',
  scope: 'place',
  domain: 'weather',
  class: 'decision',
  subject: 'Rain ≥ 1 mm',
  placeName: 'Home <Office>',
  title: 't',
  targetDate: '2026-10-06',
  when: 'today',
  horizonDays: 1,
  status: 'locked',
  lockAt: now.toISOString(),
  p: 0.72,
  percent: 72,
  label: 'Likely',
  action: 'Take an umbrella',
  forecaster: { id: 'ensemble.openmeteo@1', name: 'Open-Meteo ensemble' },
  basis: '',
  trust: { status: 'learning', clusters: 0, needed: 30, bss: null, ci: null, text: '' },
  ...over,
});

describe('messages', () => {
  it('escapes HTML in every dynamic string', () => {
    expect(escapeHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
  });

  it('builds a brief with actions first and an honest learning note', () => {
    const b: BriefView = {
      date: '2026-10-06',
      tz: 'Asia/Kolkata',
      generatedAt: now.toISOString(),
      today: [item()],
      tomorrow: [item({ class: 'informative', action: null })],
      later: [],
      world: [],
    };
    const m = briefMessage(b, 'https://reckon.example');
    expect(m.text).toContain('<b>Take an umbrella</b>');
    expect(m.text).toContain('Home &lt;Office&gt;');
    expect(m.text).toContain('72%');
    expect(m.text).toContain('learning');
    expect(m.text).not.toContain('Tomorrow'); // only decisions are listed for tomorrow
    expect(m.buttons?.[0]?.url).toBe('https://reckon.example/');
    expect(briefMessage(b, 'http://localhost:5173').buttons).toBeUndefined();
  });

  it('builds a reveal with outcomes, annulments and the score', () => {
    const r: RevealView = {
      date: '2026-10-05',
      sealed: false,
      opensAt: now.toISOString(),
      total: 2,
      cards: [
        {
          questionId: 'a',
          scope: 'place',
          domain: 'weather',
          subject: 'Rain ≥ 1 mm',
          placeName: 'Home',
          title: '',
          status: 'resolved',
          percent: 72,
          outcome: 1,
          observed: '4.3 mm',
          annulReason: null,
          hit: true,
          brier: 0.0784,
          forecasts: [],
        },
        {
          questionId: 'b',
          scope: 'place',
          domain: 'air',
          subject: 'US AQI peak > 150',
          placeName: 'Home',
          title: '',
          status: 'annulled',
          percent: 40,
          outcome: null,
          observed: null,
          annulReason: 'upstream_5xx',
          hit: null,
          brier: null,
          forecasts: [],
        },
      ],
      summary: { hits: 1, misses: 0, pending: 0, annulled: 1, meanBrier: 0.0784 },
    };
    const m = revealMessage(r);
    expect(m.text).toContain('✅ Rain ≥ 1 mm at Home: said 72%, observed 4.3 mm → <b>YES</b>');
    expect(m.text).toContain('annulled (upstream_5xx)');
    expect(m.text).toContain('Brier 0.078');
  });
});

describe('How this is judged', () => {
  it('names the dataset and the rule in plain words', () => {
    const d = describeCriteria({
      kind: 'threshold',
      source: { id: 'openmeteo.forecast', version: '1' },
      missingPolicy: { retryUntilHours: 72, thenOutcome: 'annul' },
      metric: 'precipitation_sum',
      unit: 'mm',
      lat: 12.97,
      lon: 77.59,
      aggregation: 'daily_sum',
      comparator: '>=',
      threshold: 1,
      window: { start: '2026-10-07T00:00:00+05:30', end: '2026-10-08T00:00:00+05:30', tz: 'Asia/Kolkata' },
    });
    expect(d.rule).toContain('at or above 1 mm');
    expect(d.dataset).toContain('Open-Meteo Forecast API');
    expect(d.caveat).toContain('not a rain gauge');
    expect(d.missing).toContain('72 hours');
  });
});
