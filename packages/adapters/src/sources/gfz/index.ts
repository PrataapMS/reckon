import { err, type KpHistoryPort, type KpPoint, ok, type Result, type SourceError, type SourceSnapshot } from '@reckon/core';
import { z } from 'zod';
import { type FetchLike, httpGetText } from '../http';
import { parse } from '../parse';

/**
 * GFZ Potsdam Kp index (definitive since 1932, nowcast for recent days). Licensed CC BY 4.0: the
 * UI must credit GFZ. Endpoint, terms and quirks are in SOURCE.md.
 */
export const GFZ_KP_ATTRIBUTION = 'Kp index: GFZ German Research Centre for Geosciences (CC BY 4.0)';

export interface GfzKpOptions {
  readonly userAgent: string;
  readonly fetchImpl?: FetchLike;
  readonly now?: () => Date;
  /** JSON endpoint (default https://kp.gfz.de/app/json/). */
  readonly base?: string;
}

const BASE = 'https://kp.gfz.de/app/json/';

const KpResponse = z.object({ Kp: z.array(z.number()), datetime: z.array(z.string()) });

/** GFZ answers HTTP 500 to anything but 'YYYY-MM-DDTHH:MM:SSZ' (no milliseconds, no bare dates). */
function gfzInstant(s: string): string | null {
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export class GfzKpAdapter implements KpHistoryPort {
  static readonly id = 'gfz.kp';
  constructor(private readonly o: GfzKpOptions) {}

  url(q: { readonly start: string; readonly end: string }): string | null {
    const start = gfzInstant(q.start);
    const end = gfzInstant(q.end);
    if (start === null || end === null) return null;
    const u = new URL(this.o.base ?? BASE);
    u.searchParams.set('start', start);
    u.searchParams.set('end', end);
    u.searchParams.set('index', 'Kp');
    return u.toString();
  }

  async kpHistory(q: { readonly start: string; readonly end: string }): Promise<Result<SourceSnapshot<KpPoint[]>, SourceError>> {
    const id = GfzKpAdapter.id;
    const url = this.url(q);
    if (url === null) return err({ code: 'schema_changed', sourceId: id, detail: `invalid window ${q.start}..${q.end}` });
    const raw = await httpGetText(url, { sourceId: id, userAgent: this.o.userAgent, ...(this.o.fetchImpl ? { fetchImpl: this.o.fetchImpl } : {}) });
    if (!raw.ok) return raw;
    const parsed = parse(KpResponse, raw.value, id);
    if (!parsed.ok) return parsed;
    const { Kp: values, datetime } = parsed.value;
    if (values.length !== datetime.length)
      return err({ code: 'schema_changed', sourceId: id, detail: `${values.length} Kp values for ${datetime.length} times` });
    const points: KpPoint[] = [];
    for (const [i, t] of datetime.entries()) {
      const ms = Date.parse(t);
      if (Number.isNaN(ms)) return err({ code: 'schema_changed', sourceId: id, detail: `bad datetime ${t}` });
      const kp = values[i];
      // GFZ's other products mark missing values with negatives; treat anything off the 0..9 scale as absent.
      if (kp === undefined || kp < 0 || kp > 9) continue;
      points.push({ time: new Date(ms).toISOString(), kp });
    }
    return ok({ sourceId: id, fetchedAt: (this.o.now?.() ?? new Date()).toISOString(), requestUrl: url, raw: raw.value, parsed: points });
  }
}
