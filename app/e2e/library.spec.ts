import { expect, test, type Page } from '@playwright/test';

// The library journey: the founder pastes what they learned, stands the note beside a person, and that person answers
// with the part of it that fits the question. The stage and Maya's conversation are shared with every other journey,
// so this one leaves both exactly as it found them.
const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const panel = (page: Page) => page.getByRole('dialog', { name: 'Notes' });
const TITLE = 'Startup evaluation notes';
// Five steps, each long enough to be a passage of its own, so the person is handed the two or three that answer the
// question rather than the whole note.
const NOTE = ['# Evaluation', ...[1, 2, 3, 4, 5].map((at) => `Step ${at}: score the wedge and the market before you judge the idea. ${'The founder writes this down every time they look at one. '.repeat(9)}`)].join('\n\n');

type Wire = { id: string; from: string; to: string };
type Card = { id: string; kind: string };

// Opens the command bar. The key is only heard once the app is listening at the window, which on a busy machine is a
// moment after the page says it has loaded.
async function bar(page: Page) {
  const sheet = page.getByRole('dialog', { name: 'Command bar' });
  await expect(async () => {
    if (!(await sheet.isVisible())) await page.keyboard.press('Control+k');
    await expect(sheet.getByRole('combobox')).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 25_000 });
  return sheet;
}

async function send(page: Page, room: string, text: string) {
  await expect(node(page, room).locator('.status--idle')).toBeVisible();
  await node(page, room).locator('.ask textarea').fill(text);
  await node(page, room).locator('.ask textarea').press('Enter');
  await expect(node(page, room).locator('.status--idle')).toBeVisible({ timeout: 20_000 });
  return node(page, room).locator('.msg--assistant').last();
}

const broke: string[] = [];
let held: string[] = [];
test.beforeEach(async ({ page }) => {
  broke.length = 0;
  page.on('pageerror', (error) => broke.push(error.message));
  // Whatever was said in Maya's room before this journey: anything after it is this journey's and goes again.
  held = ((await (await page.request.get('/api/rooms/marketing/chat')).json()) as { id: string }[]).map((message) => message.id);
  await page.goto('/');
  await expect(node(page, 'marketing')).toBeVisible();
});

test.afterEach(async ({ page }) => {
  await page.goto('about:blank');
  const stage = await (await page.request.get('/api/stage')).json();
  await page.request.put('/api/stage', { data: { ...stage, cards: [], wires: (stage.wires as Wire[]).filter((wire) => wire.id === 'marketing-brand-doc') } });
  for (const note of (await (await page.request.get('/api/library')).json()) as { id: string }[]) await page.request.delete(`/api/library/${note.id}`);
  const chat = (await (await page.request.get('/api/rooms/marketing/chat')).json()) as { id: string }[];
  for (const message of chat) if (!held.includes(message.id)) await page.request.delete(`/api/rooms/marketing/chat/${message.id}`);
  expect(broke).toEqual([]);
});

test('a note pasted into the library stands on the stage and answers from the part that fits', async ({ page }) => {
  // The dock's way in: a note is picked out of the library, not made blank on the canvas.
  await page.getByLabel('More cards').click();
  await page.getByRole('menuitem', { name: 'Add note from library' }).click();
  // The library is not empty on a first start any more — the built-in framework's note is in it — so this journey
  // looks for its own note rather than for an empty shelf.
  await expect(panel(page).getByRole('button', { name: TITLE })).toHaveCount(0);
  await panel(page).getByRole('button', { name: 'Paste' }).click();
  await panel(page).getByLabel('Note title').fill(TITLE);
  await panel(page).getByLabel('Note', { exact: true }).fill(NOTE);
  await panel(page).getByRole('button', { name: 'Add to library' }).click();

  // The panel closes and the note's card is on the stage, with its title and its size on it.
  await expect(panel(page)).toBeHidden();
  const card = page.locator('.react-flow__node-library');
  await expect(card).toBeVisible();
  await expect(card).toContainText(TITLE);
  await expect(card).toContainText('pasted in');
  const cardId = await card.getAttribute('data-id');
  expect(cardId).toBeTruthy();

  // Opening it reads the note, and nothing there can change it: it is the founder's own file.
  await card.getByRole('button', { name: 'Open' }).click();
  const reading = page.getByRole('dialog', { name: TITLE });
  await expect(reading.locator('h1')).toHaveText('Evaluation');
  await expect(reading.locator('textarea')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(reading).toBeHidden();

  // Wired to Maya through the api — drawing wires is the stage journey's business — she is handed the passages of the
  // note that answer her question. The stage saves itself shortly after it changes, so the card is waited for.
  await expect.poll(async () => ((await (await page.request.get('/api/stage')).json()).cards as Card[]).some((one) => one.id === cardId && one.kind === 'library')).toBe(true);
  const stage = await (await page.request.get('/api/stage')).json();
  await page.request.put('/api/stage', { data: { ...stage, wires: [...(stage.wires as Wire[]), { id: `marketing-${cardId}`, from: 'marketing', fromHandle: 'r', to: cardId, toHandle: 'l' }] } });
  await page.reload();
  await expect(node(page, 'marketing')).toBeVisible();

  const answer = await send(page, 'marketing', 'How do I score the wedge and the market of an idea?');
  // The passage is quoted to her whole, under the name of the note it came from.
  await expect(answer).toContainText(`Library: ${TITLE} — Step`);

  // And the bar finds the note by what is inside it, not only by what it is called.
  const sheet = await bar(page);
  await sheet.getByRole('combobox').fill('score the wedge and the market');
  await expect(sheet.getByRole('option', { name: `${TITLE} › Evaluation` }).first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
});
