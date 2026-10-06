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
