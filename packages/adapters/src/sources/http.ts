import { err, ok, type Result, type SourceError } from '@reckon/core';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpGetOptions {
  readonly sourceId: string;
  readonly userAgent: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: FetchLike;
  /** Defaults to application/json. */
  readonly accept?: string;
  /** Extra request headers (conditional-request validators, auth). */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface HttpResponse {
  readonly status: number; // 200 or 304
  readonly text: string;
  readonly headers: Headers;
  readonly contentType: string | null;
}

/**
 * GET with an 8 s timeout and one jittered retry on 5xx or network failure (spec §3.1). 304 is
 * a success with an empty body, so conditional requests can tell "nothing new" from an error.
 */
export async function httpGet(url: string, o: HttpGetOptions): Promise<Result<HttpResponse, SourceError>> {
  const doFetch = o.fetchImpl ?? fetch;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await doFetch(url, {
        headers: { 'User-Agent': o.userAgent, Accept: o.accept ?? 'application/json', ...o.headers },
        signal: AbortSignal.timeout(o.timeoutMs ?? 8_000),
      });
      if (res.status === 304) return ok({ status: 304, text: '', headers: res.headers, contentType: res.headers.get('content-type') });
      if (res.status === 429) return err({ code: 'rate_limited', sourceId: o.sourceId });
      if (res.status === 404) return err({ code: 'not_found', sourceId: o.sourceId });
      if (res.status >= 500) {
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, 250 + Math.random() * 500));
          continue;
        }
        return err({ code: 'upstream_5xx', sourceId: o.sourceId, detail: String(res.status) });
      }
      if (!res.ok) return err({ code: 'schema_changed', sourceId: o.sourceId, detail: `HTTP ${res.status}` });
      return ok({ status: res.status, text: await res.text(), headers: res.headers, contentType: res.headers.get('content-type') });
    } catch (e) {
      const name = e instanceof Error ? e.name : '';
      if (attempt === 0 && name !== 'TimeoutError') continue;
      return err({ code: name === 'TimeoutError' ? 'timeout' : 'network', sourceId: o.sourceId, detail: String(e) });
    }
  }
  return err({ code: 'network', sourceId: o.sourceId });
}

/** GET a body as text; any non-2xx is a SourceError. */
export async function httpGetText(url: string, o: HttpGetOptions): Promise<Result<string, SourceError>> {
  const r = await httpGet(url, o);
  return r.ok ? ok(r.value.text) : r;
}
