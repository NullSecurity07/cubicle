import { expect, test, type Page } from '@playwright/test';

// The Site card: the founder adds it from the dock, writes a brief and presses Make; the page lands at a laptop's
// width and a phone's side by side, each with its one headline, and the critic's rules all hold; the folder downloads
// as a zip; a note ("shorter hero") remakes the hero alone as version 2; the page opens in a browser card; a wired
// person reads the same site. The stage and Maya's room are left as they were found.
const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const SHOTS = 'test-results/shots';

async function send(page: Page, room: string, text: string) {
  await expect(node(page, room).locator('.status--idle')).toBeVisible();
  await node(page, room).locator('.ask textarea').fill(text);
  await node(page, room).locator('.ask textarea').press('Enter');
  await expect(node(page, room).locator('.status--idle')).toBeVisible({ timeout: 20_000 });
  return node(page, room).locator('.msg--assistant').last();
}

// Run first on a cold server, the first page load compiles the whole app, which can take most of the default budget.
test.describe.configure({ timeout: 120_000 });

const broke: string[] = [];
test.beforeEach(async ({ page }) => {
  broke.length = 0;
  page.on('pageerror', (error) => broke.push(error.message));
  await page.goto('/');
  await expect(node(page, 'marketing')).toBeVisible({ timeout: 90_000 });
});

test.afterEach(async ({ page }) => {
  await page.goto('about:blank');
  const stage = await (await page.request.get('/api/stage')).json();
  await page.request.put('/api/stage', { data: { ...stage, cards: [], wires: (stage.wires as { id: string }[]).filter((wire) => wire.id === 'marketing-brand-doc') } });
  const chat = (await (await page.request.get('/api/rooms/marketing/chat')).json()) as { id: string; text: string }[];
  const from = chat.findIndex((message) => message.text.startsWith('/tool read_site'));
  if (from >= 0) for (const message of chat.slice(from)) await page.request.delete(`/api/rooms/marketing/chat/${message.id}`);
  expect(broke).toEqual([]);
});

test('the founder makes a one-page site, sees it on a laptop and a phone, shortens the hero with a note, and opens it', async ({ page }) => {
  await page.getByRole('button', { name: 'More cards' }).click();
  await page.getByRole('menuitem', { name: 'Add site studio' }).click();
  const card = page.locator('.react-flow__node-site');
  await expect(card).toHaveCount(1);
  const id = (await card.getAttribute('data-id'))!;
  await expect(card.getByText('Say what the site is for and who it is for')).toBeVisible();

  // Wire Maya to it, the way a drawn wire lands, once the card itself has reached the server.
  await expect.poll(async () => ((await (await page.request.get('/api/stage')).json()).cards ?? []).some((one: { id: string }) => one.id === id), { timeout: 10_000 }).toBe(true);
  const stage = await (await page.request.get('/api/stage')).json();
  await page.request.put('/api/stage', { data: { ...stage, wires: [...stage.wires, { id: `marketing-${id}`, from: 'marketing', fromHandle: 'r', to: id, toHandle: 'l' }] } });
  await page.reload();
  const site = node(page, id);
  await expect(site).toBeVisible();

  await site.getByLabel('What the site is for').fill('Ledgerly helps small agencies send invoices on time. Button to hello@ledgerly.app');
  await site.getByLabel('Look').selectOption('editorial');
  await site.getByRole('button', { name: 'Make' }).click();
  await expect(site.locator('.site__pair iframe')).toHaveCount(2, { timeout: 60_000 });
  await expect(site.locator('.card__name')).toContainText('v1');

  // Both previews are the real page, each with its one headline; on the phone the button sits above the fold.
  const desktop = site.locator('.site__pair iframe').nth(0).contentFrame();
  const phone = site.locator('.site__pair iframe').nth(1).contentFrame();
  await expect(desktop.locator('h1')).toHaveCount(1);
  await expect(phone.locator('h1')).toHaveCount(1);
  await expect(desktop.locator('h1')).toHaveText('Ledgerly helps small agencies send invoices');
  expect(await phone.locator('html').evaluate(() => window.innerWidth)).toBe(390);
  const bottom = await phone.locator('.hero .button').evaluate((button) => button.getBoundingClientRect().bottom);
  expect(bottom).toBeLessThan(700);
  await expect(phone.locator('.hero .button')).toHaveAttribute('href', 'mailto:hello@ledgerly.app');
  await expect(site.locator('.site__checks li.is-ok')).toHaveCount(5);
  await expect(site.getByText(/cut "Trusted by 1,200 agencies/)).toBeVisible();

  const zipped = await page.request.get((await site.getByRole('link', { name: 'Download folder' }).getAttribute('href'))!);
  expect(zipped.status()).toBe(200);
  expect((await zipped.body()).subarray(0, 2).toString()).toBe('PK');
  await page.waitForTimeout(600);
  await site.screenshot({ path: `${SHOTS}/site-v1.png` });

  await site.getByLabel('Notes on this site').fill('shorter hero');
  await site.getByRole('button', { name: 'Edit' }).click();
  await expect(site.locator('.card__name')).toContainText('v2', { timeout: 60_000 });
  await expect(site.getByLabel('Versions of this site').getByRole('button')).toHaveCount(2);
  await expect(site.getByLabel('Versions of this site')).toContainText('shorter hero');
  await expect(site.getByText(/rewrote the hero; kept 4 of 5 sections as they were/)).toBeVisible();
  const shorter = site.locator('.site__pair iframe').nth(0).contentFrame().locator('h1');
  await expect(shorter).toHaveCount(1);
  expect((await shorter.textContent())!.split(' ').length).toBeLessThan(6);
  await page.waitForTimeout(600);
  await site.screenshot({ path: `${SHOTS}/site-v2.png` });

  // The first version is still there, one press away.
  await site.getByLabel('Versions of this site').getByRole('button', { name: /v1/ }).click();
  await expect(site.locator('.site__pair iframe').nth(0).contentFrame().locator('h1')).toHaveText('Ledgerly helps small agencies send invoices');

  // "Open in browser card" puts a browser card down beside it, wired, and opens the page there.
  await site.getByRole('button', { name: 'Open in browser card' }).click();
  await expect(page.locator('.react-flow__node-browser')).toHaveCount(1);
  await expect(site.getByRole('button', { name: 'Open in browser card' })).toBeEnabled();
  await expect(site.locator('.studio__problem')).toHaveCount(0);
  await expect.poll(async () => ((await (await page.request.get('/api/stage')).json()).wires as { from: string }[]).some((wire) => wire.from === id), { timeout: 10_000 }).toBe(true);

  const read = await send(page, 'marketing', '/tool read_site {}');
  await expect(read.locator('.chip--ok summary')).toHaveText('Read the site');
  await read.locator('.chip summary').dispatchEvent('click');
  await expect(read.locator('.chip pre')).toContainText('version 2 of 2');
});
