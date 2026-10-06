import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { advanceDay, resetClock, tick } from './helpers.ts';

// Day 2, lived without waiting a day (e2e/helpers.ts moves the server's clock; the founder's own run refuses it). On
// day 1 the founder adds Sam as partner and promises in Marketing's room to call five beta users today. The clock goes
// to 06:30 the next morning and the tick runs: nobody asks, yet Sam's morning note is in Sam's chat, leading with what
// changed since yesterday (the promise slipped), and the same line heads the note in Needs you.
const WORKSPACE = process.env.STAGE_WORKSPACE!;
type Stage = { rooms: { id: string; name: string; partner?: boolean }[]; docs: { id: string; title: string }[]; wires: { id: string; from: string; to: string }[] };
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
  await resetClock(page);
  await rm(join(WORKSPACE, 'missions.json'), { force: true });
  await page.goto('/');
  await expect(page.locator('.react-flow__node[data-id="marketing"]')).toBeVisible({ timeout: 30_000 });
  brief = ((await (await page.request.get('/api/docs/company-brief')).json()) as { text: string }).text;
});

test.afterEach(async ({ page }) => {
  await resetClock(page);
  await page.goto('about:blank');
  const stage = await stageOf(page);
  const gone = new Set([...stage.rooms.filter((room) => room.partner).map((room) => room.id), ...stage.docs.filter((doc) => doc.title === 'Company').map((doc) => doc.id)]);
  await page.request.put('/api/docs/company-brief', { data: { text: brief } });
  await page.request.put('/api/stage', { data: { ...stage, rooms: stage.rooms.filter((room) => !gone.has(room.id)), docs: stage.docs.filter((doc) => !gone.has(doc.id)), wires: stage.wires.filter((wire) => !gone.has(wire.from) && !gone.has(wire.to)) } });
  for (const name of ['partner.json', 'bets.json', 'today.json', 'promises.json']) await rm(join(WORKSPACE, name), { force: true });
  expect(broke).toEqual([]);
});

test('on day 2 the partner leaves the morning note unasked, leading with the promise that slipped', async ({ page }) => {
  // Day 1: the partner arrives, and the founder makes a promise for today.
  await bar(page, 'add a partner called Sam', 'Add Sam, your partner');
  await expect(page.getByRole('status').filter({ hasText: 'Sam is your partner' })).toBeVisible({ timeout: 15_000 });
  const sam = (await stageOf(page)).rooms.find((room) => room.name === 'Sam')!;
  // The tick notes the day Sam arrived: the first unasked note is the next morning's.
  await expect.poll(async () => {
    await tick(page);
    return JSON.parse(await readFile(join(WORKSPACE, 'partner.json'), 'utf8').catch(() => '{}')).partnerSince ?? null;
  }, { timeout: 15_000 }).not.toBeNull();
  await page.request.post('/api/rooms/marketing/chat', { data: { text: 'OK. I\'ll call 5 beta users today.' } });
  const said = (await (await page.request.get('/api/rooms/marketing/chat')).json()) as { text: string }[];
  expect(said.at(-1)!.text).toContain('*Kept as a promise: call 5 beta users today');
  // Nothing on day 1: in fake mode the note comes only on a day the clock was moved to.
  expect(((await (await page.request.get(`/api/rooms/${sam.id}/chat`)).json()) as { text: string }[]).some((one) => one.text.startsWith('**Morning,'))).toBe(false);

  // Day 2, 06:30: one tick, nobody asks.
  await advanceDay(page, 1, '06:30');
  let note = '';
  await expect.poll(async () => {
    const chat = (await (await page.request.get(`/api/rooms/${sam.id}/chat`)).json()) as { text: string }[];
    note = chat.find((one) => one.text.startsWith('**Morning,'))?.text ?? '';
    if (!note) await tick(page);
    return note;
  }, { timeout: 30_000 }).toContain('Slipped: you said you would call 5 beta users');
  // The slip leads: above the day's three moves.
  expect(note.split('\n\n')[1]).toMatch(/^\*\*Since yesterday\*\*\n- Slipped: you said you would call 5 beta users today \(due \d{4}-\d{2}-\d{2}\), now 1 day late\.$/);
  expect(note.indexOf('Slipped')).toBeLessThan(note.indexOf('Three moves for today'));

  // Needs you has the note, headed by the same line.
  await page.goto('/');
  await expect(page.locator('.react-flow__node[data-id="marketing"]')).toBeVisible({ timeout: 30_000 });
  await bar(page, 'needs', 'Needs you');
  const row = page.getByRole('dialog', { name: 'Needs you' }).locator('.needs__item--morning-note');
  await expect(row).toContainText('Sam left you the morning note');
  await expect(row).toContainText('Slipped: you said you would call 5 beta users');
});
