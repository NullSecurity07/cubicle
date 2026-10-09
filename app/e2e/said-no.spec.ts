import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { Attention } from '../shared/model';

// The founder's no is kept. An email the founder turned down with a reason comes back from the same person: it is put
// to them once more with the earlier no quoted, and turned down again it is not raised a third time; the person is
// told it was already declined.
const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const email = '/tool send_email {"to":"pricing-saidno@example.com","subject":"Price cut to 29 euros","body":"We are cutting the price."}';
const send = async (page: Page, room: string, text: string) => {
  await expect(node(page, room).locator('.status--idle')).toBeVisible();
  await node(page, room).locator('.ask textarea').fill(text);
  await node(page, room).locator('.ask textarea').press('Enter');
};
const waiting = async (page: Page) => ((await (await page.request.get('/api/attention')).json()) as Attention[]).filter((one) => one.kind === 'approval');

test('a no with a reason is quoted when the same proposal comes back, and a second no keeps it from the founder', async ({ page }) => {
  await page.goto('/');
  const room = node(page, 'marketing');
  await expect(room).toBeVisible();

  await send(page, 'marketing', email);
  const first = room.getByRole('group', { name: 'Send this email?' });
  await expect(first.locator('.approval__title')).toHaveText('Send this email?');
  await first.getByLabel("Why not (if you won't)").fill('too early');
  await first.getByRole('button', { name: "Don't" }).click();
  await expect(room.locator('.msg--assistant').last()).toContainText('founder said no');

  await send(page, 'marketing', email);
  const again = room.getByRole('group', { name: 'Send this email?' });
  await expect(again.locator('.approval__title')).toHaveText(/^You said no to this on \d{1,2} \w{3}: 'too early'\. Ask again\?$/);
  await expect.poll(async () => (await waiting(page)).map((one) => one.title)).toEqual([expect.stringContaining("You said no to this on")]);
  await again.getByRole('button', { name: "Don't" }).click();
  await expect(room.locator('.msg--assistant').last()).toContainText('founder said no');

  await send(page, 'marketing', email);
  await expect(room.locator('.msg--assistant').last()).toContainText('Already declined');
  await expect(room.locator('.msg--assistant').last()).toContainText("'too early'");
  await expect(room.getByRole('group', { name: 'Send this email?' })).toHaveCount(0);
  expect(await waiting(page)).toEqual([]);
});

// Journey 15: after a refused draft the colleague said "Drafted the reply" and sent the founder to Gmail with nothing
// to open. The refusal heads the result, and the reply says the refusal instead of the claim.
// Maya's conversation is shared with every other journey, so this test's drafts are taken back out of it.
test.afterEach(async ({ page }) => {
  const chat = (await (await page.request.get('/api/rooms/marketing/chat')).json()) as { id: string; text: string }[];
  const from = chat.findIndex((message) => message.text.includes('refused-draft@example.com'));
  if (from >= 0) for (const message of chat.slice(from)) await page.request.delete(`/api/rooms/marketing/chat/${message.id}`);
});

test('a refused draft is never called drafted, and Gmail is named only beside a draft to open', async ({ page }) => {
  await page.goto('/');
  const room = node(page, 'marketing');
  await expect(room).toBeVisible();
  const draft = '/tool draft_email {"to":"refused-draft@example.com","subject":"Pickup options and one trial job","body":"Hi"}';
  await send(page, 'marketing', draft);
  await expect(room.locator('.chip--ok summary').last()).toHaveText('Drafted email to refused-draft@example.com');
  const bell = page.getByRole('button', { name: /^Needs you/ });
  await bell.click();
  await page.getByRole('dialog', { name: 'Needs you' }).locator('.needs__item--mail-draft').filter({ hasText: 'refused-draft@example.com' }).getByRole('button', { name: 'Dismiss' }).click();
  await page.keyboard.press('Escape');

  await send(page, 'marketing', `${draft}\n/say Drafted the reply to Mira explaining pickup options. Send the draft directly in Gmail.`);
  await expect(room.locator('.approval__title').last()).toHaveText(/^You said no to this on/);
  await room.getByRole('button', { name: "Don't" }).last().click();
  const said = room.locator('.msg--assistant').last();
  await expect(said).toContainText('The email was not drafted: you said no to this.');
  await expect(said).toContainText('(no draft was made)');
  await expect(said).not.toContainText('Drafted the reply');
  await expect(said.getByRole('link', { name: 'Open in Gmail' })).toHaveCount(0);
});

// Journey 16: after a refused propose_decision the partner said "I have proposed the decision ... and it now waits in
// your list"; nothing was in the list. A refused tool that makes something is never reported as done.
test('a refused decision is never said to wait in the list', async ({ page }) => {
  await page.goto('/');
  const room = node(page, 'marketing');
  await expect(room).toBeVisible();
  const propose = '/tool propose_decision {"title":"Pause subscriptions for the refused-decision check","context":"Paying is down.","options":["Pause","Keep going"],"recommendation":"Pause"}';
  await send(page, 'marketing', propose);
  await expect(room.locator('.chip--ok').last()).toBeVisible();
  // The founder takes it out of the list: a no, kept.
  const held = ((await (await page.request.get('/api/decisions')).json()) as { id: string; title: string }[]).find((one) => one.title.startsWith('Pause subscriptions for the refused-decision check'))!;
  await page.request.delete(`/api/decisions/${held.id}`);

  await send(page, 'marketing', `${propose}\n/say I have proposed the decision to pause subscriptions, and it now waits in your list.`);
  await expect(room.locator('.approval__title').last()).toHaveText(/^You said no to this on/);
  await room.getByRole('button', { name: "Don't" }).last().click();
  const said = room.locator('.msg--assistant').last();
  await expect(said).toContainText('The decision was not proposed: you said no to this.');
  await expect(said).not.toContainText('waits in your list');
  const chat = (await (await page.request.get('/api/rooms/marketing/chat')).json()) as { id: string; text: string }[];
  const from = chat.findIndex((message) => message.text.includes('refused-decision check'));
  if (from >= 0) for (const message of chat.slice(from)) await page.request.delete(`/api/rooms/marketing/chat/${message.id}`);
});

const saidNo = async () => ((JSON.parse(await readFile(join(process.env.STAGE_WORKSPACE!, 'said-no.json'), 'utf8').catch(() => '{}')) as { entries?: { subject: string; reason?: string }[] }).entries ?? []);
const clearFrom = async (page: Page, room: string, marker: string) => {
  const chat = (await (await page.request.get(`/api/rooms/${room}/chat`)).json()) as { id: string; text: string }[];
  const from = chat.findIndex((message) => message.text.includes(marker));
  if (from >= 0) for (const message of chat.slice(from)) await page.request.delete(`/api/rooms/${room}/chat/${message.id}`);
};

// Journey 17: a colleague's reply opened with "![chart](/api/files/chart.png)"; no chart was made, and it 404'd.
test('a reply that said it made a chart links no file nothing made', async ({ page }) => {
  await page.goto('/');
  const room = node(page, 'marketing');
  await expect(room).toBeVisible();
  try {
    await send(page, 'marketing', '/say ![chart](/api/files/chart.png) Paying went from 9.5 to 12.5.');
    const said = room.locator('.msg--assistant').last();
    await expect(said).toContainText('(no file was made)');
    await expect(said).toContainText('Paying went from 9.5 to 12.5.');
    await expect(said.locator('img')).toHaveCount(0);
  } finally { await clearFrom(page, 'marketing', '/api/files/chart.png'); }
});
