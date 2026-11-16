import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

/** Regenerates the README screenshots in docs/assets: `pnpm --filter @reckon/e2e screenshots`. */
export default defineConfig({
  ...base,
  testDir: './screenshots',
  reporter: 'list',
  retries: 0,
  use: { ...base.use, trace: 'off' },
  projects: [
    { name: 'dark', use: { ...devices['Pixel 7'], deviceScaleFactor: 2, colorScheme: 'dark' } },
    { name: 'light', use: { ...devices['Pixel 7'], deviceScaleFactor: 2, colorScheme: 'light' } },
  ],
});
