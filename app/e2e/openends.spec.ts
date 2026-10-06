import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// The open ends, as the founder meets them: a page that says whether anything needs them, a copy of everything they
// have written, a skill carried in from somewhere else, and what the work came to.
// It runs before the playbook journey (the files go in order), so everything it puts in the playbook it takes out
// again: the next journey has to start from a company that has learned nothing.
const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const panel = (page: Page, title: string) => page.getByRole('dialog', { name: title });
const workspace = () => process.env.STAGE_WORKSPACE!;

const SKILL = `---
name: How to answer a late invoice
description: When a customer writes about an invoice that is past its date
---

# How to answer a late invoice

## When to use
When a customer writes about an invoice that is past its date

## Procedure
1. Read the thread before you answer anything
2. Say what you will do and by when
3. Tell the founder in one line

## Pitfalls
- Never promise a date nobody has agreed to

## Verification
The customer has a date, and the founder has seen it.
`;

// The panel fades in like every other one; anything that looks at it waits for it to have arrived.
async function shown(page: Page, title: string) {
  await expect(panel(page, title)).toBeVisible();
  await panel(page, title).evaluate((sheet) => Promise.all(sheet.getAnimations().map((one) => one.finished)));
  await expect.poll(() => panel(page, title).evaluate((sheet) => getComputedStyle(sheet).opacity)).toBe('1');
}

// This machine is often busy with something else, and a window that is still settling can miss the first key.
// The bar is asked for again rather than the check failing over how loaded the machine was.
async function bar(page: Page, typed: string) {
  const sheet = page.getByRole('dialog', { name: 'Command bar' });
  // The key is only heard once the app is listening at the window, and on a busy machine that can be a moment after the
  // page says it has loaded. Pressed again only while the bar is still shut: a second press on an open bar closes it.
  await expect(async () => {
    if (!(await sheet.isVisible())) await page.keyboard.press('Control+k');
    await expect(sheet.getByRole('combobox')).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 25_000 });
  await sheet.getByRole('combobox').fill(typed);
  await expect(sheet.getByRole('option').first()).toContainText(typed, { ignoreCase: true });
  await page.keyboard.press('Enter');
}

// Turns that already happened, written the way the app writes them down itself: one line a turn, one file a day.
async function seedTrace(lines: { roomId: string; provider: string; input: number; output: number; failed?: boolean }[]) {
  const day = new Date();
  const name = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}.jsonl`;
  const folder = join(workspace(), '.index', 'trace');
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, name), `${lines.map((one) => JSON.stringify({
    at: Date.now(), roomId: one.roomId, source: 'chat', provider: one.provider, model: `${one.provider}-1`,
    usage: { input: one.input, output: one.output }, tools: [{ name: 'web_search', ok: !one.failed }], stopped: false,
  })).join('\n')}\n`);
  return join(folder, name);
}

const broke: string[] = [];
test.beforeEach(async ({ page }) => {
  broke.length = 0;
  page.on('pageerror', (error) => broke.push(error.message));
  await page.goto('/');
  await expect(node(page, 'marketing')).toBeVisible();
});

// Everything this journey puts anywhere is taken back out: the playbook has to be empty for the journey after it.
test.afterEach(async ({ page }) => {
  await page.goto('about:blank');
  for (const skill of (await (await page.request.get('/api/skills')).json()) as { id: string }[]) await page.request.delete(`/api/skills/${skill.id}`);
  await rm(join(workspace(), '.index', 'trace'), { recursive: true, force: true });
  expect(broke).toEqual([]);
});

test('health says in plain words what is fine and what needs you, and a backup can be made from there', async ({ page }) => {
  await bar(page, 'health');
  const health = panel(page, 'Health');
  await shown(page, 'Health');

  // Every row is one thing, said either way round, and a row that needs the founder says what they would do about it.
  const rows = health.locator('.health__row');
  await expect(rows.filter({ hasText: 'Your workspace' })).toContainText('everything you write is kept in');
  await expect(rows.filter({ hasText: 'Your workspace' })).toContainText('Fine');
  const backup = rows.filter({ hasText: 'Backup' });
  await expect(backup).toContainText('nothing has been backed up yet');
  await expect(backup).toContainText('Needs you');
  await expect(backup).toContainText('a second disk or a synced folder');
  // Whether the app keeps working with its window closed, from the systemd user service: yes or no, never a guess.
  await expect(rows.filter({ hasText: 'Runs while closed' })).toContainText(/(yes|no): /);
  await expect(rows.filter({ has: page.locator('.ring--out') })).not.toHaveCount(0);
  await expect(rows.filter({ hasNot: page.locator('.ring--out') })).not.toHaveCount(0);
  // Not a word of any key is ever on this page — only how many there are.
  expect(await health.innerText()).not.toMatch(/sk-|AIza|gsk_/);
  await page.screenshot({ path: '.shots/openends-health.png' });

  // One press, and everything the founder has written is in one file they could carry away.
  await health.getByRole('button', { name: 'Back up now' }).click();
  const made = health.locator('.health__files li').first();
  await expect(made).toContainText(/^cubicle-\d{4}-\d{2}-\d{2}-\d{4}\.tar\.gz/, { timeout: 20_000 });
  await expect(made).toHaveClass(/is-new/);
  await expect(health.locator('.health__part').filter({ hasText: 'Backup' })).toContainText('1 of 5 kept');
  const held = await (await page.request.get('/api/backups')).json();
  expect(held.backups).toHaveLength(1);
  expect(held.backups[0].bytes).toBeGreaterThan(0);
  await page.screenshot({ path: '.shots/openends-backup-made.png' });

  // Opened again, the row that needed the founder does not any more.
  await page.keyboard.press('Escape');
  await expect(health).toBeHidden();
  await bar(page, 'health');
  await expect(panel(page, 'Health').locator('.health__row').filter({ hasText: 'Backup' })).toContainText('the newest made today');
  await page.keyboard.press('Escape');
});

test('health turns the service on with one click, says what it came to, and counts the unasked work', async ({ page }) => {
  await bar(page, 'health');
  const health = panel(page, 'Health');
  await shown(page, 'Health');
  const rows = health.locator('.health__row');
  // A check run's service lives in memory (STAGE_SERVICE_STUB): never installed by the app, off until the click.
  const service = rows.filter({ hasText: 'Runs while closed' });
  await expect(service).toContainText('no: ');
  await expect(service).toContainText('Turn on writes the service and switches it on');
  // The day's budget for work nobody asked for, and how much of it is used.
  await expect(rows.filter({ hasText: 'Unasked work today' })).toContainText(/\d+ of 12 used/);

  await service.scrollIntoViewIfNeeded();
  await page.screenshot({ path: '.shots/health-service-off.png' });
  await service.getByRole('button', { name: 'Runs while closed: Turn on' }).click();
  await expect(service).toContainText('yes: it runs as a service');
  await expect(service.getByRole('status')).toHaveText('Switched on and running. It starts at every login and keeps going while the app is closed.');
  await expect(service.getByRole('button')).toHaveCount(0);
  await expect(service).toContainText('Fine');
  await page.screenshot({ path: '.shots/health-service-on.png' });

  // Asked again, the row stays as the click left it.
  await page.keyboard.press('Escape');
  await expect(health).toBeHidden();
  await bar(page, 'health');
  await expect(panel(page, 'Health').locator('.health__row').filter({ hasText: 'Runs while closed' })).toContainText('yes: it runs as a service');
});

test('Tab keeps to the Health view and never lands on a card behind it', async ({ page }) => {
  await bar(page, 'health');
  await shown(page, 'Health');
  for (let presses = 0; presses < 14; presses += 1) {
    await page.keyboard.press(presses % 5 === 4 ? 'Shift+Tab' : 'Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"][aria-label="Health"]'))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(panel(page, 'Health')).toHaveCount(0);
});

test('outside tools say what they are and that the list is read when the app starts', async ({ page }) => {
  await bar(page, 'health');
  const outside = panel(page, 'Health').locator('.health__part').filter({ hasText: 'Outside tools' });
  await expect(outside).toContainText('start the app again to see the difference');
  await expect(outside).toContainText('No outside programs yet');
  // The word "MCP" is ours, not the founder's: it is nowhere on their screen.
  expect(await panel(page, 'Health').innerText()).not.toContain('MCP');
  await page.keyboard.press('Escape');
});

test('a skill brought in from somewhere else arrives switched off, and one can be taken away', async ({ page }) => {
  await bar(page, 'insights');
  const insights = panel(page, 'Insights');
  await insights.getByLabel('Bring in a skill file').setInputFiles({ name: 'late-invoice.SKILL.md', mimeType: 'text/markdown', buffer: Buffer.from(SKILL) });
  await expect(insights).toContainText('Brought in "How to answer a late invoice". It is switched off until you have read it');
  await page.screenshot({ path: '.shots/openends-skill-brought-in.png' });

  // It really is off, and it really says it came from outside.
  const held = (await (await page.request.get('/api/skills')).json()) as { id: string; name: string; state: string; source: { ref: string }; by: { name: string } }[];
  expect(held).toHaveLength(1);
  expect(held[0]).toMatchObject({ name: 'How to answer a late invoice', state: 'off', source: { ref: 'outside' }, by: { name: 'Somebody outside' } });

  // And the playbook, which is the one place the founder reads what the people work from, shows it switched off.
  await page.keyboard.press('Escape');
  await bar(page, 'playbook');
  const row = panel(page, 'Playbook').locator('.skill').filter({ hasText: 'How to answer a late invoice' });
  await expect(row.getByLabel('Use "How to answer a late invoice"')).not.toBeChecked();
  await expect(row).toContainText('Somebody outside learned this');
  await page.keyboard.press('Escape');

  // The same skill written back out reads as the file it came from.
  const file = await (await page.request.get(`/api/skill-files/${held[0].id}`)).json();
  expect(file.file).toBe(`${held[0].id}.SKILL.md`);
  expect(file.text).toContain('## Procedure\n1. Read the thread before you answer anything');
  expect(file.text).toContain('description: When a customer writes about an invoice that is past its date');

  // A file that is not a skill is refused in words, and nothing is added.
  await bar(page, 'insights');
  await panel(page, 'Insights').getByLabel('Bring in a skill file').setInputFiles({ name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Just a heading') });
  await expect(panel(page, 'Insights')).toContainText('has no procedure');
  expect(await (await page.request.get('/api/skills')).json()).toHaveLength(1);
  await page.keyboard.press('Escape');
});

test('insights add up what the work came to, and say so kindly when there is nothing yet', async ({ page }) => {
  await bar(page, 'insights');
  await expect(panel(page, 'Insights')).toContainText('Nothing to show for these days yet');
  await page.keyboard.press('Escape');

  await seedTrace([
    { roomId: 'marketing', provider: 'groq', input: 1200, output: 300 },
    { roomId: 'marketing', provider: 'groq', input: 900, output: 150, failed: true },
    { roomId: 'build', provider: 'gemini', input: 40_000, output: 800 },
  ]);
  await page.reload();
  await expect(node(page, 'marketing')).toBeVisible();
  await bar(page, 'insights');
  const insights = panel(page, 'Insights');
  await shown(page, 'Insights');

  await expect(panel(page, 'Insights').locator('.panel__header')).toContainText('3 turns');
  await expect(insights.locator('.insights__totals')).toContainText('43,350');
  await expect(insights.locator('.insights__totals li').filter({ hasText: 'tool calls' })).toContainText('tool calls, 1 failed');
  // A row a person: the one who spent the most is at the top, and the bar is as long as that.
  const people = insights.locator('.insights__part').filter({ hasText: 'Who did the work' }).locator('.insights__bars li');
  await expect(people.first()).toContainText('Dev');
  await expect(people.first()).toContainText('40,800');
  await expect(people.nth(1)).toContainText('Maya');
  await expect(people.first().locator('.insights__fill')).toHaveCSS('width', /.+/);
  await expect(insights.locator('.insights__part').filter({ hasText: 'Which model answered' }).locator('.insights__bars li').first()).toContainText('gemini');
  await page.screenshot({ path: '.shots/openends-insights.png' });

  // Thirty days holds the same turns, and the panel stays inside the window at either size.
  await insights.getByRole('button', { name: 'Last 30 days' }).click();
  await expect(panel(page, 'Insights').locator('.panel__header')).toContainText('3 turns');
  for (const size of [{ width: 1600, height: 1000 }, { width: 1280, height: 720 }]) {
    await page.setViewportSize(size);
    await shown(page, 'Insights');
    const sheet = (await insights.boundingBox())!;
    expect(sheet.y).toBeGreaterThanOrEqual(0);
    expect(sheet.y + sheet.height).toBeLessThanOrEqual(size.height);
    await expect(insights.locator('.panel__header')).toBeInViewport({ ratio: 1 });
  }
  await page.keyboard.press('Escape');
  await expect(insights).toBeHidden();
});

test('backups can be sent to a folder off this machine, and the dashboard says when the last one was made', async ({ page }) => {
  // The dashboard asks its health rows again after a new backup, and those ask programs on the PATH for their
  // versions: seconds each on a busy machine.
  test.setTimeout(60_000);
  const away = `${workspace()}-offsite`;
  const folder = join(away, 'Cubicle backups');
  try {
    await bar(page, 'health');
    const health = panel(page, 'Health');
    await shown(page, 'Health');
    const part = health.locator('.health__part').filter({ hasText: 'Backup' });
    await part.getByRole('button', { name: 'Back up to…' }).click();
    const where = part.getByRole('form', { name: 'Where backups go' });
    // It starts from where they go now, and a folder inside the workspace it would copy is refused in words.
    await expect(where.getByLabel('Backup folder')).toHaveValue(join(workspace(), 'backups'));
    await where.getByLabel('Backup folder').fill(join(workspace(), 'inside'));
    await where.getByRole('button', { name: 'Use this folder' }).click();
    await expect(part).toContainText('inside the workspace it would be copying');
    await where.getByLabel('Backup folder').fill(folder);
    await expect(part.locator('.msg--problem')).toBeHidden();
    await page.screenshot({ path: 'test-results/shots/backup-to.png', clip: (await health.boundingBox())! });
    await where.getByRole('button', { name: 'Use this folder' }).click();
    await expect(where).toBeHidden();
    await expect(part).toContainText(`They go to ${folder}`);
    await expect(part).toContainText('Nothing has been backed up yet.');

    await part.getByRole('button', { name: 'Back up now' }).click();
    await expect(part.locator('.health__files li').first()).toContainText(/^cubicle-\d{4}-\d{2}-\d{2}-\d{4}\.tar\.gz/, { timeout: 20_000 });
    expect((await readdir(folder)).filter((name) => name.endsWith('.tar.gz'))).toHaveLength(1);
    // The folder is written down for this workspace, inside it, never in .env for the whole machine.
    expect(JSON.parse(await readFile(join(workspace(), 'backup-to.json'), 'utf8'))).toEqual({ dir: folder });
    expect(await readFile(join(workspace(), '.env'), 'utf8').catch(() => '')).not.toContain('STAGE_BACKUP_DIR');
    await page.keyboard.press('Escape');
    await expect(health).toBeHidden();

    await bar(page, 'dashboard');
    const today = new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const line = page.locator('.dash__backup');
    await expect(line).toContainText(`Last backup ${today}`);
    await expect(line).toContainText(`to ${folder}`);
    await expect(line).not.toHaveClass(/is-late/);
    // The Backup row under it is asked again once the dashboard sees a new backup, and says the same.
    await expect(page.locator('.dash__health li').filter({ hasText: 'Backup' })).toContainText('the newest made today', { timeout: 30_000 });
    await line.scrollIntoViewIfNeeded();
    await line.locator('xpath=..').screenshot({ path: 'test-results/shots/dashboard-last-backup.png' });
    await page.keyboard.press('Escape');
  } finally {
    // Back to the default folder, from the page: only the app's own window may choose it.
    await page.goto('/');
    await page.evaluate(() => fetch('/api/keys-file/STAGE_BACKUP_DIR', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: '' }) }));
    await rm(away, { recursive: true, force: true });
  }
});
