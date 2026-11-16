import {
  BriefResponse,
  CalibrationResponse,
  GeocodeResponse,
  LocationResponse,
  MeResponse,
  PreviewBriefResponse,
  Problem,
  QuestionDetailResponse,
  RevealResponse,
  ScoreboardResponse,
  TelegramLinkResponse,
  TopicsResponse,
} from '@reckon/contracts';
import type { z } from 'zod';

export interface Place {
  lat: number;
  lon: number;
  tz: string;
  label: string;
}

/** An RFC 9457 problem from the API, or a network failure (status 0). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, schema: z.ZodType<T> | null, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      ...init,
      headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
    });
  } catch {
    throw new ApiError(0, 'network', 'Reckon could not reach its server. Check your connection; the last brief stays readable offline.');
  }
  if (!res.ok) {
    const p = Problem.safeParse(await res.json().catch(() => null));
    throw new ApiError(
      res.status,
      p.success ? p.data.type : 'unknown',
      p.success ? (p.data.detail ? `${p.data.title}. ${p.data.detail}` : p.data.title) : `HTTP ${res.status}`,
    );
  }
  if (!schema || res.status === 204) return undefined as T;
  return schema.parse(await res.json());
}

const send = (method: string, body?: unknown): RequestInit => ({ method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

export const api = {
  me: () => request('/me', MeResponse),
  updateMe: (patch: Record<string, unknown>) => request('/me', MeResponse, send('PATCH', patch)),
  login: (passphrase: string) => request('/session', null, send('POST', { passphrase })),
  logout: () => request('/session', null, send('DELETE')),
  brief: () => request('/brief/today', BriefResponse),
  reveal: (date: string) => request(`/reveal/${date}`, RevealResponse),
  question: (id: string) => request(`/questions/${id}`, QuestionDetailResponse),
  geocode: (q: string) => request(`/geocode?${new URLSearchParams({ q })}`, GeocodeResponse),
  addLocation: (body: { name: string; lat: number; lon: number; tz: string; isPrimary?: boolean }) =>
    request('/locations', LocationResponse, send('POST', body)),
  updateLocation: (id: string, body: Record<string, unknown>) => request(`/locations/${id}`, LocationResponse, send('PATCH', body)),
  removeLocation: (id: string) => request(`/locations/${id}`, null, send('DELETE')),
  telegramLink: () => request('/telegram/link', TelegramLinkResponse, send('POST', {})),
  scoreboard: () => request('/scoreboard', ScoreboardResponse),
  calibration: (forecaster?: string) => request(`/scoreboard/calibration${forecaster ? `?${new URLSearchParams({ forecaster })}` : ''}`, CalibrationResponse),
  topics: () => request('/topics', TopicsResponse),
  addTopic: (body: { suggestion: string } | { label: string }) => request('/topics', TopicsResponse, send('POST', body)),
  removeTopic: (id: string) => request(`/topics/${id}`, TopicsResponse, send('DELETE')),
  pushSubscribe: (sub: PushSubscriptionJSON) => request('/push/subscribe', null, send('POST', sub)),
  pushUnsubscribe: (endpoint: string) => request('/push/subscribe', null, send('DELETE', { endpoint })),
  previewBrief: (place: Place | null) =>
    request(
      `/brief/preview${place ? `?${new URLSearchParams({ lat: place.lat.toFixed(2), lon: place.lon.toFixed(2), tz: place.tz })}` : ''}`,
      PreviewBriefResponse,
    ),
};

export const browserTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
