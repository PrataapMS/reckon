import { serve } from '@hono/node-server';
import { compose } from '@reckon/runtime';
import { createApp } from './app';

/** Local API on :8787. Vite proxies /api to it, so `pnpm dev` behaves like Netlify. */
const app = createApp(compose());
serve({ fetch: app.fetch, port: 8787 }, (info) => console.log(`Reckon API on http://localhost:${info.port}/api/v1/health`));
