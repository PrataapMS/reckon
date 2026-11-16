import { buildPreviewBrief, ok } from '@reckon/core';
import type { Container } from '@reckon/runtime';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { hashPassphrase, verifyPassphrase } from '../src/passphrase';

const clock = { now: () => new Date('2026-10-05T01:00:00Z') };
const snapshot = <T>(parsed: T) =>
  ok({ sourceId: 'fake', fetchedAt: clock.now().toISOString(), requestUrl: 'https://api.open-meteo.com/v1/forecast?x=1', raw: '{}', parsed });

async function container(overrides: Partial<Container['config']> = {}): Promise<Container> {
  return {
    config: { DEFAULT_LAT: 12.97, DEFAULT_LON: 77.59, DEFAULT_TZ: 'Asia/Kolkata', CONTACT_EMAIL: 't', EVIDENCE_DIR: '.data/evidence', ...overrides },
    clock,
    logger: { info() {}, warn() {}, error() {} },
    previewBrief: buildPreviewBrief({
      clock,
      weather: {
        dailyForecast: async () =>
          snapshot([
            { date: '2026-10-05', precipProbabilityMax: 80, precipSumMm: 4, tempMaxC: 29 },
            { date: '2026-10-06', precipProbabilityMax: 20, precipSumMm: 0, tempMaxC: 36 },
          ]),
      },
      air: {
        dailyForecast: async () =>
          snapshot([
            { date: '2026-10-05', usAqiMax: 90 },
            { date: '2026-10-06', usAqiMax: 170 },
          ]),
      },
    }),
  };
}

describe('API', () => {
  it('reports health without a database', async () => {
    const res = await createApp(await container()).request('/api/v1/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', database: 'not_configured' });
  });

  it('serves a preview brief with actions and an honest learning label', async () => {
    const res = await createApp(await container()).request('/api/v1/brief/preview');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { trust: string; items: { id: string; action: string; percent: number }[] };
    expect(body.trust).toBe('learning');
    expect(body.items.find((i) => i.id === 'rain-today')).toMatchObject({ percent: 80, action: 'Take an umbrella' });
    expect(body.items.find((i) => i.id === 'aqi-tomorrow')?.action).toBe('Consider a mask outdoors');
  });

  it('rejects an invalid location with problem details', async () => {
    const res = await createApp(await container()).request('/api/v1/brief/preview?lat=200');
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
  });

  it('signs in with the right passphrase and protects personal routes', async () => {
    const hash = await hashPassphrase('correct horse');
    const app = createApp(await container({ SESSION_SECRET: 'x'.repeat(32), PASSPHRASE_HASH: hash }));
    expect((await app.request('/api/v1/me')).status).toBe(401);
    const bad = await app.request('/api/v1/session', {
      method: 'POST',
      body: JSON.stringify({ passphrase: 'nope' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(bad.status).toBe(401);
    const good = await app.request('/api/v1/session', {
      method: 'POST',
      body: JSON.stringify({ passphrase: 'correct horse' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(good.status).toBe(204);
    const cookie = good.headers.get('set-cookie')?.split(';')[0] ?? '';
    // Signed in, but this container has no database: personal routes explain what is missing.
    const me = await app.request('/api/v1/me', { headers: { cookie } });
    expect(me.status).toBe(503);
    expect(await me.json()).toMatchObject({ type: 'config/missing' });
  });

  it('verifies scrypt hashes and rejects tampered ones', async () => {
    const h = await hashPassphrase('p');
    expect(await verifyPassphrase('p', h)).toBe(true);
    expect(await verifyPassphrase('q', h)).toBe(false);
    expect(await verifyPassphrase('p', 'garbage')).toBe(false);
  });
});
