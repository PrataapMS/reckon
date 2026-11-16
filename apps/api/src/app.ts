import {
  BriefResponse,
  CalibrationQuery,
  CalibrationResponse,
  GeocodeResponse,
  HealthResponse,
  LocationInput,
  LocationPatch,
  LocationResponse,
  MePatch,
  MeResponse,
  PreviewBriefQuery,
  PreviewBriefResponse,
  PushSubscribeRequest,
  PushUnsubscribeRequest,
  QuestionDetailResponse,
  QuestionListResponse,
  RevealResponse,
  ScoreboardResponse,
  SessionRequest,
  TelegramLinkResponse,
  TopicCreate,
  TopicsResponse,
} from '@reckon/contracts';
import { MAX_LIST_DAYS } from '@reckon/core';
import type { AppServices, Container } from '@reckon/runtime';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie';
import { etag } from 'hono/etag';
import { verifyPassphrase } from './passphrase';
import { telegramRoutes } from './telegram';

type Env = { Variables: { userId: string; app: AppServices } };

const SESSION_COOKIE = 'reckon_session';
const SESSION_DAYS = 30;

/** RFC 9457 problem details (spec §15). */
export function problem(c: Context, status: 400 | 401 | 403 | 404 | 409 | 429 | 500 | 502 | 503, type: string, title: string, detail?: string) {
  return c.json({ type, title, status, ...(detail ? { detail } : {}) }, status, { 'Content-Type': 'application/problem+json' });
}

/** Very small fixed-window limiter; good enough for a single-user app (spec §15: 60/min). */
function rateLimit(limit: number, windowMs: number): MiddlewareHandler {
  const hits = new Map<string, { n: number; reset: number }>();
  return async (c, next) => {
    const key = c.req.header('x-nf-client-connection-ip') ?? c.req.header('x-forwarded-for') ?? 'local';
    const now = Date.now();
    const h = hits.get(key);
    if (!h || h.reset < now) hits.set(key, { n: 1, reset: now + windowMs });
    else if (++h.n > limit) return problem(c, 429, 'rate/limited', 'Too many requests');
    await next();
  };
}

export function createApp(container: Container) {
  const { config } = container;
  const app = new Hono<Env>().basePath('/api/v1');

  app.use('*', rateLimit(60, 60_000));
  app.use('/session', rateLimit(5, 15 * 60_000));

  const requireSession: MiddlewareHandler<Env> = async (c, next) => {
    if (!config.SESSION_SECRET) return problem(c, 503, 'config/missing', 'SESSION_SECRET is not configured');
    const v = await getSignedCookie(c, config.SESSION_SECRET, SESSION_COOKIE);
    if (!v || Number(v) < Date.now()) return problem(c, 401, 'auth/required', 'Sign in to continue');
    await next();
  };

  /** Session plus the single user (spec §2.5: single user; the schema keeps user_id for later). */
  const requireUser: MiddlewareHandler<Env> = async (c, next) => {
    const app = container.db?.app;
    if (!app) return problem(c, 503, 'config/missing', 'The database is not configured', 'Set DATABASE_URL');
    const userId = await app.primaryUserId();
    if (!userId) return problem(c, 503, 'setup/no_user', 'No user exists yet', 'Run pnpm db:seed');
    c.set('userId', userId);
    c.set('app', app);
    await next();
  };
  const authed = [requireSession, requireUser] as const;

  app.get('/health', async (c) => {
    let database: HealthResponse['database'] = 'not_configured';
    let queueDepth: number | null = null;
    let jobs: HealthResponse['jobs'] = [];
    if (container.db) {
      try {
        [queueDepth, jobs] = await Promise.all([container.db.health.queueDepth(), container.db.health.jobRuns()]);
        database = 'ok';
      } catch (e) {
        database = 'unavailable';
        container.logger.error('health.db_unavailable', { error: String(e) });
      }
    }
    const body = HealthResponse.parse({
      status: database === 'unavailable' ? 'degraded' : 'ok',
      time: container.clock.now().toISOString(),
      database,
      queueDepth,
      jobs,
    });
    return c.json(body);
  });

  app.post('/session', async (c) => {
    if (!config.SESSION_SECRET || !config.PASSPHRASE_HASH)
      return problem(c, 503, 'config/missing', 'Auth is not configured', 'Set SESSION_SECRET and PASSPHRASE_HASH');
    const parsed = SessionRequest.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return problem(c, 400, 'request/invalid', 'A passphrase is required');
    if (!(await verifyPassphrase(parsed.data.passphrase, config.PASSPHRASE_HASH))) return problem(c, 401, 'auth/invalid', 'That passphrase is not right');
    const expires = Date.now() + SESSION_DAYS * 86_400_000;
    await setSignedCookie(c, SESSION_COOKIE, String(expires), config.SESSION_SECRET, {
      httpOnly: true,
      secure: new URL(c.req.url).protocol === 'https:',
      sameSite: 'Lax',
      path: '/',
      maxAge: SESSION_DAYS * 86_400,
    });
    return c.body(null, 204);
  });

  app.delete('/session', (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.body(null, 204);
  });

  const meBody = (me: NonNullable<Awaited<ReturnType<AppServices['me']>>>) =>
    MeResponse.parse({
      ...me,
      telegramAvailable: Boolean(config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_BOT_USERNAME),
      pushPublicKey: container.db?.app.pushKey ?? null,
    });

  app.get('/me', ...authed, async (c) => {
    const me = await c.var.app.me(c.var.userId);
    return me ? c.json(meBody(me)) : problem(c, 404, 'user/not_found', 'No such user');
  });

  app.patch('/me', ...authed, async (c) => {
    const patch = MePatch.safeParse(await c.req.json().catch(() => null));
    if (!patch.success) return problem(c, 400, 'request/invalid', 'Some settings are not valid', patch.error.message);
    const { displayName, settings, ...rest } = patch.data;
    const me = await c.var.app.updateMe(c.var.userId, {
      ...dropUndefined(rest),
      ...(displayName !== undefined ? { displayName } : {}),
      ...(settings ? { settings: { ...(settings.actionThresholds ? { actionThresholds: dropUndefined(settings.actionThresholds) } : {}) } } : {}),
    });
    return me ? c.json(meBody(me)) : problem(c, 404, 'user/not_found', 'No such user');
  });

  app.get('/locations', ...authed, async (c) => {
    const me = await c.var.app.me(c.var.userId);
    return c.json({ locations: (me?.locations ?? []).map((l) => LocationResponse.parse(l)) });
  });

  app.post('/locations', ...authed, async (c) => {
    const body = LocationInput.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return problem(c, 400, 'request/invalid', 'Name, latitude, longitude and timezone are required', body.error.message);
    const r = await c.var.app.addLocation(c.var.userId, dropUndefined(body.data));
    if (!r.ok) return problem(c, 409, 'location/too_many', 'You already have the maximum number of places');
    return c.json(LocationResponse.parse(r.value), 201);
  });

  app.patch('/locations/:id', ...authed, async (c) => {
    const body = LocationPatch.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return problem(c, 400, 'request/invalid', 'Some fields are not valid', body.error.message);
    const r = await c.var.app.updateLocation(c.var.userId, c.req.param('id'), dropUndefined(body.data));
    return r.ok ? c.json(LocationResponse.parse(r.value)) : problem(c, 404, 'location/not_found', 'No such place');
  });

  app.delete('/locations/:id', ...authed, async (c) => {
    const r = await c.var.app.removeLocation(c.var.userId, c.req.param('id'));
    if (r.ok) return c.body(null, 204);
    return r.error.code === 'last_location'
      ? problem(c, 409, 'location/last', 'Keep at least one place', 'Weather and air questions need a location')
      : problem(c, 404, 'location/not_found', 'No such place');
  });

  /** City search for onboarding when location permission is refused (spec §1.5). */
  app.get('/geocode', ...authed, async (c) => {
    const q = (c.req.query('q') ?? '').trim();
    if (q.length < 2 || q.length > 80) return problem(c, 400, 'request/invalid', 'Type at least two letters');
    if (!container.geocoding) return problem(c, 503, 'config/missing', 'Geocoding is not available');
    const r = await container.geocoding.search(q);
    if (!r.ok) return problem(c, 502, `source/${r.error.code}`, 'City search is unavailable right now');
    c.header('Cache-Control', 'private, max-age=86400');
    return c.json(GeocodeResponse.parse({ results: r.value }));
  });

  app.get('/brief/today', ...authed, etag(), async (c) => {
    const brief = await c.var.app.brief(c.var.userId);
    if (!brief) return problem(c, 404, 'user/not_found', 'No such user');
    c.header('Cache-Control', 'private, no-cache');
    return c.json(BriefResponse.parse(brief));
  });

  app.get('/reveal/:date{latest|\\d{4}-\\d{2}-\\d{2}}', ...authed, etag(), async (c) => {
    const r = await c.var.app.reveal(c.var.userId, c.req.param('date'));
    if (!r) return problem(c, 404, 'user/not_found', 'No such user');
    c.header('Cache-Control', 'private, no-cache');
    return c.json(RevealResponse.parse(r));
  });

  app.get('/questions', ...authed, etag(), async (c) => {
    const isDate = (v: string | undefined): v is string => Boolean(v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)));
    const to = c.req.query('to') ?? new Date(container.clock.now().getTime() + 7 * 86_400_000).toISOString().slice(0, 10);
    const from = c.req.query('from') ?? new Date(Date.parse(to) - 14 * 86_400_000).toISOString().slice(0, 10);
    if (!isDate(from) || !isDate(to) || from > to) return problem(c, 400, 'request/invalid', 'from and to must be dates (YYYY-MM-DD) with from ≤ to');
    if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > MAX_LIST_DAYS)
      return problem(c, 400, 'request/range', `Ask for at most ${MAX_LIST_DAYS} days at a time`);
    const questions = await c.var.app.listQuestions(c.var.userId, from, to);
    if (!questions) return problem(c, 404, 'user/not_found', 'No such user');
    c.header('Cache-Control', 'private, no-cache');
    return c.json(QuestionListResponse.parse({ from, to, questions }));
  });

  app.get('/questions/:id{[0-9a-f-]{36}}', ...authed, etag(), async (c) => {
    const q = await c.var.app.questionDetail(c.var.userId, c.req.param('id'));
    if (!q) return problem(c, 404, 'question/not_found', 'No such question');
    c.header('Cache-Control', 'private, no-cache');
    return c.json(QuestionDetailResponse.parse(q));
  });

  /** Raw snapshot download (spec §3.4 auditability). Content-addressed, so it can be cached forever. */
  app.get('/questions/:id{[0-9a-f-]{36}}/evidence/:eid{[0-9a-f-]{36}}/raw', ...authed, async (c) => {
    const raw = await c.var.app.evidenceRaw(c.var.userId, c.req.param('id'), c.req.param('eid'));
    if (!raw) return problem(c, 404, 'evidence/not_found', 'No such evidence for this question');
    return c.body(raw.body, 200, {
      'Content-Type': raw.contentType,
      'Content-Disposition': `attachment; filename="${raw.filename}"`,
      'Cache-Control': 'private, max-age=31536000, immutable',
    });
  });

  app.get('/scoreboard', ...authed, etag(), async (c) => {
    c.header('Cache-Control', 'private, no-cache');
    return c.json(ScoreboardResponse.parse(await c.var.app.scoreboard(c.var.userId)));
  });

  app.get('/scoreboard/calibration', ...authed, etag(), async (c) => {
    const q = CalibrationQuery.safeParse({ forecaster: c.req.query('forecaster'), template: c.req.query('template') });
    if (!q.success) return problem(c, 400, 'request/invalid', 'forecaster and template must be short identifiers');
    const view = await c.var.app.calibration(c.var.userId, {
      ...(q.data.forecaster ? { forecaster: q.data.forecaster } : {}),
      ...(q.data.template ? { templateId: q.data.template } : {}),
    });
    c.header('Cache-Control', 'private, no-cache');
    return c.json(CalibrationResponse.parse(view));
  });

  app.get('/topics', ...authed, async (c) => c.json(TopicsResponse.parse(await c.var.app.topics(c.var.userId))));

  app.post('/topics', ...authed, async (c) => {
    const body = TopicCreate.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return problem(c, 400, 'request/invalid', 'Send a suggestion key or a label of 2–40 characters');
    const r = await c.var.app.addTopic(c.var.userId, body.data);
    if (r.ok) return c.json(TopicsResponse.parse(r.value), 201);
    if (r.error.code === 'too_many') return problem(c, 409, 'topic/too_many', 'You already follow the maximum number of topics', 'Remove one first');
    return problem(c, 400, `topic/${r.error.code}`, 'That topic cannot be added');
  });

  app.delete('/topics/:id{[0-9a-f-]{36}}', ...authed, async (c) => {
    const r = await c.var.app.removeTopic(c.var.userId, c.req.param('id'));
    return r ? c.json(TopicsResponse.parse(r)) : problem(c, 404, 'topic/not_found', 'No such topic');
  });

  /** Web Push fallback (spec §1.5): one subscription per browser. */
  app.post('/push/subscribe', ...authed, async (c) => {
    if (!c.var.app.pushKey) return problem(c, 503, 'config/missing', 'Web Push is not configured', 'Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY');
    const body = PushSubscribeRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return problem(c, 400, 'request/invalid', 'Send the browser push subscription');
    const r = await c.var.app.subscribePush(c.var.userId, { endpoint: body.data.endpoint, p256dh: body.data.keys.p256dh, auth: body.data.keys.auth });
    return r.ok ? c.body(null, 204) : problem(c, 400, 'push/invalid_endpoint', 'That is not a push service address');
  });

  app.delete('/push/subscribe', ...authed, async (c) => {
    const body = PushUnsubscribeRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return problem(c, 400, 'request/invalid', 'Send the subscription endpoint');
    await c.var.app.unsubscribePush(c.var.userId, body.data.endpoint);
    return c.body(null, 204);
  });

  app.post('/telegram/link', ...authed, async (c) => {
    const link = await c.var.app.telegramLink(c.var.userId);
    if (!link) return problem(c, 503, 'config/missing', 'Telegram is not configured', 'Set TELEGRAM_BOT_TOKEN and TELEGRAM_BOT_USERNAME');
    return c.json(TelegramLinkResponse.parse(link));
  });

  app.route('/telegram', telegramRoutes(container));

  /**
   * Phase 0 preview brief: live, useful, honest. Public in Phase 0 so the PWA works before auth is
   * set up; Phase 1 moves the real brief behind requireSession.
   */
  app.get('/brief/preview', async (c) => {
    const q = PreviewBriefQuery.safeParse({
      lat: c.req.query('lat') ?? config.DEFAULT_LAT,
      lon: c.req.query('lon') ?? config.DEFAULT_LON,
      tz: c.req.query('tz') ?? config.DEFAULT_TZ,
    });
    if (!q.success) return problem(c, 400, 'request/invalid', 'lat, lon and tz must be valid', q.error.message);
    const brief = await container.previewBrief(q.data);
    c.header('Cache-Control', 'private, max-age=600');
    return c.json(PreviewBriefResponse.parse({ ...brief, trust: 'learning' }));
  });

  app.notFound((c) => problem(c, 404, 'route/not_found', 'No such endpoint'));
  app.onError((e, c) => {
    container.logger.error('api.unhandled', { error: e.message, path: c.req.path });
    return problem(c, 500, 'server/error', 'Something failed on our side');
  });

  return app;
}

/** exactOptionalPropertyTypes: Zod's optional keys may be present-but-undefined; strip them. */
function dropUndefined<T extends object>(o: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as { [K in keyof T]: Exclude<T[K], undefined> };
}
