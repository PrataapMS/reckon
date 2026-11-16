import { expect, type Page, test } from '@playwright/test';
import { API_URL } from '../playwright.config';

/**
 * Drives the fake-clock E2E stack through a week of the daily loop, then captures each screen
 * for the README, then renders the banner from hero.html.
 * Output: docs/assets/screens/<theme>-<screen>.png and docs/assets/hero-<theme>.png
 */
const PASSPHRASE = 'e2e correct horse battery';
const OUT = '../docs/assets/screens';

async function at(page: Page, iso: string, ...jobs: string[]) {
  await page.request.post(`${API_URL}/__e2e/clock`, { data: { iso } });
  for (const job of jobs) expect((await page.request.post(`${API_URL}/__e2e/run/${job}`)).ok()).toBe(true);
}

async function shot(page: Page, theme: string, name: string) {
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.screenshot({ path: `${OUT}/${theme}-${name}.png` });
}

const day = (d: number, hm: string) => `2026-10-${String(d).padStart(2, '0')}T${hm}:00+05:30`;

test('README screenshots', async ({ page }, info) => {
  test.setTimeout(180_000);
  const theme = info.project.name;
  await page.request.post(`${API_URL}/__e2e/reset`);
  await at(page, day(6, '04:00'));
  await page.clock.setFixedTime(new Date(day(6, '07:00')));

  await page.goto('/');
  await page.getByLabel('Passphrase').fill(PASSPHRASE);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByLabel('Or search for a city').fill('Beng');
  await expect(page.getByRole('button', { name: /Bengaluru/ })).toBeVisible();
  await shot(page, theme, 'onboarding');
  await page.getByRole('button', { name: /Bengaluru/ }).click();
  await page
    .getByRole('button', { name: 'Skip' })
    .or(page.getByRole('button', { name: 'Done' }))
    .first()
    .click();
  await page.getByRole('button', { name: 'Show my brief' }).click();

  // A week of the loop so the scoreboard has history.
  for (let d = 7; d <= 13; d++) {
    await at(page, day(d, '04:45'), 'generate');
    await at(page, day(d, '07:05'), 'tick');
    await at(page, day(d, '21:00'), 'reveal', 'news');
  }
  await at(page, day(14, '04:45'), 'generate');
  await at(page, day(14, '06:35'), 'tick', 'news');

  await page.clock.setFixedTime(new Date(day(14, '07:00')));
  await page.goto('/');
  await expect(page.getByRole('region', { name: "Today's claims" })).toBeVisible();
  await shot(page, theme, 'today');

  const pulse = page.getByRole('region', { name: 'World pulse' });
  await pulse.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.evaluate(() => window.scrollBy(0, -40));
  await shot(page, theme, 'world');

  await at(page, day(14, '21:00'), 'reveal');
  await page.clock.setFixedTime(new Date(day(14, '21:05')));
  await page.goto('/reveal');
  await expect(page.getByText(/Reckon called it|Reckon missed/).first()).toBeVisible();
  await shot(page, theme, 'reveal');

  await page.getByRole('link', { name: 'Every forecaster and the raw data' }).first().click();
  await expect(page.getByRole('heading', { name: 'How this is judged' })).toBeVisible();
  await shot(page, theme, 'detail');

  await page.goto('/score');
  const diagram = page.getByRole('group', { name: /Reliability diagram/ });
  await expect(diagram).toBeVisible();
  await diagram.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await shot(page, theme, 'scoreboard');

  const hero = await page
    .context()
    .browser()
    ?.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 2 });
  if (!hero) throw new Error('no browser');
  await hero.goto(`${new URL('hero.html', import.meta.url).href}?theme=${theme}`);
  await hero.waitForLoadState('networkidle');
  await hero.evaluate(() => document.fonts.ready.then(() => undefined));
  await hero.screenshot({ path: `${OUT}/../hero-${theme}.png` });
  await hero.close();
});
