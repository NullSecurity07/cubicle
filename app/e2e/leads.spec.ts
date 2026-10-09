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
  const from = chat.findIndex((message) => /^\/tool (?:list_leads|draft_email)/.test(message.text));
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
  // Journey 18: with no notes, the ask says nothing is on record about them, so the opener says what we do.
  await expect(focused.locator('.msg--user').last()).toContainText('Nothing is on record about them beyond their name and company');
  await expect(focused.locator('.status--idle')).toBeVisible({ timeout: 20_000 });
  const all = (await (await page.request.get('/api/rooms/marketing/chat')).json()) as { id: string; text: string }[];
  const from = all.findIndex((message) => message.text.startsWith('Draft a first message'));
  expect(from).toBeGreaterThanOrEqual(0);
  for (const message of all.slice(from)) await page.request.delete(`/api/rooms/marketing/chat/${message.id}`);
});

// Journey 21: Lea wrote the first message in chat, signed "[Founder]", and made no draft until asked. With an address
// on record the turn makes the draft from her words: the chip and Needs you have it, and no placeholder is shown.
test('Draft first message makes an email draft at once, with no placeholder', async ({ page }) => {
  test.setTimeout(60_000);
  const card = node(page, ID);
  const made = await page.request.post(`/api/leads/${ID}`, { data: { name: 'Ines Vogel', company: 'Repair Café Kreuzberg', email: 'ines@repaircafe.example' } });
  expect(made.status(), await made.text()).toBe(200);
  await card.locator('.lead', { hasText: 'Ines Vogel' }).click();
  await card.getByRole('button', { name: 'Draft first message' }).click();
  try {
    const focused = page.locator('.card--focused');
    await expect(focused.locator('.msg--user').last()).toContainText('Their address: ines@repaircafe.example.');
    await expect(focused.locator('.status--idle')).toBeVisible({ timeout: 20_000 });
    const reply = focused.locator('.msg--assistant').last();
    await expect(reply.locator('.chip--ok summary')).toHaveText('Drafted email to ines@repaircafe.example');
    await expect(reply).not.toContainText('[Founder]');
    const rows = (await (await page.request.get('/api/attention')).json()) as { kind: string; title: string; url?: string }[];
    const row = rows.find((one) => one.kind === 'mail-draft');
    expect(row?.title).toBe('Email to ines@repaircafe.example ready to send');
    expect(decodeURIComponent(row?.url ?? '')).not.toContain('[Founder]');
  } finally {
    const chat = async () => (await (await page.request.get('/api/rooms/marketing/chat')).json()) as { id: string; role: string; text: string }[];
    await expect.poll(async () => (await chat()).at(-1)?.role, { timeout: 20_000 }).toBe('assistant').catch(() => {});
    for (const entry of (await (await page.request.get('/api/attention')).json()) as { id: string; kind: string }[]) {
      if (entry.kind === 'mail-draft') await page.request.post(`/api/attention/${encodeURIComponent(entry.id)}/dismiss`, { data: { opened: false } });
    }
    const all = await chat();
    const from = all.findIndex((message) => message.text.startsWith('Draft a first message'));
    if (from >= 0) for (const message of all.slice(from)) await page.request.delete(`/api/rooms/marketing/chat/${message.id}`);
  }
});

// Journey 18: Lea's first message to Tom opened "I saw your comment on Reddit" with nothing read. A detail about the
// person nothing on record gives is refused; one their row gives is drafted, and Needs you says what it rests on.
test('a first message says about the lead only what their row or a read gives, and shows where it came from', async ({ page }) => {
  const made = await page.request.post(`/api/leads/${ID}`, { data: { name: 'Tom Becker', company: 'Becker Sanitär', email: 'tom@becker.example' } });
  expect(made.status(), await made.text()).toBe(200);
  const invented = await send(page, 'marketing', '/tool draft_email {"to":"tom@becker.example","subject":"Quotes","body":"Hi Tom,\\n\\nI saw your comment on Reddit about writing up quotes in the van.\\n\\nBest,"}');
  await expect(invented.locator('.chip--fail summary')).toBeVisible();
  await invented.locator('.chip summary').click();
  await expect(invented.locator('.chip pre')).toContainText('I saw your comment on Reddit');
  await expect(invented.locator('.chip pre')).toContainText('open with what we do');

  const honest = await send(page, 'marketing', '/tool draft_email {"to":"tom@becker.example","subject":"Quotes from photos","body":"Hi Tom,\\n\\nI noticed you run Becker Sanitär.\\n\\nBest,"}');
  await expect(honest.locator('.chip--ok summary')).toHaveText('Drafted email to tom@becker.example');
  await page.getByRole('button', { name: /^Needs you/ }).click();
  const row = page.getByRole('dialog', { name: 'Needs you' }).locator('.needs__item--mail-draft');
  await expect(row).toContainText("(from: Tom Becker's row on the Leads card)");
  await page.keyboard.press('Escape');
  for (const entry of (await (await page.request.get('/api/attention')).json()) as { id: string; kind: string }[]) {
    if (entry.kind === 'mail-draft') await page.request.post(`/api/attention/${encodeURIComponent(entry.id)}/dismiss`, { data: { opened: true } });
  }
});

// Journey 20: Lea's first message to Ines opened "I saw Repair Café Kreuzberg's work running community repair evenings"
// with nothing read: the café's name on her row backed the whole detail. The guard holds it from the wired room and
// from a room the card is not wired to, and a plain line about who she is still drafts.
test('a first message dressed in the lead\'s own name is refused from any room', async ({ page }) => {
  const made = await page.request.post(`/api/leads/${ID}`, { data: { name: 'Ines Vogel', company: 'Repair Café Kreuzberg', email: 'ines@repaircafe.example' } });
  expect(made.status(), await made.text()).toBe(200);
  const body = "Hi Ines,\\n\\nI saw Repair Café Kreuzberg's work running community repair evenings.\\n\\nBest,";
  for (const room of ['marketing', 'build']) {
    const invented = await send(page, room, `/tool draft_email {"to":"ines@repaircafe.example","subject":"Bookings","body":"${body}"}`);
    await expect(invented.locator('.chip--fail summary')).toBeVisible();
    // The Leads card may lie over a room it is not wired to: the chip opens without a pointer.
    await invented.locator('.chip summary').dispatchEvent('click');
    await expect(invented.locator('.chip pre')).toContainText("I saw Repair Café Kreuzberg's work");
    await expect(invented.locator('.chip pre')).toContainText('open with what we do');
  }
  const plain = await send(page, 'marketing', '/tool draft_email {"to":"ines@repaircafe.example","subject":"Bookings","body":"Hi Ines,\\n\\nI noticed you run Repair Café Kreuzberg.\\n\\nBest,"}');
  await expect(plain.locator('.chip--ok summary')).toHaveText('Drafted email to ines@repaircafe.example');
  for (const entry of (await (await page.request.get('/api/attention')).json()) as { id: string; kind: string }[]) {
    if (entry.kind === 'mail-draft') await page.request.post(`/api/attention/${encodeURIComponent(entry.id)}/dismiss`, { data: { opened: true } });
  }
  const chat = (await (await page.request.get('/api/rooms/build/chat')).json()) as { id: string; text: string }[];
  const from = chat.findIndex((message) => /^\/tool draft_email/.test(message.text));
  if (from >= 0) for (const message of chat.slice(from)) await page.request.delete(`/api/rooms/build/chat/${message.id}`);
});

test('a pasted spreadsheet becomes leads, read before it lands, and a dropped CSV file opens the same sheet', async ({ page }) => {
  const card = node(page, ID);
  await card.getByLabel('Lead name').fill('Grace Hopper');
  await card.getByLabel('Company').fill('Navy');
  await card.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(card.locator('.lead')).toHaveCount(1);

  await card.getByRole('button', { name: 'Import', exact: true }).click();
  const sheet = card.getByRole('dialog', { name: 'Import leads' });
  await expect(sheet).toBeVisible();
  // Columns named the way a CRM export names them, tabs as a spreadsheet copies them.
  await sheet.getByLabel('Rows to import').fill([
    'Full Name\tOrganisation\tWork Email\tLinkedIn Profile',
    'Ada Lovelace\tAnalytical\tada@analytical.io\tlinkedin.com/in/ada',
    'Grace Hopper\tNavy\t\t',
    'Katherine Johnson\t\tkj@langley-research.org\t',
    '\tNobody Inc\t\t',
  ].join('\n'));
  await expect(sheet).toContainText('Reads Name, Company, Email, LinkedIn.');
  await expect(sheet).toContainText('1 row has no name and will be left out.');
  // The company comes from a work address when the row has none.
  await expect(sheet.locator('tbody tr')).toHaveCount(3);
  await expect(sheet.locator('tbody tr').nth(2)).toContainText('Langley Research');
  // The sheet rises in; the picture is taken once it has arrived.
  await sheet.evaluate((element) => Promise.all(element.getAnimations().map((one) => one.finished)));
  await page.screenshot({ path: 'test-results/shots/leads-import-preview.png', clip: (await card.boundingBox())! });
  await sheet.getByRole('button', { name: 'Import 3 leads' }).click();
  await expect(sheet.getByRole('status')).toHaveText('Added 2 leads, 1 already here, 1 skipped (row 5: no name).');
  await sheet.getByRole('button', { name: 'Done' }).click();
  await expect(sheet).toBeHidden();
  await expect(card.locator('section[aria-label="New"] .lead')).toHaveCount(3);
  await card.locator('.lead', { hasText: 'Ada Lovelace' }).click();
  await expect(card.getByRole('dialog', { name: 'Ada Lovelace' }).getByRole('link', { name: 'LinkedIn' })).toHaveAttribute('href', 'https://linkedin.com/in/ada');
  await card.getByLabel('Close lead').click();

  // A file dropped anywhere on the card opens the sheet with its rows in it.
  const drop = await page.evaluateHandle(() => {
    const moving = new DataTransfer();
    moving.items.add(new File(['name,company,email\nAlan Turing,Bletchley,alan@bletchley.uk\n'], 'contacts.csv', { type: 'text/csv' }));
    return moving;
  });
  await card.locator('.leads__stages').dispatchEvent('dragover', { dataTransfer: drop });
  await card.locator('.leads__stages').dispatchEvent('drop', { dataTransfer: drop });
  await expect(sheet.getByLabel('Rows to import')).toHaveValue(/Alan Turing,Bletchley/);
  await sheet.getByRole('button', { name: 'Import 1 lead' }).click();
  await expect(sheet.getByRole('status')).toHaveText('Added 1 lead.');
  // The focus is on Done once the rows are in, so Escape shuts the sheet from where the founder is.
  await expect(sheet.getByRole('button', { name: 'Done' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(card.locator('.lead')).toHaveCount(4);
});
