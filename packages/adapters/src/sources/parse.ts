import { err, ok, type Result, type SourceError } from '@reckon/core';
import type { z } from 'zod';

/** External data enters only through Zod (spec §2.6). Any mismatch is `schema_changed`, never a throw. */
export function parse<T>(schema: z.ZodType<T>, raw: string, sourceId: string): Result<T, SourceError> {
  try {
    const r = schema.safeParse(JSON.parse(raw));
    return r.success ? ok(r.data) : err({ code: 'schema_changed', sourceId, detail: r.error.message.slice(0, 500) });
  } catch (e) {
    return err({ code: 'schema_changed', sourceId, detail: `invalid JSON: ${String(e)}` });
  }
}
