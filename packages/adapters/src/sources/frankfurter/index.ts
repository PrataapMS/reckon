import { err, type FxPort, type FxRate, ok, type Result, type SourceError, type SourceSnapshot } from '@reckon/core';
import { z } from 'zod';
import { type FetchLike, httpGetText } from '../http';
import { parse } from '../parse';

/** Frankfurter v1: ECB reference rates only. Endpoint, terms and quirks are in SOURCE.md. */

export interface FrankfurterOptions {
  readonly userAgent: string;
  readonly fetchImpl?: FetchLike;
  readonly now?: () => Date;
  /** API root, without a trailing slash (default https://api.frankfurter.dev/v1). */
  readonly base?: string;
}

type FxQuery = Parameters<FxPort['dailyRates']>[0];

const BASE = 'https://api.frankfurter.dev/v1';
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const RangeResponse = z.object({
  base: z.string(),
  rates: z.record(z.string().regex(DATE), z.record(z.string(), z.number().positive())),
});

export class FrankfurterAdapter implements FxPort {
  static readonly id = 'frankfurter';
  constructor(private readonly o: FrankfurterOptions) {}

  url(q: FxQuery): string {
    const u = new URL(`${(this.o.base ?? BASE).replace(/\/+$/, '')}/${q.start}..${q.end}`);
    u.searchParams.set('base', q.base.toUpperCase());
    u.searchParams.set('symbols', q.quote.toUpperCase());
    return u.toString();
  }

  async dailyRates(q: FxQuery): Promise<Result<SourceSnapshot<FxRate[]>, SourceError>> {
    const id = FrankfurterAdapter.id;
    const url = this.url(q);
    const raw = await httpGetText(url, { sourceId: id, userAgent: this.o.userAgent, ...(this.o.fetchImpl ? { fetchImpl: this.o.fetchImpl } : {}) });
    if (!raw.ok) return raw;
    const parsed = parse(RangeResponse, raw.value, id);
    if (!parsed.ok) return parsed;
    const base = q.base.toUpperCase();
    const quote = q.quote.toUpperCase();
    if (parsed.value.base !== base) return err({ code: 'schema_changed', sourceId: id, detail: `base ${parsed.value.base}, asked for ${base}` });
    const days = Object.entries(parsed.value.rates);
    const rates = days
      // A range starting on a non-working day is widened back to the previous ECB day; drop it.
      .filter(([date]) => date >= q.start && date <= q.end)
      .flatMap(([date, byCurrency]) => {
        const rate = byCurrency[quote];
        return rate === undefined ? [] : [{ date, rate }];
      })
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    if (days.length > 0 && !days.some(([, byCurrency]) => quote in byCurrency))
      return err({ code: 'schema_changed', sourceId: id, detail: `no ${quote} rates in response` });
    return ok({ sourceId: id, fetchedAt: (this.o.now?.() ?? new Date()).toISOString(), requestUrl: url, raw: raw.value, parsed: rates });
  }
}
