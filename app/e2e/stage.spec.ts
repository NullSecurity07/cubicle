import { expect, test, type Page } from '@playwright/test';

const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const handle = (page: Page, id: string, side: string) => node(page, id).locator(`.react-flow__handle[data-handleid="${side}"]`);

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps = 12) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.up();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.react-flow__node')).toHaveCount(4);
});

test('shows three rooms with a person each, one card and two wires', async ({ page }) => {
  await expect(page.locator('.react-flow__edge')).toHaveCount(2);
  await expect(page.locator('.card__body--room svg.person')).toHaveCount(3);
  await expect(page.locator('.card img')).toHaveCount(0);
  await expect(page.locator('button, .react-flow__minimap, .react-flow__controls, .react-flow__attribution')).toHaveCount(0);
});

test('the wallpaper stays still while the rooms pan', async ({ page }) => {
  const stage = page.locator('.stage');
  const snapshot = () => stage.evaluate((el) => `${getComputedStyle(el).backgroundPosition}|${JSON.stringify(el.getBoundingClientRect())}`);
  const before = (await node(page, 'founder').boundingBox())!;
  const wallpaperBefore = await snapshot();
  await drag(page, { x: 20, y: 20 }, { x: 220, y: 140 });
  const after = (await node(page, 'founder').boundingBox())!;
  expect(after.x - before.x).toBeGreaterThan(150);
  expect(await snapshot()).toBe(wallpaperBefore);
});

test('a room drags and a wire can be drawn between two handles', async ({ page }) => {
  const box = (await node(page, 'build').boundingBox())!;
  await drag(page, { x: box.x + 40, y: box.y + 12 }, { x: box.x + 40, y: box.y + 92 });
  const moved = (await node(page, 'build').boundingBox())!;
  expect(moved.y - box.y).toBeGreaterThan(40);

  const from = (await handle(page, 'build', 'l').boundingBox())!;
  const to = (await handle(page, 'founder', 'b').boundingBox())!;
  await drag(page, { x: from.x + from.width / 2, y: from.y + from.height / 2 }, { x: to.x + to.width / 2, y: to.y + to.height / 2 }, 20);
  await expect(page.locator('.react-flow__edge')).toHaveCount(3);
});

test('screenshots at three zoom levels', async ({ page }, info) => {
  const shot = (name: string) => page.screenshot({ path: `.shots/${info.project.name}-${name}.png` });
  await page.waitForTimeout(400);
  await shot('1-fit');
  await page.mouse.move(800, 500);
  await page.mouse.wheel(0, -500);
  await page.waitForTimeout(400);
  await shot('2-near');
  await page.mouse.wheel(0, 1400);
  await page.waitForTimeout(400);
  await shot('3-far');
});

test('dragging a frosted card keeps a usable frame rate', async ({ page }, info) => {
  const box = (await node(page, 'founder').boundingBox())!;
  await page.evaluate(() => {
    const w = window as unknown as { __frames: number; __t0: number };
    w.__frames = 0;
    w.__t0 = performance.now();
    const tick = () => { w.__frames += 1; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  await drag(page, { x: box.x + 40, y: box.y + 12 }, { x: box.x + 440, y: box.y + 212 }, 90);
  const fps = await page.evaluate(() => {
    const w = window as unknown as { __frames: number; __t0: number };
    return (w.__frames * 1000) / (performance.now() - w.__t0);
  });
  info.annotations.push({ type: 'fps', description: fps.toFixed(1) });
  console.log(`${info.project.name} drag fps: ${fps.toFixed(1)}`);
  expect(fps).toBeGreaterThan(30);
});
