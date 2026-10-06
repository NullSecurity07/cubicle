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
