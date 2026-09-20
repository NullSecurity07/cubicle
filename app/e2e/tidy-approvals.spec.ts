import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { Attention } from '../shared/model';

// The founder's own morning, made to happen again: two people ask for an OK, the api restarts under them before either
// is answered, and both asks are still on the list when they come back. Nothing here is a door built for the test —
// the restart is the real one (the api runs under `node --watch`, and a deploy restarts it the same way), and the two
// buttons are the founder's own. A lapsed approval cannot be seeded any other way: the list is read from the file once,
// at startup, so writing that file while the app is up changes nothing. The restart is caused in a throwaway folder the
// api is told to watch for this run only; nothing in the checkout is touched, so no app running beside this one moves.
const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const bell = (page: Page) => page.locator('.dock__needs');
const panel = (page: Page) => page.getByRole('dialog', { name: 'Needs you' });
const email = (to: string) => `/tool send_email {"to":"${to}","subject":"Launch day","body":"Hi there"}`;

const send = async (page: Page, room: string, text: string) => {
  await expect(node(page, room).locator('.status--idle')).toBeVisible();
  await node(page, room).locator('.ask textarea').fill(text);
  await node(page, room).locator('.ask textarea').press('Enter');
};
const waiting = async (page: Page): Promise<Attention[]> => {
  const answer = await page.request.get('/api/attention').catch(() => null);
  return answer?.ok() ? ((await answer.json()) as Attention[]) : [];
};

const broke: string[] = [];
const ROOMS = ['marketing', 'build'];
const said = new Map<string, string[]>();
const messageIds = async (page: Page, room: string) => ((await (await page.request.get(`/api/rooms/${room}/chat`)).json()) as { id: string }[]).map((one) => one.id);

test.beforeEach(async ({ page }) => {
  broke.length = 0;
  page.on('pageerror', (error) => broke.push(error.message));
  await page.goto('/');
  await expect(node(page, 'marketing')).toBeVisible();
  for (const room of ROOMS) said.set(room, await messageIds(page, room));
});

test.afterEach(async ({ page }) => {
  for (const room of ROOMS) {
    const had = said.get(room) ?? [];
    for (const id of await messageIds(page, room)) if (!had.includes(id)) await page.request.delete(`/api/rooms/${room}/chat/${id}`);
  }
  expect(broke).toEqual([]);
});

test('an approval the app closed on says what it was, and goes when the founder has dealt with it', async ({ page }) => {
  await send(page, 'marketing', email('alex@example.com'));
  await expect(node(page, 'marketing').getByRole('group', { name: 'Send this email?' })).toBeVisible();
  // A word to Dev first, only so that his conversation is a different length from Maya's: the fake model names a call
  // after the number of messages it was handed, and two calls of the same name are one approval, not two.
  await send(page, 'build', 'hello there');
  await expect(node(page, 'build').locator('.status--idle')).toBeVisible();
  await send(page, 'build', email('sam@example.com'));
  await expect(node(page, 'build').getByRole('group', { name: 'Send this email?' })).toBeVisible();
  await expect.poll(async () => (await waiting(page)).filter((one) => one.kind === 'approval').length).toBe(2);

  // The restart, exactly as it reaches the founder: the watcher sees a file change and starts the api again, and the
  // two turns that were waiting die with it.
  writeFileSync(join(process.env.STAGE_RESTART_DIR!, 'restart.txt'), String(Date.now()));
  await expect.poll(async () => (await waiting(page)).filter((one) => one.lapsed).length, { timeout: 60_000, intervals: [500] }).toBe(2);
  await page.reload();

  // The bell is still lit, and the card says plainly what happened and what was asked.
  await expect(bell(page)).toHaveAttribute('aria-label', 'Needs you: 2 waiting');
  await bell(page).click();
  const lapsed = panel(page).locator('.needs__item--approval').filter({ hasText: 'Maya' });
  await expect(lapsed).toContainText('Maya asked: "Send this email?"');
  await expect(lapsed).toContainText('The app restarted before you answered, so that step never ran.');
  await expect(lapsed).toContainText('The step was: send email, to alex@example.com, subject Launch day.');
  // How long ago, in the same words the clock beside it uses. A busy machine can take a minute over the restart.
  await expect(lapsed).toContainText(/That was (just now|\d+ min ago)\./);
  await page.screenshot({ path: '.shots/tidy-approvals-lapsed.png' });

  // One of them the founder no longer wants: Dismiss, and the bell counts down at once, with nothing reloaded.
  await panel(page).locator('.needs__item--approval').filter({ hasText: 'Dev' }).getByRole('button', { name: 'Dismiss' }).click();
  await expect(bell(page)).toHaveAttribute('aria-label', 'Needs you: 1 waiting');

  // The other they still want: asking again puts them in front of Maya with the ask already typed, and it asks for
  // the work, never for the step — the OK has to be asked for again the usual way.
  await lapsed.getByRole('button', { name: 'Ask Maya again' }).click();
  await expect(panel(page)).toBeHidden();
  const sheet = page.locator('.focus__sheet');
  await expect(sheet.locator('.card--focused')).toBeVisible();
  await expect(sheet.locator('.msg--user').last()).toContainText('Go ahead with what you asked me about: "Send this email?". Ask me again when you need my OK.');
  await page.screenshot({ path: '.shots/tidy-approvals-asked-again.png' });

  // Maya has been asked afresh, so the old ask has done its job: it leaves the list the moment that turn is over.
  await expect(sheet.locator('.status--idle')).toBeVisible({ timeout: 30_000 });
  await expect(bell(page)).toHaveAttribute('aria-label', 'Needs you: nothing waiting');
  await expect.poll(async () => (await waiting(page)).filter((one) => one.kind === 'approval')).toEqual([]);
});
