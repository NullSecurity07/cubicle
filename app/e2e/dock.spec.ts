import { expect, test, type Page } from '@playwright/test';

// Two bars. The dock floats as a pill at the foot of the window with what the founder does; the rail stands at the
// middle of the right edge with what comes to them. Each button says its name when the pointer rests on it, the
// button of the open view is lit, and the founder can move or hide the dock with the command bar.
const dock = (page: Page) => page.locator('.react-flow__panel.dock');
const rail = (page: Page) => page.locator('.react-flow__panel.rail');
const settled = (page: Page, selector: string) => page.locator(selector).evaluate((element) => Promise.all(element.getAnimations({ subtree: true }).map((one) => one.finished)));

async function say(page: Page, words: string) {
  await page.keyboard.press('Control+k');
  const bar = page.getByRole('combobox', { name: 'Command or search' });
  await bar.fill(words);
  await bar.press('Enter');
  await expect(bar).toBeHidden();
}

test.beforeEach(async ({ page }) => {
  // The Getting started button joins the dock when the first-run list is read, and the pill widens by one button:
  // everything measured here is measured after that.
  const missions = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/missions');
  await page.goto('/');
  await expect(page.locator('.react-flow__node[data-id="marketing"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Model usage today' })).toBeVisible();
  await missions;
  await page.evaluate(() => new Promise((done) => { requestAnimationFrame(() => requestAnimationFrame(done)); }));
});

test('floats as a pill at the foot of the window, centred, and its menu opens upward, whole in the window', async ({ page }) => {
  const viewport = page.viewportSize()!;
  await expect(dock(page)).toHaveClass(/dock--bottom/);
  const box = (await dock(page).boundingBox())!;
  expect(Math.abs(box.x + box.width / 2 - viewport.width / 2)).toBeLessThan(4);
  expect(box.y + box.height).toBeGreaterThan(viewport.height - 40);
  expect(box.y + box.height).toBeLessThan(viewport.height - 8);
  expect(box.width).toBeGreaterThan(box.height * 4);
  // A pill: its ends are half circles.
  expect(parseFloat(await dock(page).evaluate((element) => getComputedStyle(element).borderTopLeftRadius))).toBeGreaterThanOrEqual(box.height / 2);
  // The things the founder does are here; what comes to them is not.
  for (const name of ['Command bar', 'Add person', 'Add doc', 'More cards', 'Frameworks', 'Add partner']) await expect(dock(page).getByRole('button', { name, exact: true })).toBeVisible();
  await expect(dock(page).getByRole('button', { name: 'Messages' })).toHaveCount(0);

  await page.getByRole('button', { name: 'More cards' }).click();
  const menu = page.getByRole('menu', { name: 'More cards' });
  await expect(menu).toBeVisible();
  await menu.evaluate((element) => Promise.all(element.getAnimations().map((one) => one.finished)));
  const shown = (await menu.boundingBox())!;
  expect(shown.y + shown.height).toBeLessThanOrEqual(box.y);
  expect(shown.x).toBeGreaterThanOrEqual(0);
  expect(shown.x + shown.width).toBeLessThanOrEqual(viewport.width);
  expect(shown.y).toBeGreaterThanOrEqual(0);
  expect(shown.height).toBeLessThan(560);
  expect(await menu.evaluate((element) => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
  await expect(menu.getByRole('menuitem', { name: 'Add survey' })).toBeInViewport();
});

test('the rail stands at the middle of the right edge with what comes to the founder', async ({ page }) => {
  const viewport = page.viewportSize()!;
  const box = (await rail(page).boundingBox())!;
  expect(box.x + box.width).toBeGreaterThan(viewport.width - 40);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width - 8);
  expect(Math.abs(box.y + box.height / 2 - viewport.height / 2)).toBeLessThan(4);
  expect(box.height).toBeGreaterThan(box.width * 4);
  for (const name of ['Needs you: nothing waiting', 'Messages', 'Decisions', 'Bets', 'Dashboard', 'Health', 'Keys', 'Model usage today', 'Keyboard shortcuts']) await expect(rail(page).getByRole('button', { name, exact: true })).toBeVisible();
  // Each one opens its view.
  await rail(page).getByRole('button', { name: 'Keyboard shortcuts' }).click();
  await expect(page.getByRole('dialog', { name: /Keyboard shortcuts/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await rail(page).getByRole('button', { name: 'Bets' }).click();
  await expect(page.getByRole('dialog', { name: /Bets/ })).toBeVisible();
});

test('names a button after a short rest, above the dock and beside the rail, and lights the button of the open view', async ({ page }) => {
  const person = dock(page).getByRole('button', { name: 'Add person' });
  const above = person.locator('.dock__label');
  await expect(above).toHaveCSS('opacity', '0');
  await person.hover();
  await expect(above).toHaveCSS('opacity', '1');
  const [nameBox, personBox] = [(await above.boundingBox())!, (await person.boundingBox())!];
  expect(nameBox.y + nameBox.height).toBeLessThan(personBox.y);

  const messages = rail(page).getByRole('button', { name: 'Messages', exact: true });
  const label = messages.locator('.dock__label');
  await messages.hover();
  await expect(label).toContainText('Messages');
  await expect(label).toHaveCSS('opacity', '1');
  expect((await label.boundingBox())!.x + (await label.boundingBox())!.width).toBeLessThan((await messages.boundingBox())!.x);

  await expect(messages).not.toHaveClass(/is-open/);
  await messages.click();
  await expect(page.getByRole('dialog', { name: 'Messages' })).toBeVisible();
  await expect(messages).toHaveClass(/is-open/);
  await page.keyboard.press('Escape');
  await expect(messages).not.toHaveClass(/is-open/);
});

test('moves to the right edge when the founder says so, where the rail folds into it, and stays there after a reload', async ({ page }) => {
  await page.keyboard.press('Control+k');
  const bar = page.getByRole('combobox', { name: 'Command or search' });
  await bar.fill('dock right');
  await expect(page.getByRole('listbox', { name: 'Suggestions' })).toContainText('Dock on the right');
  await bar.press('Enter');
  const check = async () => {
    await expect(dock(page)).toHaveClass(/dock--right/);
    await expect(rail(page)).toHaveCount(0);
    await expect(dock(page).getByRole('button', { name: 'Messages', exact: true })).toBeVisible();
    const box = (await dock(page).boundingBox())!;
    expect(box.height).toBeGreaterThan(box.width);
    expect(box.x + box.width).toBeGreaterThan(page.viewportSize()!.width - 40);
  };
  await check();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Model usage today' })).toBeVisible();
  await check();

  // On the left the rail stands on its own again.
  await say(page, 'move the dock to the left');
  await expect(dock(page)).toHaveClass(/dock--left/);
  await expect(rail(page)).toBeVisible();
  expect((await dock(page).boundingBox())!.x).toBeLessThan(40);
});

test('hide dock puts the dock away and keeps the rail, after a reload too; show dock brings it back', async ({ page }) => {
  await say(page, 'hide dock');
  await expect(dock(page)).toHaveCount(0);
  await expect(rail(page).getByRole('button', { name: /Needs you/ })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Model usage today' })).toBeVisible();
  await expect(dock(page)).toHaveCount(0);
  // The keys still work with the dock away.
  await say(page, 'show dock');
  await expect(dock(page)).toBeVisible();
  await expect(dock(page).getByRole('button', { name: 'Add person' })).toBeVisible();
});

test('a narrow window gets one bar along the bottom, full width with 16px gutters, the rail folded into it', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await expect(dock(page)).toHaveClass(/dock--bottom/);
  await expect(dock(page)).not.toHaveClass(/dock--vertical/);
  await expect(rail(page)).toHaveCount(0);
  await expect(dock(page).getByRole('button', { name: 'Messages', exact: true })).toBeVisible();
  const box = (await dock(page).boundingBox())!;
  expect(Math.round(box.x)).toBe(16);
  expect(Math.round(box.x + box.width)).toBe(800 - 16);
  expect(box.y + box.height).toBeLessThanOrEqual(900 - 16 + 1);

  // A phone: the buttons wrap onto a second row rather than off the edge, and the menu fits the width.
  await page.setViewportSize({ width: 390, height: 844 });
  const phone = (await dock(page).boundingBox())!;
  expect(Math.round(phone.x)).toBe(16);
  expect(Math.round(phone.x + phone.width)).toBe(390 - 16);
  const buttons = await dock(page).locator('button').evaluateAll((all) => all.map((one) => one.getBoundingClientRect()).map((rect) => [rect.left, rect.right]));
  for (const [left, right] of buttons) { expect(left).toBeGreaterThanOrEqual(16); expect(right).toBeLessThanOrEqual(390 - 16); }
  await page.getByRole('button', { name: 'More cards' }).click();
  const menu = page.getByRole('menu', { name: 'More cards' });
  await settled(page, '.dock__menu');
  const shown = (await menu.boundingBox())!;
  expect(shown.x).toBeGreaterThanOrEqual(15);
  expect(shown.x + shown.width).toBeLessThanOrEqual(390 - 15);
  expect(shown.y).toBeGreaterThanOrEqual(0);
  await page.keyboard.press('Escape');

  await page.setViewportSize({ width: 1600, height: 1000 });
  await expect(dock(page)).toHaveClass(/dock--bottom/);
  await expect(rail(page)).toBeVisible();
});
