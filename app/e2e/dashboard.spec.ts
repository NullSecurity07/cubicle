import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

// The dashboard: Ctrl D opens it, its four sections are there, and a row in Today's five is a door. A watched page that
// changed is written straight into the workspace, the way the half-minute check writes one, and it names Maya's room;
// pressing it closes the dashboard and brings Maya forward. The file is taken away afterwards.
const WATCH = join(process.env.STAGE_WORKSPACE!, 'watch', 'marketing.json');

const broke: string[] = [];
test.beforeEach(async ({ page }) => {
  broke.length = 0;
  page.on('pageerror', (error) => broke.push(error.message));
  const now = Date.now();
  await mkdir(join(process.env.STAGE_WORKSPACE!, 'watch'), { recursive: true });
  await writeFile(WATCH, JSON.stringify([{
    id: 'dash-e2e', url: 'https://rival.example/pricing', what: 'their prices', roomId: 'marketing', title: 'Rival pricing', hash: 'x', text: '',
    addedAt: now - 86_400_000, checkedAt: now, changedAt: now - 60_000, diff: '+ Pro is now $29 a month',
  }]));
});

test.afterEach(async ({ page }) => {
  await page.goto('about:blank');
  await rm(WATCH, { force: true });
  expect(broke).toEqual([]);
});

test('the dashboard opens on the founder\'s day, and a needs-you row lands in the right room', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.react-flow__node[data-id="marketing"]')).toBeVisible();

  const dash = page.getByRole('dialog', { name: 'Dashboard' });
  // Pressed again if a cold dev server reloads the page under the first press (Vite optimising a dependency).
  await expect(async () => {
    if (!await dash.isVisible()) await page.keyboard.press('Control+d');
    await expect(dash).toBeVisible({ timeout: 1_500 });
  }).toPass({ timeout: 15_000 });
  // It slides in from the left edge, takes the keyboard with it, and leaves the canvas beside it undimmed.
  await dash.evaluate((element) => Promise.all(element.getAnimations().map((one) => one.finished)));
  const box = (await dash.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x).toBeLessThanOrEqual(20);
  expect(box.x + box.width).toBeLessThan(page.viewportSize()!.width - 200);
  expect(await dash.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await expect(page.locator('.overlay__shade')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(page.locator('.overlay__shade')).toHaveCSS('backdrop-filter', 'none');
  for (const name of ['Today', 'Tokens and health', 'Teams', 'Made this week']) await expect(dash.getByRole('heading', { name, exact: true })).toBeVisible();
  for (const name of ['Today', 'Tokens and health', 'Teams', 'Made this week']) await expect(dash.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name })).toBeVisible();
  await expect(dash.locator('.dash__chart svg')).toBeVisible();
  // The built-in teams are there whether placed or not.
  await expect(dash.locator('.dash__team', { hasText: 'Startup evaluation' })).toBeVisible();

  // The rail jumps: the section it names comes to the top of the view.
  await dash.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Teams' }).click();
  await expect(dash.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Teams' })).toHaveAttribute('aria-current', 'true');
  await dash.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Today' }).click();

  // The changed page is shown once, in Today's five; Needs you below says it is already up there rather than repeat it.
  const row = dash.getByRole('list', { name: "Today's five" }).locator('.today__row', { hasText: 'Rival pricing' });
  await expect(row).toBeVisible({ timeout: 10_000 });
  const needs = dash.locator('.dash__group', { has: page.getByRole('heading', { name: 'Needs you', exact: true }) });
  await expect(needs).toContainText("Already in Today's five.");
  await expect(needs.getByRole('button', { name: /Rival pricing/ })).toHaveCount(0);
  await row.click();
  await expect(dash).toBeHidden();
  const sheet = page.getByRole('dialog', { name: 'Focused card' });
  await expect(sheet.locator('.card--focused')).toBeVisible();
  await expect(sheet.getByPlaceholder('Ask Maya…')).toBeVisible();

  // The command bar knows it by the words a founder reaches for.
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox', { name: 'Command or search' }).fill('today');
  await page.getByRole('option', { name: /Dashboard/ }).click();
  await expect(dash).toBeVisible();
  await page.keyboard.press('Control+d');
  await expect(dash).toBeHidden();
  // Escape closes it too, and a view in the middle of the window still sits over its shade.
  await page.keyboard.press('Control+d');
  await expect(dash).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dash).toBeHidden();
  await page.keyboard.press('n');
  await expect(page.getByRole('dialog', { name: 'Needs you' })).toBeVisible();
  await expect(page.locator('.overlay__shade')).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
});

test('a founder who asks for less motion gets the dashboard at once, without the slide', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.locator('.react-flow__node[data-id="marketing"]')).toBeVisible();
  const dash = page.getByRole('dialog', { name: 'Dashboard' });
  await expect(async () => {
    if (!await dash.isVisible()) await page.keyboard.press('Control+d');
    await expect(dash).toBeVisible({ timeout: 1_500 });
  }).toPass({ timeout: 15_000 });
  await expect(dash).toHaveCSS('animation-name', 'none');
});
