import { expect, test, type Page } from '@playwright/test';

// A lead's thread on the Leads card, with no mail key: the founder adds a lead with an address, Maya drafts to them,
// opening the draft in Gmail marks them Contacted, a pasted reply marks them Replied and offers an answer, and a meeting
// set for yesterday puts a dated task on the board and asks how it went. The stage and Maya's room are put back after.
const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const LEADS = 'leads-thread-e2e';
const BOARD = 'board-thread-e2e';
const day = (offset: number) => { const at = new Date(Date.now() + offset * 86_400_000); return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`; };

async function send(page: Page, room: string, text: string) {
  await expect(node(page, room).locator('.status--idle')).toBeVisible();
  await node(page, room).locator('.ask textarea').fill(text);
  await node(page, room).locator('.ask textarea').press('Enter');
  await expect(node(page, room).locator('.status--idle')).toBeVisible({ timeout: 20_000 });
}

const broke: string[] = [];
test.beforeEach(async ({ page }) => {
  broke.length = 0;
  page.on('pageerror', (error) => broke.push(error.message));
  await page.context().route('https://mail.google.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Gmail</title>' }));
  const stage = await (await page.request.get('/api/stage')).json();
  await page.request.put('/api/stage', { data: {
    ...stage,
    cards: [...(stage.cards ?? []), { kind: 'leads', id: LEADS, x: 980, y: 0, w: 900, h: 460 }, { kind: 'board', id: BOARD, x: 980, y: 520, w: 780, h: 380 }],
    wires: [...stage.wires, { id: `marketing-${LEADS}`, from: 'marketing', fromHandle: 'r', to: LEADS, toHandle: 'l' }],
  } });
  await page.goto('/');
  await expect(node(page, LEADS)).toBeVisible();
});

test.afterEach(async ({ page }) => {
  await page.goto('about:blank');
  for (const lead of ((await (await page.request.get(`/api/leads/${LEADS}`)).json()) as { leads: { id: string }[] }).leads) await page.request.delete(`/api/leads/${LEADS}/${lead.id}`);
  for (const task of (await (await page.request.get(`/api/boards/${BOARD}`)).json()) as { id: string }[]) await page.request.delete(`/api/boards/${BOARD}/tasks/${task.id}`);
  const chat = (await (await page.request.get('/api/rooms/marketing/chat')).json()) as { id: string; text: string }[];
  const from = chat.findIndex((message) => message.text.startsWith('/tool draft_email'));
  if (from >= 0) for (const message of chat.slice(from)) await page.request.delete(`/api/rooms/marketing/chat/${message.id}`);
  for (const entry of (await (await page.request.get('/api/attention')).json()) as { id: string; kind: string }[]) {
    if (entry.kind === 'mail-draft') await page.request.post(`/api/attention/${encodeURIComponent(entry.id)}/dismiss`, { data: { opened: true } });
  }
  const stage = await (await page.request.get('/api/stage')).json();
  await page.request.put('/api/stage', { data: { ...stage, cards: (stage.cards as { id: string }[]).filter((card) => card.id !== LEADS && card.id !== BOARD), wires: (stage.wires as { id: string }[]).filter((wire) => wire.id !== `marketing-${LEADS}`) } });
  expect(broke).toEqual([]);
});

test('a lead\'s thread on the Leads card: drafted, opened in Gmail, replied, meeting set, then the notes are asked for', async ({ page }) => {
  const card = node(page, LEADS);
  await card.getByLabel('Lead name').fill('Ada Lovelace');
  await card.getByLabel('Company').fill('Engines Ltd');
  await card.getByLabel('Email').fill('ada@engines.example');
  await card.getByRole('button', { name: 'Add', exact: true }).click();
  const row = card.locator('.lead', { hasText: 'Ada Lovelace' });
  await expect(card.locator('section[aria-label="New"] .lead')).toHaveText(/Ada Lovelace/);

  // Maya drafts to the address on the card; the row says so.
  await send(page, 'marketing', '/tool draft_email {"to":"ada@engines.example","subject":"Your engines","body":"Hi Ada"}');
  await expect(row.locator('.lead__thread')).toHaveText(/^Email drafted · /);

  // Opening it in Gmail is the founder sending it: Contacted, with the day.
  const [tab] = await Promise.all([page.waitForEvent('popup'), node(page, 'marketing').getByRole('link', { name: 'Open in Gmail' }).last().click()]);
  await tab.close();
  await expect(card.locator('section[aria-label="Contacted"] .lead')).toHaveText(/Ada Lovelace/);
  await expect(row.locator('.lead__thread')).toHaveText(/^Opened in Gmail · /);

  // They replied: pasted by hand, kept on the thread, and an answer is offered.
  await row.click();
  const detail = card.getByRole('dialog', { name: 'Ada Lovelace' });
  await detail.getByRole('button', { name: 'They replied' }).click();
  await detail.getByLabel('Their reply').fill('Interesting. What would it cost for our 12 engineers?');
  await detail.getByRole('button', { name: 'Save reply' }).click();
  await expect(card.locator('section[aria-label="Replied"] .lead')).toHaveText(/Ada Lovelace/);
  await expect(detail.locator('.thread__event--replied')).toContainText('What would it cost for our 12 engineers?');
  await expect(detail.getByRole('button', { name: 'Draft an answer' })).toBeEnabled();

  const bell = page.getByRole('button', { name: /^Needs you/ });
  await bell.click();
  const needs = page.getByRole('dialog', { name: 'Needs you' });
  const reply = needs.locator('.needs__item--lead-replied');
  await expect(reply).toContainText('Ada Lovelace at Engines Ltd replied. Draft an answer?');
  await expect(reply.getByRole('button', { name: 'Draft an answer' })).toBeEnabled();
  await page.keyboard.press('Escape');

  // A meeting set for yesterday: Meeting, a task dated that day on the board, and today the notes are asked for.
  await detail.getByRole('button', { name: 'Meeting set' }).click();
  await detail.getByLabel('Meeting day').fill(day(-1));
  await detail.getByRole('button', { name: 'Set meeting' }).click();
  await expect(card.locator('section[aria-label="Meeting"] .lead')).toHaveText(/Ada Lovelace/);
  await expect(node(page, BOARD)).toContainText('Meeting with Ada Lovelace at Engines Ltd');
  const tasks = (await (await page.request.get(`/api/boards/${BOARD}`)).json()) as { title: string; due?: string }[];
  expect(tasks).toEqual([expect.objectContaining({ title: 'Meeting with Ada Lovelace at Engines Ltd', due: day(-1) })]);

  await expect(detail.getByLabel('Meeting notes')).toBeVisible();
  await bell.click();
  const ask = needs.locator('.needs__item--lead-notes');
  await expect(ask).toContainText('How did the meeting with Ada Lovelace go?');
  await ask.getByLabel('Meeting notes').fill('Good call. They want a pilot, not ready to pay yet.');
  await ask.getByRole('button', { name: 'Save notes' }).click();
  await expect(ask).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(detail.locator('.thread__event--notes')).toContainText('They want a pilot');
});
