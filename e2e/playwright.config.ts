import { defineConfig, devices } from '@playwright/test';

/** Phase 1 acceptance (06-roadmap): onboarding → brief → reveal on a fake clock, with axe-core checks. */
const API = 8790;
const WEB = 5174;

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1, // one fake world, one clock
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${WEB}`,
    trace: 'retain-on-failure',
    timezoneId: 'Asia/Kolkata',
    reducedMotion: 'reduce',
  },
  // Both themes: every colour pairing must meet WCAG 2.2 AA in light and dark (spec 04-design).
  projects: [
    { name: 'mobile-dark', use: { ...devices['Pixel 7'], colorScheme: 'dark' } },
    { name: 'mobile-light', use: { ...devices['Pixel 7'], colorScheme: 'light' } },
  ],
  webServer: [
    { command: 'pnpm exec tsx server.ts', port: API, reuseExistingServer: false, env: { E2E_API_PORT: String(API) } },
    {
      command: `pnpm --filter @reckon/web exec vite --port ${WEB} --strictPort`,
      port: WEB,
      reuseExistingServer: false,
      env: { RECKON_API_URL: `http://localhost:${API}` },
    },
  ],
});

export const API_URL = `http://localhost:${API}`;
