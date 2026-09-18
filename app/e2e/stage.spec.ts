import { expect, test, type Page } from '@playwright/test';

const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const handle = (page: Page, id: string, side: string) => node(page, id).locator(`.react-flow__handle[data-handleid="${side}"]`);
const centre = (box: { x: number; y: number; width: number; height: number }) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps = 12) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.up();
}

async function ask(page: Page, room: string, text: string) {
  await node(page, room).locator('.ask textarea').fill(text);
  await node(page, room).locator('.ask textarea').press('Enter');
  const reply = node(page, room).locator('.msg--assistant').last();
  await expect(reply).toContainText(`You said: "${text}"`);
  await expect(node(page, room).locator('.status--idle')).toBeVisible();
  return reply;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(node(page, 'marketing')).toBeVisible();
});

test('shows two rooms and a doc, one wire, a dock with usage rings and nothing else', async ({ page }) => {
  await expect(page.locator('.react-flow__node')).toHaveCount(3);
  await expect(page.locator('.dock button')).toHaveCount(3);
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  await expect(node(page, 'marketing')).toContainText('Maya');
  await expect(node(page, 'brand-doc').locator('textarea.doc')).toHaveValue(/# Brand/);
  await expect(page.locator('.react-flow__minimap, .react-flow__controls, .react-flow__attribution')).toHaveCount(0);
});

test('the wallpaper stays still while the cards pan', async ({ page }) => {
  const stage = page.locator('.stage');
  const snapshot = () => stage.evaluate((el) => `${getComputedStyle(el).backgroundPosition}|${JSON.stringify(el.getBoundingClientRect())}`);
  const before = (await node(page, 'marketing').boundingBox())!;
  const wallpaperBefore = await snapshot();
  await drag(page, { x: 20, y: 20 }, { x: 220, y: 140 });
  expect((await node(page, 'marketing').boundingBox())!.x - before.x).toBeGreaterThan(150);
  expect(await snapshot()).toBe(wallpaperBefore);
});

test('a person answers in their room and reads only the docs wired to it', async ({ page }) => {
  await expect(await ask(page, 'marketing', 'three taglines')).toContainText('Maya here');
  await expect(node(page, 'marketing').locator('.msg--assistant').last()).toContainText('Docs I can read: Brand doc.');
  await expect(node(page, 'marketing').locator('.card__doing')).toHaveText('three taglines');
  await expect(await ask(page, 'build', 'what first')).toContainText('Docs I can read: none.');
});

test('typing, scrolling and dragging inside a card never move the canvas', async ({ page }) => {
  const before = (await node(page, 'marketing').boundingBox())!;
  const chat = centre((await node(page, 'marketing').locator('.chat').boundingBox())!);
  await page.mouse.move(chat.x, chat.y);
  await page.mouse.wheel(0, -400);
  await drag(page, chat, { x: chat.x + 120, y: chat.y + 60 });
  await node(page, 'marketing').locator('.ask textarea').pressSequentially('wasd ');
  const after = (await node(page, 'marketing').boundingBox())!;
  expect([after.x, after.y, after.width]).toEqual([before.x, before.y, before.width]);
});

test('layout, doc text and conversation survive a reload', async ({ page }) => {
  const bar = (await node(page, 'brand-doc').locator('.card__header').boundingBox())!;
  const header = { x: bar.x + bar.width * 0.8, y: bar.y + bar.height / 2 }; // the empty part of the header, right of the title
  await drag(page, header, { x: header.x + 90, y: header.y + 40 });
  await node(page, 'brand-doc').locator('textarea.doc').fill('We sell calm.');
  await ask(page, 'marketing', 'remember me');
  await expect.poll(async () => (await (await page.request.get('/api/stage')).json()).docs[0].x).toBeGreaterThan(560);
  await expect.poll(async () => (await (await page.request.get('/api/docs/brand-doc')).json()).text).toBe('We sell calm.');

  await page.reload();
  await expect(node(page, 'brand-doc').locator('textarea.doc')).toHaveValue('We sell calm.');
  await expect(node(page, 'marketing').locator('.msg--user').last()).toHaveText('remember me');
});

test('drawing a wire to a doc lets that person read it', async ({ page }) => {
  const from = centre((await handle(page, 'build', 'r').boundingBox())!);
  const to = centre((await handle(page, 'brand-doc', 'b').boundingBox())!);
  await drag(page, from, to, 20);
  await expect(page.locator('.react-flow__edge')).toHaveCount(2);
  await expect.poll(async () => (await (await page.request.get('/api/stage')).json()).wires.length).toBe(2);
  await expect(await ask(page, 'build', 'now what')).toContainText('Docs I can read: Brand doc.');
});

test('screenshots and frame rate', async ({ page }, info) => {
  await page.waitForTimeout(500);
  await page.screenshot({ path: '.shots/1-fit.png' });
  await page.evaluate(() => {
    const w = window as unknown as { __frames: number; __t0: number };
    w.__frames = 0; w.__t0 = performance.now();
    const tick = () => { w.__frames += 1; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  const header = centre((await node(page, 'marketing').locator('.card__header').boundingBox())!);
  await drag(page, header, { x: header.x + 300, y: header.y + 120 }, 90);
  const fps = await page.evaluate(() => {
    const w = window as unknown as { __frames: number; __t0: number };
    return (w.__frames * 1000) / (performance.now() - w.__t0);
  });
  console.log(`drag fps: ${fps.toFixed(1)}`);
  info.annotations.push({ type: 'fps', description: fps.toFixed(1) });
  expect(fps).toBeGreaterThan(30);
});

const stageNow = async (page: Page) => (await page.request.get('/api/stage')).json();

test('a person can be added, talked to, edited and removed', async ({ page }) => {
  await page.getByRole('button', { name: 'Add person' }).click();
  const card = page.locator('.react-flow__node', { has: page.locator('form.setup') });
  await expect(card.getByRole('button', { name: 'Done' })).toBeDisabled();
  await card.getByLabel('Name').fill('Rio');
  await card.getByLabel('Role').fill('Sales');
  await card.getByLabel('What they do for you').fill('Finds the first ten customers.');
  await card.getByRole('button', { name: 'Done' }).click();

  const rio = page.locator('.react-flow__node', { hasText: 'Rio' });
  await rio.locator('.ask textarea').fill('who first');
  await rio.locator('.ask textarea').press('Enter');
  await expect(rio.locator('.msg--assistant').last()).toContainText('Rio here');
  await expect.poll(async () => (await stageNow(page)).rooms.map((room: { name: string }) => room.name)).toContain('Rio');

  await page.reload();
  await expect(rio.locator('.msg--user').last()).toHaveText('who first');
  await rio.locator('.card__header').hover();
  await rio.getByRole('button', { name: 'Edit' }).click();
  await rio.getByLabel('Name').fill('Ria');
  await rio.getByRole('button', { name: 'Done' }).click();
  const ria = page.locator('.react-flow__node', { hasText: 'Ria' });
  await expect(ria.locator('.card__name')).toContainText('Ria · Sales');

  await ria.locator('.card__header').hover();
  await ria.getByRole('button', { name: 'Remove' }).first().click();
  await ria.getByRole('alertdialog').getByRole('button', { name: 'Keep' }).click();
  await expect(ria).toBeVisible();
  await ria.getByRole('button', { name: 'Remove' }).first().click();
  await ria.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click();
  await expect(ria).toHaveCount(0);
  await expect.poll(async () => (await stageNow(page)).rooms.length).toBe(2);
  await page.reload();
  await expect(page.locator('.react-flow__node', { hasText: 'Ria' })).toHaveCount(0);
});

test('a doc can be added, named, written and removed', async ({ page }) => {
  const docsBefore = (await stageNow(page)).docs.length;
  await page.getByRole('button', { name: 'Add doc' }).click();
  const title = page.locator('input.card__title-input[value="Untitled doc"]');
  await title.fill('Pricing');
  const card = page.locator('.react-flow__node', { has: page.locator('input.card__title-input[value="Pricing"]') });
  await card.locator('textarea.doc').fill('Nine dollars a month.');
  await expect.poll(async () => (await stageNow(page)).docs.map((doc: { title: string }) => doc.title)).toContain('Pricing');

  await page.reload();
  await expect(card.locator('textarea.doc')).toHaveValue('Nine dollars a month.');
  await card.locator('.card__header').hover();
  await card.getByRole('button', { name: 'Remove' }).first().click();
  await card.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click();
  await expect.poll(async () => (await stageNow(page)).docs.length).toBe(docsBefore);
});

const send = async (page: Page, room: string, text: string) => {
  await node(page, room).locator('.ask textarea').fill(text);
  await node(page, room).locator('.ask textarea').press('Enter');
};

test('a person rewrites a wired doc: the chip shows it, the doc card updates, the old text is kept', async ({ page }) => {
  await send(page, 'marketing', '/tool write_doc {"doc":"Brand doc","text":"# Brand\\n\\nCalm tools for founders."}');
  const reply = node(page, 'marketing').locator('.msg--assistant').last();
  await expect(reply.locator('.chip--ok summary')).toHaveText('Rewrote Brand doc');
  await expect(reply).toContainText(/Tool said: Wrote \d+ characters\./);
  await expect(node(page, 'brand-doc').locator('textarea.doc')).toHaveValue('# Brand\n\nCalm tools for founders.');
  await expect(reply.locator('.msg__foot')).toContainText('fake · fake-1 ·');
  await expect(reply.locator('.msg__foot')).toContainText('tokens');

  await page.reload();
  await expect(node(page, 'marketing').locator('.chip--ok summary')).toHaveText('Rewrote Brand doc');
  await expect(node(page, 'brand-doc').locator('textarea.doc')).toHaveValue('# Brand\n\nCalm tools for founders.');
});

test('a failed tool call shows as such and the person says what went wrong', async ({ page }) => {
  await send(page, 'build', '/tool write_doc {"doc":"Secret plan","text":"mine now"}');
  await expect(node(page, 'build').locator('.chip--fail summary')).toContainText('Could not: rewriting Secret plan');
  await expect(node(page, 'build').locator('.msg--assistant').last()).toContainText('no connected document is called "Secret plan"');
});

test('a person creates a doc: the card appears beside them, wired, and survives a reload', async ({ page }) => {
  await expect(page.locator('.react-flow__edge').first()).toBeAttached();
  const wires = await page.locator('.react-flow__edge').count();
  const docs = await page.locator('.react-flow__node-doc').count();
  await send(page, 'build', '/tool create_doc {"title":"Build plan","text":"1. Ship the stage"}');
  await expect(node(page, 'build').locator('.chip--ok summary')).toHaveText('Created Build plan');
  const card = page.locator('.react-flow__node-doc', { has: page.locator('input[value="Build plan"]') });
  await expect(card.locator('textarea.doc')).toHaveValue('1. Ship the stage');
  await expect(page.locator('.react-flow__edge')).toHaveCount(wires + 1);
  await expect.poll(async () => (await (await page.request.get('/api/stage')).json()).docs.length).toBe(docs + 1);
  await expect(await ask(page, 'build', 'what can you read')).toContainText('Build plan');

  await page.reload();
  await expect(page.locator('.react-flow__node-doc')).toHaveCount(docs + 1);
});

test('replies render markdown', async ({ page }) => {
  await send(page, 'marketing', '/markdown please');
  const reply = node(page, 'marketing').locator('.msg--assistant').last();
  await expect(reply.locator('strong')).toHaveText('Bold plan');
  await expect(reply.locator('li')).toHaveCount(2);
});

test('a reply can be stopped, and what was said is kept', async ({ page }) => {
  await send(page, 'marketing', '/slow tell me everything about the launch');
  const room = node(page, 'marketing');
  await expect(room.locator('.msg--assistant').last()).toContainText('Maya here');
  await room.getByRole('button', { name: 'Stop' }).click();
  await expect(room.locator('.status--idle')).toBeVisible();
  await expect(room.getByRole('button', { name: 'Send' })).toBeVisible();
  await expect(room.locator('.msg__foot').last()).toContainText('stopped');
  const kept = await room.locator('.msg--assistant').last().innerText();
  expect(kept).not.toContain('Docs I can read');

  await page.reload();
  await expect(node(page, 'marketing').locator('.msg__foot').last()).toContainText('stopped');
  await expect(await ask(page, 'marketing', 'still there?')).toContainText('Maya here');
});

test('the dock shows today\'s model usage and a person can be pinned to a model', async ({ page }) => {
  await ask(page, 'marketing', 'hello');
  await page.getByRole('button', { name: 'Model usage today' }).click();
  const detail = page.getByRole('dialog', { name: 'Model usage today' });
  await expect(detail).toContainText('fake');
  await expect(detail).toContainText(/\d+% left/);
  await expect(detail).toContainText(/\d+ replies · [\d,]+ tokens/);

  await node(page, 'marketing').hover();
  await node(page, 'marketing').getByRole('button', { name: 'Edit' }).click();
  await node(page, 'marketing').locator('select').selectOption('fake');
  await node(page, 'marketing').getByRole('button', { name: 'Done' }).click();
  await expect.poll(async () => (await (await page.request.get('/api/stage')).json()).rooms[0].model).toBe('fake');
  await expect(await ask(page, 'marketing', 'again')).toContainText('Maya here');
});
