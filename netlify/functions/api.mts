import { createApp } from '@reckon/api';
import { compose } from '@reckon/runtime';

/** One Hono app serves every /api/* route (spec §15). */
const app = createApp(compose());

export default (req: Request) => app.fetch(req);
export const config = { path: '/api/*' };
