import { expect, test } from '@playwright/test';

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
