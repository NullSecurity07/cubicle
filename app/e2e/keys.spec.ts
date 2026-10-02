import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// "?" on the stage shows every key and every command-bar word, from the same tables the keys and the bar run on.
test('the cheatsheet opens with ?, names the command bar and its words, and Escape closes it', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.react-flow__node').first()).toBeVisible();
  await page.locator('.react-flow__pane').click({ position: { x: 12, y: 12 } });
  const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(async () => {
    if (!(await sheet.isVisible())) await page.keyboard.press('?');
    await expect(sheet).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 20_000 });

  await expect(sheet.locator('[data-shortcut="command-bar"]')).toContainText('Open the command bar');
  await expect(sheet.locator('[data-shortcut="command-bar"] kbd').first()).toHaveText('Ctrl');
  await expect(sheet.getByRole('region', { name: 'Command bar words' })).toContainText('shortcuts');
  await expect(sheet).toContainText('Change a key: edit keys.json in the workspace');
  await expect(sheet.locator('.cheatsheet__foot code')).toContainText('keys.json');

  // It fits a small window: nothing runs off the side, and the body scrolls rather than the page.
  await page.setViewportSize({ width: 1280, height: 720 });
  const box = await sheet.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(1280);
  expect(box!.y + box!.height).toBeLessThanOrEqual(720);

  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();

  // Mod and / opens it too.
  await page.keyboard.press('Control+/');
  await expect(sheet).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
});

// Keys, as the founder meets them: every key the app knows, set or not, a place to paste one, and a plain word that
// it waits for a start. The value goes into the .env file this run reads (beside its throwaway workspace in fake
// mode) and never comes back to the page. Whatever this journey sets, it takes out again.
const panel = (page: Page) => page.getByRole('dialog', { name: 'Keys' });
const VALUE = 'pexels-e2e-secret-value-7788';
const envFile = () => join(process.env.STAGE_WORKSPACE!, '.env');

async function bar(page: Page, typed: string) {
  const sheet = page.getByRole('dialog', { name: 'Command bar' });
  await expect(async () => {
    if (!(await sheet.isVisible())) await page.keyboard.press('Control+k');
    await expect(sheet.getByRole('combobox')).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 25_000 });
  await sheet.getByRole('combobox').fill(typed);
  // "keys" alone offers the keyboard shortcuts first, and this panel beside them; the pick is by name.
  await sheet.getByRole('option').filter({ hasText: /^Keys/ }).first().click();
}

test.describe('the Keys panel', () => {
  const broke: string[] = [];
  test.beforeEach(async ({ page }) => {
    broke.length = 0;
    page.on('pageerror', (error) => broke.push(error.message));
    await page.goto('/');
    await expect(page.locator('.react-flow__node').first()).toBeVisible();
  });

  test.afterEach(async ({ page }) => {
    // Taken out from the page itself: a script holding the token may not write keys.
    await page.evaluate(() => fetch('/api/keys-file/PEXELS_API_KEY', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: '' }) }));
    expect(broke).toEqual([]);
  });

  test('the founder sees every key, pastes one, and is told it is set and waits for a start, without ever seeing it again', async ({ page }) => {
    await bar(page, 'keys');
    await expect(panel(page)).toBeVisible();
    // The model keys come straight from models.json, the service keys under the Health rows that ask for them.
    for (const group of ['Models', 'Email', 'Making clips', 'Real photographs', 'More music', 'Finding leads', 'Phone']) {
      await expect(panel(page).getByRole('region', { name: group })).toBeVisible();
    }
    // The free sign-ups that would put another model behind the first are named, with where to make each.
    await expect(panel(page)).toContainText('Keys that would add a fallback, each a free sign-up: NVIDIA at build.nvidia.com (nemotron-3-super-120b-a12b, kimi-k3)');
    const groq = panel(page).getByRole('listitem', { name: 'Groq' });
    await expect(groq).toContainText('GROQ_API_KEY');
    await expect(groq).toContainText('Not set. Make one at console.groq.com/keys.');

    const pexels = panel(page).getByRole('listitem', { name: 'Pexels' });
    await pexels.getByRole('button', { name: 'Set' }).click();
    const box = pexels.getByLabel('New value for Pexels');
    await expect(box).toHaveAttribute('type', 'password');
    await box.fill(VALUE);
    await box.press('Enter');
    await expect(pexels).toContainText('Set · ends in 7788');
    await expect(pexels).toContainText('start the app again to use it');
    await expect(panel(page).getByRole('status')).toContainText('Start the app again to use Pexels.');
    await expect(pexels.getByRole('button', { name: 'Change' })).toBeVisible();
    await panel(page).screenshot({ path: 'test-results/shots/keys-panel.png' });

    // It is in the file the app reads, and nowhere on the page, not even after the panel is opened again.
    expect(await readFile(envFile(), 'utf8')).toContain(`PEXELS_API_KEY=${VALUE}`);
    await page.keyboard.press('Escape');
    await bar(page, 'api keys');
    await expect(panel(page).getByRole('listitem', { name: 'Pexels' })).toContainText('ends in 7788');
    expect(await page.content()).not.toContain(VALUE);
    const read = await (await page.request.get('/api/keys-file')).text();
    expect(read).not.toContain(VALUE);
    // A script holding the launch token passes the server's gate, but may not write a key.
    expect((await page.request.put('/api/keys-file/PEXELS_API_KEY', { data: { value: 'from-a-script' } })).status()).toBe(403);

    // And out again, in two presses.
    const row = panel(page).getByRole('listitem', { name: 'Pexels' });
    await row.hover();
    await row.getByRole('button', { name: 'Remove' }).click();
    await row.getByRole('button', { name: 'Remove' }).click();
    await expect(row).toContainText('Not set. Make one at pexels.com/api.');
    expect(await readFile(envFile(), 'utf8')).not.toContain('PEXELS_API_KEY');
  });
});
