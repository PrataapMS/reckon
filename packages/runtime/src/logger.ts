import type { Logger } from '@reckon/core';

/** Structured JSON logs (spec §17); Netlify's function log viewer shows one line per event. */
export function jsonLogger(base: Record<string, unknown> = {}): Logger {
  const write = (level: string, msg: string, fields?: Record<string, unknown>) =>
    console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...base, ...fields }));
  return {
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
  };
}
