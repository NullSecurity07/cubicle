import { expect, test, type Page } from '@playwright/test';

// The safety net as the founder meets it: a step that is stopped before anybody is asked, and a yes that holds for
// one address and no further.
const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const panel = (page: Page) => page.getByRole('dialog', { name: 'Always allowed' });

const send = async (page: Page, room: string, text: string) => {
  await expect(node(page, room).locator('.status--idle')).toBeVisible();
  await node(page, room).locator('.ask textarea').fill(text);
  await node(page, room).locator('.ask textarea').press('Enter');
};
const email = (to: string, subject: string) => `/tool send_email {"to":"${to}","subject":"${subject}","body":"Hi there"}`;

// Opens the command bar and runs the first thing it offers for what was typed.
async function bar(page: Page, typed: string) {
  await page.keyboard.press('Control+k');
  const box = page.getByRole('dialog', { name: 'Command bar' }).getByRole('combobox');
  await box.fill(typed);
  await expect(page.getByRole('dialog', { name: 'Command bar' }).getByRole('option').first()).toContainText(typed, { ignoreCase: true });
  await page.keyboard.press('Enter');
}

// A panel fades in; anything that looks at it waits for it to finish arriving.
async function shown(page: Page) {
  await expect(panel(page)).toBeVisible();
  await panel(page).evaluate((sheet) => Promise.all(sheet.getAnimations().map((one) => one.finished)));
  await expect.poll(() => panel(page).evaluate((sheet) => getComputedStyle(sheet).opacity)).toBe('1');
}

const broke: string[] = [];
test.beforeEach(async ({ page }) => {
  broke.length = 0;
  page.on('pageerror', (error) => broke.push(error.message));
  await page.goto('/');
  await expect(node(page, 'marketing')).toBeVisible();
});

// Standing yeses outlive a journey on purpose, so this one puts them all back the way it found them.
test.afterEach(async ({ page }) => {
  for (const rule of (await (await page.request.get('/api/safety/rules')).json()) as { id: string }[]) {
    await page.request.delete(`/api/safety/rules/${rule.id}`);
  }
  expect(broke).toEqual([]);
});

test('a step that must not happen is stopped before the founder is asked anything', async ({ page }) => {
  await send(page, 'build', '/tool run_code {"language":"python","code":"import os; os.system(\\"rm -rf /\\")"}');
  const reply = node(page, 'build').locator('.msg--assistant').last();
  await expect(reply.locator('.chip--fail summary')).toContainText('Could not: running python code');
  // Nobody was asked: running this is not something the founder is offered a button for.
  await expect(node(page, 'build').getByRole('group', { name: 'Run this code?' })).toHaveCount(0);
  await reply.locator('.chip--fail summary').click();
  await expect(reply.locator('.chip--fail pre')).toContainText('This step was stopped: it would have erased a whole disk or home folder.');
  await expect(node(page, 'build').locator('.status--idle')).toBeVisible();
  await page.screenshot({ path: '.shots/safety-stopped-step.png' });
});

test('"Always allow" holds for one address and no further, and is taken back in one place', async ({ page }) => {
  const room = node(page, 'marketing');
  await send(page, 'marketing', email('alex@example.com', 'Hello'));
  const ask = room.getByRole('group', { name: 'Send this email?' });
  await expect(ask).toBeVisible();
  await expect(ask.getByLabel('Always allow emails to alex@example.com')).not.toBeChecked();
  await page.screenshot({ path: '.shots/safety-always-allow.png' });
  await ask.getByLabel('Always allow emails to alex@example.com').check();
  await ask.getByRole('button', { name: 'Send' }).click();
  await expect(room.locator('.chip--ok summary').last()).toHaveText('Emailed alex@example.com');

  // The next one to that address goes without a word: the turn finishes with nothing waiting.
  await send(page, 'marketing', email('alex@example.com', 'Again'));
  await expect(room.locator('.chip--ok summary').last()).toHaveText('Emailed alex@example.com');
  await expect(room.getByRole('group', { name: 'Send this email?' })).toHaveCount(0);
  await expect(room.locator('.status--idle')).toBeVisible();

  // Anybody else is still the founder's to answer.
  await send(page, 'marketing', email('sam@example.com', 'Hello'));
  const other = room.getByRole('group', { name: 'Send this email?' });
  await expect(other).toBeVisible();
  await expect(other.getByLabel('Always allow emails to sam@example.com')).toBeVisible();
  await other.getByRole('button', { name: "Don't" }).click();
  await expect(room.locator('.chip--fail summary').last()).toContainText('Could not');

  // One list holds every standing yes, and one press takes it back.
  await bar(page, 'always allowed');
  await shown(page);
  await expect(panel(page)).toContainText('Maya: emails to alex@example.com, without asking you.');
  await expect(panel(page)).toContainText('1 standing');
  await page.screenshot({ path: '.shots/safety-allowed-panel.png' });
  await panel(page).getByRole('button', { name: 'Take it back' }).click();
  await expect(panel(page)).toContainText('Nothing stands allowed yet.');
  await page.keyboard.press('Escape');
  await expect(panel(page)).toBeHidden();

  // Taken back, the same email waits for the founder again.
  await send(page, 'marketing', email('alex@example.com', 'Once more'));
  await expect(room.getByRole('group', { name: 'Send this email?' })).toBeVisible();
  await room.getByRole('group', { name: 'Send this email?' }).getByRole('button', { name: "Don't" }).click();
  await expect(room.locator('.status--idle')).toBeVisible();
});
