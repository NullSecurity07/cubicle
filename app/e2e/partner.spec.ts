import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// The partner, in fake mode. "add a partner called Sam" puts Sam on the stage wired to the stage's own Company brief,
// which is adopted as the company's one document: its text kept, its six sections added, no second doc. "morning note" has Sam write today's note: it is said at the top of the
// window, it is first in Today's five, and Needs you lets the founder say it is read. Everything is taken away after.
const WORKSPACE = process.env.STAGE_WORKSPACE!;
type Stage = { rooms: { id: string; name: string; partner?: boolean }[]; docs: { id: string; title: string; pinned?: boolean }[]; wires: { id: string; from: string; to: string }[] };
const stageOf = async (page: Page) => (await (await page.request.get('/api/stage')).json()) as Stage;

async function bar(page: Page, words: string, pick: string) {
  await page.keyboard.press('Control+k');
  const input = page.getByRole('combobox', { name: 'Command or search' });
  await input.fill(words);
  await expect(page.getByRole('listbox', { name: 'Suggestions' }).getByRole('option').first()).toContainText(pick);
  await input.press('Enter');
}

const broke: string[] = [];
let brief = '';
test.beforeEach(async ({ page }) => {
  test.setTimeout(90_000);
  broke.length = 0;
  page.on('pageerror', (error) => broke.push(error.message));
  // The Getting started list is in its corner, as on a first run, whatever an earlier check did with it.
  await rm(join(WORKSPACE, 'missions.json'), { force: true });
  await page.goto('/');
  await expect(page.locator('.react-flow__node[data-id="marketing"]')).toBeVisible({ timeout: 30_000 });
  brief = ((await (await page.request.get('/api/docs/company-brief')).json()) as { text: string }).text;
});

test.afterEach(async ({ page }) => {
  await page.goto('about:blank');
  const stage = await stageOf(page);
  const gone = new Set([...stage.rooms.filter((room) => room.partner).map((room) => room.id), ...stage.docs.filter((doc) => doc.title === 'Company').map((doc) => doc.id)]);
  await page.request.put('/api/docs/company-brief', { data: { text: brief } });
  await page.request.put('/api/stage', { data: { ...stage, rooms: stage.rooms.filter((room) => !gone.has(room.id)), docs: stage.docs.filter((doc) => !gone.has(doc.id)), wires: stage.wires.filter((wire) => !gone.has(wire.from) && !gone.has(wire.to)) } });
  for (const name of ['partner.json', 'bets.json', 'today.json', 'promises.json']) await rm(join(WORKSPACE, name), { force: true });
  expect(broke).toEqual([]);
});

test('the founder adds a partner who keeps the Company document and leaves a morning note', async ({ page }) => {
  await bar(page, 'add a partner called Sam', 'Add Sam, your partner');
  const notice = page.getByRole('status').filter({ hasText: 'Sam is your partner' });
  await expect(notice).toBeVisible({ timeout: 15_000 });

  const stage = await stageOf(page);
  const sam = stage.rooms.find((room) => room.name === 'Sam')!;
  const company = stage.docs.find((doc) => doc.id === 'company-brief')!;
  // The line sits at the top of the window, clear of the two cards it is about, and goes by itself after six seconds.
  const box = (await notice.boundingBox())!;
  expect(box.y).toBeLessThan(40);
  expect(box.height).toBeLessThan(48);
  for (const id of [sam.id, company.id]) {
    await expect.poll(async () => {
      const card = (await page.locator(`.react-flow__node[data-id="${id}"]`).boundingBox())!;
      return card.y >= box.y + box.height || card.x >= box.x + box.width || card.x + card.width <= box.x;
    }).toBe(true);
  }
  await expect(notice).toBeHidden({ timeout: 7_000 });

  // The stage moves Sam into the corner where the Getting started list sits (as a new card elsewhere does, gliding the
  // view to it): the list keeps clear of Sam's ask box, tucked to its head or out of the way until Sam moves on.
  const missions = page.locator('.missions');
  const ask = page.locator(`.react-flow__node[data-id="${sam.id}"] .ask`);
  await expect(missions).toBeVisible();
  const [list, desk] = [(await missions.boundingBox())!, (await ask.boundingBox())!];
  const spot = await page.evaluate(() => {
    for (let y = 60; y < 400; y += 20) for (let x = 400; x < 1500; x += 20) if (document.elementFromPoint(x, y)?.classList.contains('react-flow__pane')) return { x, y };
    return null;
  });
  const [dx, dy] = [list.x + 120 - (desk.x + desk.width / 2), list.y + list.height - 24 - (desk.y + desk.height / 2)];
  await page.mouse.move(spot!.x, spot!.y);
  await page.mouse.down();
  for (let step = 1; step <= 10; step += 1) await page.mouse.move(spot!.x + (dx * step) / 10, spot!.y + (dy * step) / 10);
  await page.mouse.up();
  const clear = async () => {
    const [shown, over] = [await missions.isVisible() ? (await missions.boundingBox())! : null, (await ask.boundingBox())!];
    return !shown || shown.x >= over.x + over.width || over.x >= shown.x + shown.width || shown.y >= over.y + over.height || over.y >= shown.y + shown.height ? 'clear' : 'over the ask box';
  };
  await expect.poll(clear).toBe('clear');
  expect(sam.partner).toBe(true);
  expect(company.pinned).toBe(true);
  expect(stage.docs.filter((doc) => doc.pinned)).toHaveLength(1);
  expect(stage.wires.some((wire) => wire.from === sam.id && wire.to === company.id)).toBe(true);
  const text = ((await (await page.request.get(`/api/docs/${company.id}`)).json()) as { text: string }).text;
  expect(text.startsWith(brief.trimEnd())).toBe(true);
  expect(text).toContain('## Idea');
  expect(text).toContain('## Open questions');
  await expect(page.locator(`.react-flow__node[data-id="${company.id}"] .doc__all`)).toBeVisible();
  // The open card was told of the new sections and shows them.
  await expect(page.locator(`.react-flow__node[data-id="${company.id}"]`)).toContainText('## Open questions');
  // Asked twice, the bar does not make a second partner: it brings Sam forward.
  await bar(page, 'add partner', 'Add your partner');
  await expect(page.getByRole('status').filter({ hasText: 'Sam is already your partner' })).toBeVisible();
  await page.keyboard.press('Escape');
  expect((await stageOf(page)).rooms.filter((room) => room.partner)).toHaveLength(1);

  await bar(page, 'morning note', 'Morning note');
  await expect(page.getByRole('status').filter({ hasText: "Sam's morning note: Fill the empty sections" })).toBeVisible({ timeout: 15_000 });
  const today = (await (await page.request.get('/api/today')).json()) as { items: { kind: string; reason: string }[] };
  expect(today.items[0]).toMatchObject({ kind: 'morning-note', reason: expect.stringContaining('From your partner') });

  await bar(page, 'needs', 'Needs you');
  const needs = page.getByRole('dialog', { name: 'Needs you' });
  const row = needs.locator('.needs__item--morning-note');
  await expect(row).toContainText('Sam left you the morning note');
  await row.getByRole('button', { name: 'Done' }).click();
  await expect(row).toHaveCount(0);

  await page.keyboard.press('Escape');
  await bar(page, 'bets', 'Bets');
  const bets = page.getByRole('dialog', { name: 'Bets' });
  await expect(bets).toContainText('Morning note');
  await expect(bets).toContainText('No bets yet');
});

// A promise the founder makes in any room is kept, dated, and comes to Needs you and Today's five on its day; the
// founder closes it there.
test('the command bar adds the partner by the name typed, with Enter pressed at once', async ({ page }) => {
  // Typed fast: no wait between the words and Enter. The dock asks for "add partner" on its own renders, which once
  // left the bar running the plain "Add your partner" and a partner called Partner.
  await page.keyboard.press('Control+k');
  const input = page.getByRole('combobox', { name: 'Command or search' });
  await input.fill('add a partner');
  await input.fill('add a partner called Sam');
  // The dock's partner button asks the same words with "add partner" whenever it redraws; done here the way it does it.
  await page.evaluate(async () => {
    const slices = (await import(/* @vite-ignore */ `${location.origin}/src/slices/index.ts`)) as { sliceCommands(): { when?(typed: string): boolean }[] };
    slices.sliceCommands().find((one) => one.when?.('add partner'));
  });
  await input.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: 'Sam is your partner' })).toBeVisible({ timeout: 15_000 });
  const partners = (await stageOf(page)).rooms.filter((room) => room.partner).map((room) => room.name);
  expect(partners).toEqual(['Sam']);
});

test('a promise the founder makes comes to Needs you on its day, and the founder closes it', async ({ page }) => {
  await page.request.post('/api/rooms/marketing/chat', { data: { text: 'OK. I\'ll call 5 beta users today.' } });
  const chat = (await (await page.request.get('/api/rooms/marketing/chat')).json()) as { text: string }[];
  expect(chat.at(-1)!.text).toMatch(/\*Kept as a promise: call 5 beta users today \(due \d{4}-\d{2}-\d{2}\)\. It comes to Needs you on the day\.\*$/);
  const today = (await (await page.request.get('/api/today')).json()) as { items: { kind: string; reason: string }[] };
  expect(today.items.find((one) => one.kind === 'promise')).toMatchObject({ reason: expect.stringContaining('Something you said you would do') });

  await bar(page, 'needs', 'Needs you');
  const row = page.getByRole('dialog', { name: 'Needs you' }).locator('.needs__item--promise');
  await expect(row).toContainText('You said you would call 5 beta users today');
  await expect(row).toContainText('Due today.');
  await row.getByRole('button', { name: 'Done' }).click();
  await expect(row).toHaveCount(0);
});
