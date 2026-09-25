import { expect, test, type Page } from '@playwright/test';

// The Deck card: the founder adds it from the dock, writes a brief and presses Make; the slides land as a strip of
// thumbnails with a PDF beside them; a note merges two slides into the next version, which has one fewer; a wired
// person reads the same deck. The stage and Maya's room are left as they were found.
const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const SHOTS = 'test-results/shots';

async function send(page: Page, room: string, text: string) {
  await expect(node(page, room).locator('.status--idle')).toBeVisible();
  await node(page, room).locator('.ask textarea').fill(text);
  await node(page, room).locator('.ask textarea').press('Enter');
  await expect(node(page, room).locator('.status--idle')).toBeVisible({ timeout: 20_000 });
  return node(page, room).locator('.msg--assistant').last();
}

const broke: string[] = [];
test.beforeEach(async ({ page }) => {
  broke.length = 0;
  page.on('pageerror', (error) => broke.push(error.message));
  await page.goto('/');
  await expect(node(page, 'marketing')).toBeVisible({ timeout: 30_000 });
});

test.afterEach(async ({ page }) => {
  await page.goto('about:blank');
  const stage = await (await page.request.get('/api/stage')).json();
  await page.request.put('/api/stage', { data: { ...stage, cards: [], wires: (stage.wires as { id: string }[]).filter((wire) => wire.id === 'marketing-brand-doc') } });
  const chat = (await (await page.request.get('/api/rooms/marketing/chat')).json()) as { id: string; text: string }[];
  const from = chat.findIndex((message) => message.text.startsWith('/tool read_deck'));
  if (from >= 0) for (const message of chat.slice(from)) await page.request.delete(`/api/rooms/marketing/chat/${message.id}`);
  expect(broke).toEqual([]);
});

test('the founder makes a deck from a brief, merges two slides with a note, and a wired person reads it', async ({ page }) => {
  await page.getByRole('button', { name: 'More cards' }).click();
  await page.getByRole('menuitem', { name: 'Add deck' }).click();
  const card = page.locator('.react-flow__node-deck');
  await expect(card).toHaveCount(1);
  const id = (await card.getAttribute('data-id'))!;
  await expect(card.getByText('Say what the deck is for and press Make.')).toBeVisible();

  // Wire Maya to it, the way a drawn wire lands, once the card itself has reached the server.
  await expect.poll(async () => ((await (await page.request.get('/api/stage')).json()).cards ?? []).some((one: { id: string }) => one.id === id), { timeout: 10_000 }).toBe(true);
  const stage = await (await page.request.get('/api/stage')).json();
  await page.request.put('/api/stage', { data: { ...stage, wires: [...stage.wires, { id: `marketing-${id}`, from: 'marketing', fromHandle: 'r', to: id, toHandle: 'l' }] } });
  await page.reload();
  await expect(node(page, id)).toBeVisible();
  const deck = node(page, id);

  await deck.getByLabel('What the deck is for').fill('Seed deck, 8 slides: we help small agencies bill on time, raising $1.5M');
  await deck.getByLabel('What it is for').selectOption('pitch');
  await deck.getByLabel('Look').selectOption('editorial');
  await deck.getByRole('button', { name: 'Make' }).click();
  await expect(deck.locator('.deck__strip button').first()).toBeVisible({ timeout: 60_000 });
  const first = await deck.locator('.deck__strip button').count();
  expect(first).toBeGreaterThan(3);
  await expect(deck.locator('.card__name')).toContainText('v1');
  await expect(deck.getByRole('link', { name: 'Download PDF' })).toHaveAttribute('href', /\.pdf/);
  const pdf = await page.request.get((await deck.getByRole('link', { name: 'Download PDF' }).getAttribute('href'))!);
  expect(pdf.status()).toBe(200);
  expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-');
  await expect(deck.locator('.deck__stage iframe')).toBeVisible();
  await deck.locator('.deck__strip button').nth(1).click();
  await expect(deck.locator('.deck__strip button').nth(1)).toHaveClass(/is-shown/);
  await page.waitForTimeout(600);
  await deck.screenshot({ path: `${SHOTS}/deck-v1.png` });

  await deck.getByLabel('Notes on this deck').fill('merge slides 2 and 3');
  await deck.getByRole('button', { name: 'Edit' }).click();
  await expect(deck.locator('.card__name')).toContainText('v2', { timeout: 60_000 });
  await expect(deck.locator('.deck__strip button')).toHaveCount(first - 1);
  await expect(deck.getByLabel('Versions of this deck').getByRole('button')).toHaveCount(2);
  await expect(deck.getByLabel('Versions of this deck')).toContainText('merge slides 2 and 3');
  await page.waitForTimeout(600);
  await deck.screenshot({ path: `${SHOTS}/deck-v2.png` });

  // The first version is still there, one press away.
  await deck.getByLabel('Versions of this deck').getByRole('button', { name: /v1/ }).click();
  await expect(deck.locator('.deck__strip button')).toHaveCount(first);

  const read = await send(page, 'marketing', '/tool read_deck {}');
  await expect(read.locator('.chip--ok summary')).toHaveText('Read the deck');
  await read.locator('.chip summary').click();
  await expect(read.locator('.chip pre')).toContainText('version 2 of 2');
});
