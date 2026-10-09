import { expect, test, type Page } from '@playwright/test';

// Journey 19: "video studio" typed alone in the command bar offered no card, and a founder who asks a person for a
// film with no video studio on the stage got nowhere: the film tool is only offered with a studio wired. A film ask
// now puts a studio beside the person and wires it to them, and the reply says so. The stage and Maya's
// conversation are left as they were found.
type Card = { id: string; kind: string };
type Wire = { id: string; from: string; to: string };
const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const stageOf = async (page: Page) => (await page.request.get('/api/stage')).json();
const ASK = 'make a 20 s explainer video about our quote tool';

const broke: string[] = [];
const reset = async (page: Page) => {
  const stage = await stageOf(page);
  await page.request.put('/api/stage', { data: { ...stage, cards: [], wires: (stage.wires as Wire[]).filter((wire) => wire.id === 'marketing-brand-doc') } });
};

test.beforeEach(async ({ page }) => {
  broke.length = 0;
  page.on('pageerror', (error) => broke.push(error.message));
  await reset(page);
  await page.goto('/');
  await expect(node(page, 'marketing')).toBeVisible({ timeout: 60_000 });
});

test.afterEach(async ({ page }) => {
  await page.goto('about:blank');
  await reset(page);
  const chat = (await (await page.request.get('/api/rooms/marketing/chat')).json()) as { id: string; text: string }[];
  const from = chat.findIndex((message) => message.text === ASK);
  if (from >= 0) for (const message of chat.slice(from)) await page.request.delete(`/api/rooms/marketing/chat/${message.id}`);
  expect(broke).toEqual([]);
});

test('a film asked of somebody with no video studio puts one beside them, wired, and the reply says so', async ({ page }) => {
  await expect(node(page, 'marketing').locator('.status--idle')).toBeVisible();
  await node(page, 'marketing').locator('.ask textarea').fill(ASK);
  await node(page, 'marketing').locator('.ask textarea').press('Enter');
  await expect(node(page, 'marketing').locator('.status--idle')).toBeVisible({ timeout: 30_000 });
  await expect(node(page, 'marketing').locator('.msg--assistant').last()).toContainText('There was no video studio, so I added one beside me and wired it to me.');

  const stage = await stageOf(page);
  const studio = (stage.cards as Card[]).find((card) => card.kind === 'videogen');
  expect(studio).toBeTruthy();
  expect((stage.wires as Wire[]).some((wire) => wire.from === 'marketing' && wire.to === studio!.id)).toBe(true);
  // The window heard the stage change: the studio card is on it, without a reload.
  await expect(node(page, studio!.id)).toBeVisible();
  // The line is kept on the message, so a reload shows it too.
  await page.reload();
  await expect(node(page, 'marketing').locator('.msg--assistant').last()).toContainText('I added one beside me and wired it to me');
});

test('"video studio" typed alone in the command bar adds a video studio', async ({ page }) => {
  const input = page.getByRole('combobox', { name: 'Command or search' });
  await expect(async () => {
    await page.keyboard.press('Control+k');
    await expect(input).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  await input.fill('video studio');
  await expect(page.getByRole('listbox', { name: 'Suggestions' }).getByText('Add a video studio')).toBeVisible();
  await input.press('Enter');
  await expect.poll(async () => ((await stageOf(page)).cards as Card[]).filter((card) => card.kind === 'videogen').length).toBe(1);
});
