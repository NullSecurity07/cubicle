import { expect, test } from '@playwright/test';

// What really happened to the founder: a picture card put on the stage with no picture in it yet, then Ctrl K. Naming
// that card for the command bar's list threw, nothing caught it, and the whole stage went blank.
test('a card that is not filled in yet does not take the window down when the command bar opens', async ({ page }) => {
  const before = await (await page.request.get('/api/stage')).json();
  await page.request.put('/api/stage', { data: { ...before, cards: [...(before.cards ?? []), { id: 'empty-picture', kind: 'image', x: 40, y: 40, w: 280, h: 220 }] } });
  try {
    await page.goto('/');
    await expect(page.locator('.react-flow__node').first()).toBeVisible();
    const nodes = await page.locator('.react-flow__node').count();
    const sheet = page.getByRole('dialog', { name: 'Command bar' });
    await expect(async () => {
      if (!(await sheet.isVisible())) await page.keyboard.press('Control+k');
      await expect(sheet.getByRole('combobox')).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 25_000 });
    // The stage is still there behind it, and the empty card can be found by the name it was given.
    await expect(page.locator('.react-flow__node')).toHaveCount(nodes);
    await sheet.getByRole('combobox').fill('picture');
    await expect(sheet.getByRole('option').filter({ hasText: 'Picture' }).first()).toBeVisible();
  } finally {
    await page.request.put('/api/stage', { data: before });
  }
});
