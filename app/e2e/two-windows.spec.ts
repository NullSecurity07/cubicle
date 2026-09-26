import { expect, test, type Page } from '@playwright/test';

// The founder has the stage open twice: the desktop shell and a browser tab. Each window saves its whole stage, so a
// window that saved without hearing what the other did would put the other's change back the way it was.
const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const at = async (id: string, page: Page) => ((await (await page.request.get('/api/stage')).json()).rooms as { id: string; x: number }[]).find((room) => room.id === id)!.x;

// A card dragged by its header, the way the founder moves one.
async function drag(page: Page, id: string, dx: number) {
  const box = (await node(page, id).locator('.card__header').boundingBox())!;
  await page.mouse.move(box.x + 30, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 30 + dx / 2, box.y + box.height / 2, { steps: 4 });
  await page.mouse.move(box.x + 30 + dx, box.y + box.height / 2, { steps: 4 });
  await page.mouse.up();
}

async function open(page: Page) {
  const listening = page.waitForResponse((response) => response.url().endsWith('/api/events'));
  await page.goto('/');
  await expect(node(page, 'marketing')).toBeVisible();
  await listening;
}

const broke: string[] = [];
let held: Record<string, unknown> | null = null;
test.beforeEach(async ({ page }) => {
  broke.length = 0;
  page.on('pageerror', (error) => broke.push(error.message));
  held = await (await page.request.get('/api/stage')).json();
});
test.afterEach(async ({ page }) => {
  await page.goto('about:blank');
  await page.request.put('/api/stage', { data: held });
  expect(broke).toEqual([]);
});

test('a card moved in one window stays where it was put when the other window saves', async ({ page, context }) => {
  const other = await context.newPage();
  other.on('pageerror', (error) => broke.push(error.message));
  await open(page);
  await open(other);
  const maya = await at('marketing', page);
  const ben = await at('build', page);

  await drag(page, 'marketing', 160);
  await expect.poll(() => at('marketing', page)).toBeGreaterThan(maya + 100);
  const moved = await at('marketing', page);

  // The other window never reloaded: it heard the change, and its own save goes on top of it.
  await drag(other, 'build', 160);
  await expect.poll(() => at('build', page)).toBeGreaterThan(ben + 100);
  expect(await at('marketing', page)).toBe(moved);
  // And the other window shows the first window's move without being reloaded.
  await expect.poll(async () => (await node(other, 'marketing').boundingBox())!.x - (await node(other, 'build').boundingBox())!.x)
    .toBeCloseTo((await node(page, 'marketing').boundingBox())!.x - (await node(page, 'build').boundingBox())!.x, 0);
  await other.close();
});

test('a save that does not land says so on the canvas until one does', async ({ page }) => {
  await open(page);
  await page.route('**/api/stage', (route) => (route.request().method() === 'PUT' ? route.abort() : route.continue()));
  await drag(page, 'marketing', 120);
  await expect(page.locator('.stage__unsaved')).toContainText('Not saved');
  // Still down for the first try again, which fails the same way: a second try has to follow it all the same.
  let puts = 0;
  page.on('request', (request) => { if (request.method() === 'PUT' && request.url().endsWith('/api/stage')) puts += 1; });
  await expect.poll(() => puts, { timeout: 8_000 }).toBeGreaterThan(0);
  const before = await at('marketing', page);
  await page.unroute('**/api/stage');
  await expect(page.locator('.stage__unsaved')).toHaveCount(0, { timeout: 10_000 });
  expect(await at('marketing', page)).toBeGreaterThan(before + 60);
});
