import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// The Competitor card: the founder adds it from the dock, names a rival and gives their site, wires Maya, and watches
// the pricing page. A change is written straight into the watch file, the way the six-hourly check writes one; the
// card shows it on its timeline with Maya's two lines under it, says in amber that the last read is old, and the
// change still waits in Needs you. "Crawl now" reads the whole site into the shared files. The stage is left as found.
const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const WATCH = join(process.env.STAGE_WORKSPACE!, 'watch');
const FAKE_NOTE = 'Fake mode reads no model, so this line stands where the wired person would say what the change means.';

// Maya is wired to the card through the saved stage, once the card's own name and site have reached it, and the
// window is opened again on it. Drawing a wire by hand is stage.spec's journey; this one is about the card.
async function wire(page: Page, roomId: string, cardId: string) {
  await expect.poll(async () => ((await (await page.request.get('/api/stage')).json()).cards ?? []).find((one: { id: string }) => one.id === cardId)?.url, { timeout: 10_000 }).toBeTruthy();
  const stage = await (await page.request.get('/api/stage')).json();
  await page.request.put('/api/stage', { data: { ...stage, wires: [...stage.wires, { id: `${roomId}-${cardId}`, from: roomId, fromHandle: 'r', to: cardId, toHandle: 'l' }] } });
  await page.reload();
  await expect(page.locator(`.react-flow__edge[data-id="${roomId}-${cardId}"], .react-flow__edge[data-testid="rf__edge-${roomId}-${cardId}"]`).first()).toBeAttached({ timeout: 15_000 });
}
async function tidy(page: Page) {
  const stage = await (await page.request.get('/api/stage')).json();
  const keep = new Set(['marketing', 'build', 'brand-doc', 'company-brief']);
  await page.request.put('/api/stage', { data: {
    rooms: stage.rooms.filter((room: { id: string }) => keep.has(room.id)), docs: stage.docs.filter((doc: { id: string }) => keep.has(doc.id)), cards: [],
    wires: stage.wires.filter((one: { id: string }) => one.id === 'marketing-brand-doc'),
  } });
  for (const who of ['marketing', 'founder']) await rm(join(WATCH, `${who}.json`), { force: true });
}

const broke: string[] = [];
test.beforeEach(async ({ page }) => {
  broke.length = 0;
  page.on('pageerror', (error) => broke.push(error.message));
  await tidy(page);
  await page.goto('/');
  await expect(node(page, 'marketing')).toBeVisible({ timeout: 20_000 });
});

test.afterEach(async ({ page }) => {
  await page.goto('about:blank');
  await tidy(page);
  expect(broke).toEqual([]);
});

test('the founder watches a rival\'s pricing page, and a change lands on the timeline with the wired person\'s lines', async ({ page }) => {
  test.slow(); // A wire drawn by hand and a page read; the default thirty seconds is tight on a busy machine.
  await page.getByRole('button', { name: 'More cards' }).click();
  await page.getByRole('menuitem', { name: 'Add competitor', exact: true }).click();
  const card = page.locator('.react-flow__node-competitor');
  await expect(card).toBeVisible();
  const id = (await card.getAttribute('data-id'))!;
  await expect(card.getByText('Name a rival and give their website.')).toBeVisible();

  await card.getByLabel('Competitor name').fill('Acme');
  await card.getByLabel('Their website').fill('acme.example');
  await card.getByLabel('Their website').press('Enter');
  // The three pages every rival has, offered to watch.
  const pages = card.getByRole('region', { name: 'Watched pages' });
  for (const name of ['Home', 'Pricing', 'Changelog']) await expect(pages.getByRole('button', { name: `Watch ${name}` })).toBeVisible();
  await expect(card.locator('.rival__host')).toHaveText('acme.example');
  await card.screenshot({ path: 'test-results/shots/competitor-new.png', animations: 'disabled' });

  await wire(page, 'marketing', id);
  await pages.getByRole('button', { name: 'Watch Pricing' }).click();
  await expect(pages.locator('.rival__page.is-watched')).toHaveCount(1);
  await expect(pages.locator('.rival__page.is-watched')).toContainText('Pricing');
  await expect(pages.locator('.rival__page.is-watched .rival__seen')).toHaveText('just now');
  await expect(card.locator('.rival__read')).toHaveText('Last read just now');
  await expect(card.locator('.rival__read')).not.toHaveClass(/is-overdue/);
  // The watch belongs to the person wired to the card, and remembers which card started it.
  const [started] = JSON.parse(await readFile(join(WATCH, 'marketing.json'), 'utf8'));
  expect(started).toMatchObject({ url: 'https://acme.example/pricing', roomId: 'marketing', cardId: id });
  // The card keeps the page on its own list.
  const saved = await (await page.request.get('/api/stage')).json();
  expect(saved.cards.find((one: { id: string }) => one.id === id)).toMatchObject({ kind: 'competitor', name: 'Acme', url: 'https://acme.example/', pages: ['https://acme.example/pricing'] });

  // A change, written the way the check writes one: last read eight hours ago, so the card says it is stale.
  const now = Date.now();
  const diff = '+ Pro $39 a month\n− Pro $29 a month';
  await writeFile(join(WATCH, 'marketing.json'), JSON.stringify([{ ...started, readAt: now - 8 * 3600_000, checkedAt: now - 8 * 3600_000, changedAt: now - 60_000, diff, history: [{ at: now - 60_000, diff }] }]));
  await page.reload();
  const change = card.locator('.rival__change');
  await expect(change).toHaveCount(1, { timeout: 15_000 });
  await expect(change.locator('.rival__phrase')).toHaveText('Pro $29 → $39 a month');
  await expect(change.locator('.rival__when')).toContainText('Pricing');
  await expect(change.getByRole('list', { name: 'Changed lines' })).toContainText('+ Pro $39 a month');
  await expect(change.locator('.rival__note')).toHaveText(`Maya${FAKE_NOTE}`, { timeout: 15_000 });
  await expect(card.getByRole('region', { name: 'Changes' }).locator('h3')).toHaveText('Changes 1 this month');
  await expect(card.locator('.rival__read')).toHaveText('Last read 8 h ago');
  await expect(card.locator('.rival__read')).toHaveClass(/is-overdue/);
  await page.screenshot({ path: 'test-results/shots/competitor-change.png', clip: (await card.boundingBox())! });

  // The change still waits in Needs you, and its door leads back to the card.
  await page.getByRole('button', { name: /Needs you/ }).click();
  const row = page.locator('.needs li').filter({ hasText: 'The page Pricing — Example changed' });
  await expect(row).toContainText('saw a watched page change');
  await expect(row).toContainText('+ Pro $39 a month');
  await row.getByRole('button', { name: 'Show on the stage' }).click();
  await expect(page.locator('.needs')).toBeHidden();
  await expect(card).toBeInViewport();

  // The whole site, read into the shared files.
  await card.getByRole('button', { name: 'Crawl now' }).click();
  await expect(card.locator('.rival__crawl-file')).toContainText('3 pages', { timeout: 20_000 });
  await expect(card.locator('.rival__crawl-file')).toHaveAttribute('href', /\/api\/files\/crawls\/acme\.example-\d{4}-\d{2}-\d{2}\.md$/);

  // Stopping the watch takes the page off the card and the store; the suggestion comes back.
  await pages.locator('.rival__page.is-watched').hover();
  await pages.getByRole('button', { name: 'Stop watching Pricing' }).click();
  await expect(pages.getByRole('button', { name: 'Watch Pricing' })).toBeVisible();
  await expect.poll(async () => JSON.parse(await readFile(join(WATCH, 'marketing.json'), 'utf8')).length).toBe(0);
});
