import { err, type Incident, type IncidentList, ok, type Result, type SourceError, type SourceSnapshot, type StatusPagePort } from '@reckon/core';
import { z } from 'zod';
import { type FetchLike, httpGetText } from '../http';
import { parse } from '../parse';

/** Public Atlassian Statuspage v2 API, by host. Endpoint, limits and terms are recorded in SOURCE.md. */

export interface StatusPageOptions {
  readonly userAgent: string;
  readonly fetchImpl?: FetchLike;
  readonly now?: () => Date;
  /** Replaces `https://{host}` (tests). */
  readonly base?: string;
}

/** Statuspage lists only this many of the most recent incidents. */
const MAX_INCIDENTS = 50;
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
// A public DNS name with at least one dot; no ports, paths, userinfo or IPv6 brackets.
const HOST = new RegExp(`^(?=.{1,253}$)${LABEL}(?:\\.${LABEL})+$`);

/** The host is caller-supplied, so refuse anything that could point the fetch at a private or local address. */
export function isPublicHost(host: string): boolean {
  if (!HOST.test(host)) return false;
  const tld = host.slice(host.lastIndexOf('.') + 1);
  return !/^\d+$/.test(tld) && tld !== 'localhost';
}

const instant = z.iso.datetime({ offset: true }).transform((s) => new Date(s).toISOString());
const IncidentsResponse = z.object({
  page: z.object({ name: z.string(), url: z.string() }),
  incidents: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      created_at: instant,
      // Unknown values fail the parse on purpose: a new impact level should be noticed, not guessed.
      impact: z.enum(['none', 'minor', 'major', 'critical']),
      shortlink: z.string().nullish(),
    }),
  ),
});

export class StatusPageAdapter implements StatusPagePort {
  static readonly id = 'statuspage';
  constructor(private readonly o: StatusPageOptions) {}

  url(host: string): string {
    return `${this.o.base ?? `https://${host}`}/api/v2/incidents.json`;
  }

  async incidents(host: string): Promise<Result<SourceSnapshot<IncidentList>, SourceError>> {
    const id = StatusPageAdapter.id;
    const service = host.toLowerCase();
    if (!isPublicHost(service)) return err({ code: 'not_found', sourceId: id, detail: `invalid host '${host}'` });
    const url = this.url(service);
    const raw = await httpGetText(url, { sourceId: id, userAgent: this.o.userAgent, ...(this.o.fetchImpl ? { fetchImpl: this.o.fetchImpl } : {}) });
    if (!raw.ok) return raw;
    const parsed = parse(IncidentsResponse, raw.value, id);
    if (!parsed.ok) return parsed;
    const { page, incidents } = parsed.value;
    const pageUrl = page.url.replace(/\/+$/, '');
    const list: Incident[] = incidents
      .map((i) => ({ id: i.id, name: i.name, impact: i.impact, createdAt: i.created_at, url: i.shortlink || `${pageUrl}/incidents/${i.id}` }))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    const parsedList: IncidentList = { service, pageName: page.name, incidents: list, complete: incidents.length < MAX_INCIDENTS };
    return ok({ sourceId: id, fetchedAt: (this.o.now?.() ?? new Date()).toISOString(), requestUrl: url, raw: raw.value, parsed: parsedList });
  }
}
