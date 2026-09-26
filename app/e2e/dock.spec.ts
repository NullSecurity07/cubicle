import { expect, test, type Page } from '@playwright/test';

// The dock: a column on the right edge by default, its menus open toward the cards, each button says its name when
// the pointer rests on it, and the button of the open view is lit. The founder can move it with the command bar.
const dock = (page: Page) => page.locator('.react-flow__panel.dock');

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.react-flow__node[data-id="marketing"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Model usage today' })).toBeVisible();
});

test('stands in a column on the right edge, and its menu opens to its left, whole in the window', async ({ page }) => {
  const viewport = page.viewportSize()!;
  const box = (await dock(page).boundingBox())!;
  expect(box.x + box.width).toBeGreaterThan(viewport.width - 40);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.height).toBeGreaterThan(box.width);
  await expect(dock(page)).toHaveClass(/dock--right/);

  await page.getByRole('button', { name: 'More cards' }).click();
  const menu = page.getByRole('menu', { name: 'More cards' });
  await expect(menu).toBeVisible();
  await menu.evaluate((element) => Promise.all(element.getAnimations().map((one) => one.finished)));
  const shown = (await menu.boundingBox())!;
  expect(shown.x + shown.width).toBeLessThanOrEqual(box.x);
  expect(shown.x).toBeGreaterThanOrEqual(0);
  expect(shown.y).toBeGreaterThanOrEqual(0);
  expect(shown.y + shown.height).toBeLessThanOrEqual(viewport.height);
  // Every row is in view: nothing waits below a scroll on a window this tall.
  expect(await menu.evaluate((element) => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
  await expect(menu.getByRole('menuitem', { name: 'Add survey' })).toBeInViewport();
});

test('names a button beside it after a short rest, and lights the button of the open view', async ({ page }) => {
  const messages = page.getByRole('button', { name: 'Messages', exact: true });
  const label = messages.locator('.dock__label');
  await expect(label).toHaveCSS('opacity', '0');
  await messages.hover();
  await expect(label).toContainText('Messages');
  await expect(label).toHaveCSS('opacity', '1');
  // The name sits to the left of a right-hand dock, never under the pointer.
  expect((await label.boundingBox())!.x + (await label.boundingBox())!.width).toBeLessThan((await messages.boundingBox())!.x);

  await expect(messages).not.toHaveClass(/is-open/);
  await messages.click();
  await expect(page.getByRole('dialog', { name: 'Messages' })).toBeVisible();
  await expect(messages).toHaveClass(/is-open/);
  await page.keyboard.press('Escape');
  await expect(messages).not.toHaveClass(/is-open/);
});

test('moves to the bottom when the founder says so, and stays there after a reload', async ({ page }) => {
  await page.keyboard.press('Control+k');
  const bar = page.getByRole('combobox', { name: 'Command or search' });
  await bar.fill('dock bottom');
  await expect(page.getByRole('listbox', { name: 'Suggestions' })).toContainText('Dock on the bottom');
  await bar.press('Enter');
  await expect(dock(page)).toHaveClass(/dock--bottom/);
  const check = async () => {
    const viewport = page.viewportSize()!;
    const box = (await dock(page).boundingBox())!;
    expect(box.width).toBeGreaterThan(box.height);
    expect(box.y + box.height).toBeGreaterThan(viewport.height - 40);
  };
  await check();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Model usage today' })).toBeVisible();
  await expect(dock(page)).toHaveClass(/dock--bottom/);
  await check();
});

test('sits along the bottom of a narrow window whatever was chosen', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await expect(dock(page)).toHaveClass(/dock--bottom/);
  await expect(dock(page)).not.toHaveClass(/dock--vertical/);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await expect(dock(page)).toHaveClass(/dock--right/);
});
