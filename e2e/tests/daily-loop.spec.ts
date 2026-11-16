import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { API_URL } from '../playwright.config';

/**
 * Phase 1 acceptance (06-roadmap): onboarding → brief → reveal passes on a fake clock; Phase 2
 * adds the World pulse, linked headlines, the scoreboard and topics.
 * The server's clock is moved with /__e2e/clock and the scheduled jobs are run explicitly.
 */
const PASSPHRASE = 'e2e correct horse battery';

async function at(page: Page, iso: string, ...jobs: string[]) {
  await page.request.post(`${API_URL}/__e2e/clock`, { data: { iso } });
  for (const job of jobs) expect((await page.request.post(`${API_URL}/__e2e/run/${job}`)).ok()).toBe(true);
}

const nav = (page: Page, name: string) => page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name }).click();

async function noSeriousA11yIssues(page: Page) {
  // Let late fetches and web fonts settle first: mid-render, axe can misread text colour as black.
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    serious.map(
      (v) =>
        `${v.id}: ${v.nodes
          .slice(0, 2)
          .map((n) => `${n.target.join(' ')} — ${n.failureSummary}`)
          .join(' | ')}`,
    ),
  ).toEqual([]);
}

test('onboarding → brief → reveal', async ({ page }) => {
  // A fresh world at 04:00 on Tue 6 Oct in Bengaluru.
  await page.request.post(`${API_URL}/__e2e/reset`);
  await at(page, '2026-10-06T04:00:00+05:30');

  await test.step('sign in', async () => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
    await noSeriousA11yIssues(page);
    await page.getByLabel('Passphrase').fill(PASSPHRASE);
    await page.getByRole('button', { name: 'Sign in' }).click();
  });

  await test.step('onboard in three steps', async () => {
    await expect(page.getByRole('heading', { name: 'Where are you?' })).toBeVisible();
    await noSeriousA11yIssues(page);
    await page.getByLabel('Or search for a city').fill('Beng');
    await page.getByRole('button', { name: /Bengaluru/ }).click();
    await expect(page.getByRole('heading', { name: 'Get the brief on Telegram' })).toBeVisible();
    await page.getByRole('button', { name: 'Link Telegram' }).click();
    await expect(page.getByRole('link', { name: 'Open Telegram and tap Start' })).toHaveAttribute('href', /^https:\/\/t\.me\/reckon_e2e_bot\?start=/);
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByRole('heading', { name: 'When suits you?' })).toBeVisible();
    await page.getByRole('button', { name: 'Show my brief' }).click();
  });

  await test.step('first day: tomorrow is locked, today is a labelled preview', async () => {
    await expect(page.getByText('No claims are locked for today yet')).toBeVisible();
    await expect(page.getByText('live preview, not scored').first()).toBeVisible();
    const tomorrow = page.getByRole('heading', { name: 'Tomorrow', exact: true });
    await expect(tomorrow).toBeVisible();
    await expect(page.getByText(/learning, 0 of 30 days scored/).first()).toBeVisible();
    await noSeriousA11yIssues(page);
  });

  await test.step('next morning: the brief has at least four locked items', async () => {
    await at(page, '2026-10-07T04:45:00+05:30', 'generate');
    await at(page, '2026-10-07T06:35:00+05:30', 'tick');
    await page.reload();
    const today = page.getByRole('region', { name: "Today's claims" });
    await expect(today).toBeVisible();
    await expect(today.getByRole('heading', { name: /Take an umbrella|No umbrella needed/ })).toBeVisible();
    expect(await today.locator('article').count()).toBeGreaterThanOrEqual(4);
    await noSeriousA11yIssues(page);
  });

  await test.step('the reveal stays sealed until 21:00 the next day', async () => {
    await at(page, '2026-10-08T04:45:00+05:30', 'generate');
    await at(page, '2026-10-08T07:05:00+05:30', 'tick'); // resolves 7 Oct
    await page.getByRole('link', { name: 'Reveal' }).click();
    await expect(page.getByRole('heading', { name: /Sealed for/ })).toBeVisible();
  });

  await test.step('at the reveal, every card opens with an outcome', async () => {
    await at(page, '2026-10-08T21:00:00+05:30', 'reveal');
    await page.reload();
    await expect(page.getByRole('heading', { name: 'The Reveal' })).toBeVisible();
    await expect(page.getByText('Wednesday 7 October')).toBeVisible();
    const outcomes = page.getByText(/Reckon called it|Reckon missed/);
    await expect(outcomes.first()).toBeVisible();
    expect(await outcomes.count()).toBeGreaterThanOrEqual(4);
    await expect(page.getByText(/Average Brier \d\.\d{3}/)).toBeVisible();
    await noSeriousA11yIssues(page);
  });

  await test.step('every resolved question shows how it was judged and its raw evidence', async () => {
    await page.getByRole('link', { name: 'Every forecaster and the raw data' }).first().click();
    await expect(page.getByRole('heading', { name: 'How this is judged' })).toBeVisible();
    await expect(page.getByText(/Observed .+ so the answer is (YES|NO)/)).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible();
    const download = page.getByRole('link', { name: 'Download the raw response' }).last();
    const href = await download.getAttribute('href');
    const raw = await page.request.get(href ?? '');
    expect(raw.ok()).toBe(true);
    expect(raw.headers()['content-disposition']).toContain('attachment');
    await noSeriousA11yIssues(page);
  });

  await test.step('World pulse: world claims, with the headlines behind them', async () => {
    await at(page, '2026-10-08T21:10:00+05:30', 'news');
    await nav(page, 'Today');
    const pulse = page.getByRole('region', { name: 'World pulse' });
    await expect(pulse).toBeVisible();
    await noSeriousA11yIssues(page);
    await pulse.locator('article', { hasText: 'Kp reaches' }).getByRole('link', { name: 'How this is judged' }).first().click();
    await expect(page.getByText(/NOAA Space Weather Prediction Center/)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'In the news' })).toBeVisible();
    await expect(page.getByRole('link', { name: /Geomagnetic storm could bring auroras/ }).first()).toBeVisible();
    await noSeriousA11yIssues(page);
  });

  await test.step('the scoreboard shows Brier per question type and a reliability diagram', async () => {
    await nav(page, 'Scoreboard');
    await expect(page.getByRole('group', { name: /Reliability diagram\. \d+ resolved forecasts/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: /wx\.rain_any/ })).toBeVisible();
    await page.getByText('Show as a table').click();
    await noSeriousA11yIssues(page);
  });

  await test.step('settings: follow a suggested topic in one tap', async () => {
    await nav(page, 'Settings');
    const followed = page.getByRole('list', { name: 'Topics you follow' });
    await expect(followed.getByText('India economy')).toBeVisible();
    await page.getByRole('button', { name: '+ Cricket' }).click();
    await expect(followed.getByText('Cricket')).toBeVisible();
    await noSeriousA11yIssues(page);
  });

  await test.step('nothing goes to Telegram until the chat is linked', async () => {
    // The link was created but never opened in Telegram, so the reveal job had nobody to message.
    const sent = (await (await page.request.get(`${API_URL}/__e2e/telegram`)).json()) as { text: string }[];
    expect(sent).toEqual([]);
  });
});
