import { expect, test, type Page } from '@playwright/test';

// The Leads card: the founder adds a lead by hand and moves it, a wired person reads and adds to the same list, and
// "Draft first message" puts the ask into that person's room. The stage and Maya's room are left as they were found.
const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const ID = 'leads-e2e';

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
  const stage = await (await page.request.get('/api/stage')).json();
  await page.request.put('/api/stage', { data: {
    ...stage,
    cards: [...(stage.cards ?? []), { kind: 'leads', id: ID, x: 980, y: 0, w: 900, h: 420 }],
    wires: [...stage.wires, { id: `marketing-${ID}`, from: 'marketing', fromHandle: 'r', to: ID, toHandle: 'l' }],
  } });
  await page.goto('/');
  await expect(node(page, ID)).toBeVisible();
});

test.afterEach(async ({ page }) => {
  await page.goto('about:blank');
  for (const lead of ((await (await page.request.get(`/api/leads/${ID}`)).json()) as { leads: { id: string }[] }).leads) await page.request.delete(`/api/leads/${ID}/${lead.id}`);
  const stage = await (await page.request.get('/api/stage')).json();
  await page.request.put('/api/stage', { data: { ...stage, cards: [], wires: (stage.wires as { id: string }[]).filter((wire) => wire.id === 'marketing-brand-doc') } });
  const chat = (await (await page.request.get('/api/rooms/marketing/chat')).json()) as { id: string; text: string }[];
  const from = chat.findIndex((message) => message.text.startsWith('/tool list_leads'));
  if (from >= 0) for (const message of chat.slice(from)) await page.request.delete(`/api/rooms/marketing/chat/${message.id}`);
  expect(broke).toEqual([]);
});

test('the founder adds a lead and moves it, and a wired person reads and adds to the same list', async ({ page }) => {
  const card = node(page, ID);
  await expect(card.getByText('No leads yet.')).toBeVisible();
  await card.getByLabel('Lead name').fill('Ada Lovelace');
  await card.getByLabel('Company').fill('Engines Ltd');
  await card.getByLabel('One line about them').fill('Asked for this at the meetup');
  await card.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(card.locator('section[aria-label="New"] .lead')).toHaveText(/Ada Lovelace.*Engines Ltd/);
  // An empty stage is a slim strip with its count.
  await expect(card.locator('section[aria-label="Fit: none"]')).toContainText('0');
  // The whole list, ready to paste into a sheet.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await card.getByRole('button', { name: 'Copy as CSV' }).click();
  await expect(card.getByRole('button', { name: 'Copied' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/Ada Lovelace.*Engines Ltd/);

  await card.locator('.lead', { hasText: 'Ada Lovelace' }).click();
  const detail = card.getByRole('dialog', { name: 'Ada Lovelace' });
  await expect(detail).toContainText('Asked for this at the meetup');
  await detail.getByLabel('Stage').selectOption('fit');
  await expect(card.locator('section[aria-label="Fit"] .lead')).toContainText('Ada Lovelace');
  await expect(card.locator('section[aria-label="New: none"]')).toBeVisible();
  await detail.getByLabel('Close lead').click();

  const read = await send(page, 'marketing', '/tool list_leads {}');
  await expect(read.locator('.chip--ok summary')).toHaveText('Read the leads');
  await read.locator('.chip summary').click();
  await expect(read.locator('.chip pre')).toContainText('[fit] Ada Lovelace at Engines Ltd');

  const added = await send(page, 'marketing', '/tool add_lead {"person":"Grace Hopper","company":"Compilers Inc"}');
  await expect(added.locator('.chip--ok summary')).toHaveText('Added lead Grace Hopper at Compilers Inc');
  // What the person did lands on the card at once, over the one live feed.
  await expect(card.locator('section[aria-label="New"] .lead')).toContainText('Grace Hopper');

  // Contacted is the founder's to set: a person asking is refused, and says so.
  const refused = await send(page, 'marketing', '/tool move_lead {"lead":"Grace Hopper","stage":"contacted"}');
  await expect(refused.locator('.chip--fail summary')).toHaveText('Could not: moving Grace Hopper to contacted');
});

test('Draft first message asks the wired person for one', async ({ page }) => {
  const card = node(page, ID);
  const made = await page.request.post(`/api/leads/${ID}`, { data: { name: 'Ada Lovelace', company: 'Engines Ltd' } });
  expect(made.status(), await made.text()).toBe(200);
  await card.locator('.lead', { hasText: 'Ada Lovelace' }).click();
  await card.getByRole('button', { name: 'Draft first message' }).click();
  // The person's card comes forward with the ask already sent, and answers it.
  const focused = page.locator('.card--focused');
  await expect(focused.locator('.msg--user').last()).toContainText('Draft a first message to Ada Lovelace at Engines Ltd using the evidence-outreach skill.');
  await expect(focused.locator('.status--idle')).toBeVisible({ timeout: 20_000 });
  const all = (await (await page.request.get('/api/rooms/marketing/chat')).json()) as { id: string; text: string }[];
  const from = all.findIndex((message) => message.text.startsWith('Draft a first message'));
  expect(from).toBeGreaterThanOrEqual(0);
  for (const message of all.slice(from)) await page.request.delete(`/api/rooms/marketing/chat/${message.id}`);
});
