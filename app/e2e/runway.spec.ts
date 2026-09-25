import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { project, todayOf, type Runway } from '../shared/runway';

// The Runway card: the founder adds it from the dock, enters cash and two flows and reads months left and the day
// cash runs out, adds a scenario and sees its line beside Base, exports the numbers, then wires Maya, who reads
// the card and suggests a flow the founder accepts. The stage and Maya's room are left as they were found.
const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const SHOTS = 'test-results/shots';
const dayName = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

async function send(page: Page, room: string, text: string) {
  await expect(node(page, room).locator('.status--idle')).toBeVisible();
  await node(page, room).locator('.ask textarea').fill(text);
  await node(page, room).locator('.ask textarea').press('Enter');
  await expect(node(page, room).locator('.status--idle')).toBeVisible({ timeout: 20_000 });
  return node(page, room).locator('.msg--assistant').last();
}

async function tidy(page: Page) {
  const stage = await (await page.request.get('/api/stage')).json();
  await page.request.put('/api/stage', { data: { ...stage, cards: [], wires: (stage.wires as { id: string }[]).filter((wire) => wire.id === 'marketing-brand-doc') } });
}

const broke: string[] = [];
test.beforeEach(async ({ page }) => {
  broke.length = 0;
  page.on('pageerror', (error) => broke.push(error.message));
  await page.goto('/');
  await tidy(page);
  await page.reload();
  await expect(node(page, 'marketing')).toBeVisible();
});

test.afterEach(async ({ page }) => {
  await page.goto('about:blank');
  await tidy(page);
  const chat = (await (await page.request.get('/api/rooms/marketing/chat')).json()) as { id: string; text: string }[];
  const from = chat.findIndex((message) => message.text.startsWith('/tool read_runway'));
  if (from >= 0) for (const message of chat.slice(from)) await page.request.delete(`/api/rooms/marketing/chat/${message.id}`);
  expect(broke).toEqual([]);
});

test('the founder builds a runway, compares a scenario, exports it, and a wired person reads it and suggests a flow', async ({ page }) => {
  test.setTimeout(90_000);
  const today = todayOf(Date.now());
  await page.getByRole('button', { name: 'More cards' }).click();
  await page.getByRole('menuitem', { name: 'Add runway', exact: true }).click();
  const card = page.locator('.react-flow__node-runway');
  await expect(card).toHaveCount(1);
  const id = (await card.getAttribute('data-id'))!;
  await expect(card.getByText('Enter the cash in the bank, then what goes out and comes in each month.')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Export CSV' })).toBeDisabled();

  // Cash, counted today, then what goes out and what comes in.
  await card.getByLabel('Cash in the bank').fill('120,000');
  await card.getByLabel('Cash in the bank').press('Enter');
  await expect(card.getByLabel('Cash in the bank')).toHaveValue('$120,000');
  await card.getByLabel('New flow label').fill('Team');
  await card.getByLabel('New flow a month').fill('-10000');
  await card.getByLabel('New flow a month').press('Enter');
  await expect(card.getByLabel('Team a month')).toHaveValue('-$10,000');
  await card.getByLabel('New flow label').fill('Sales');
  await card.getByLabel('New flow a month').fill('2000');
  await card.getByRole('button', { name: 'Add flow' }).click();
  await expect(card.getByLabel('Sales a month')).toHaveValue('$2,000');

  // The same TypeScript the card uses says what the founder should read.
  const month = today.slice(0, 7);
  const numbers: Runway = { cash: { amount: 120_000, asOf: today }, flows: [{ id: 'a', label: 'Team', monthly: -10_000, from: month }, { id: 'b', label: 'Sales', monthly: 2000, from: month, category: 'revenue' }], scenarios: [] };
  const base = project(numbers, undefined, today);
  await expect(card.getByLabel('Months left')).toHaveText(base.monthsLeft!.toFixed(1));
  await expect(card.getByLabel('Cash out')).toHaveText(dayName(base.zero!));
  await expect(card.locator('.runway__facts')).toContainText('$10,000 a month');
  await expect(card.locator('.runway__line')).toHaveCount(1);
  // What the founder typed is what the server keeps.
  await expect.poll(async () => ((await (await page.request.get(`/api/runway/${id}`)).json()) as { runway: Runway }).runway.flows.map((one) => one.label)).toEqual(['Team', 'Sales']);

  // A scenario: Sales stops. Its line joins Base's, and the four lines follow the tab in front.
  await card.getByRole('button', { name: 'Add scenario' }).click();
  await card.getByLabel('Scenario name').fill('Lose Sales');
  await card.getByLabel('Scenario name').press('Enter');
  await expect(card.getByRole('tab', { name: 'Lose Sales' })).toHaveAttribute('aria-selected', 'true');
  await expect(card.locator('.runway__line')).toHaveCount(2);
  await card.getByLabel('Base flows in this plan').getByLabel('Sales').uncheck();
  const lost = project({ ...numbers, scenarios: [{ id: 's', name: 'Lose Sales', changes: [{ drop: 'b' }] }] }, 's', today);
  await expect(card.getByLabel('Months left')).toHaveText(lost.monthsLeft!.toFixed(1));
  await expect(card.locator('.runway__line[data-plan="Lose Sales"]')).toHaveClass(/is-active/);
  await page.screenshot({ path: `${SHOTS}/runway-scenario.png`, clip: (await card.boundingBox())! });
  await card.getByRole('tab', { name: 'Base' }).click();
  await expect(card.getByLabel('Months left')).toHaveText(base.monthsLeft!.toFixed(1));

  // The numbers go out as a spreadsheet, named for the day.
  const [download] = await Promise.all([page.waitForEvent('download'), card.getByRole('button', { name: 'Export CSV' }).click()]);
  expect(download.suggestedFilename()).toBe(`runway-${today}.csv`);
  const sheet = (await readFile((await download.path())!, 'utf8')).split('\n');
  expect(sheet[0]).toBe('month,Team,Sales,net (Base),cash at month end (Base),cash at month end (Lose Sales)');
  expect(sheet).toHaveLength(26);

  // Unwired, Maya is not offered the runway tools at all: asked to read it, she has nothing to call.
  const blind = await send(page, 'marketing', '/tool read_runway {}');
  await expect(blind.locator('.chip')).toHaveCount(0);

  // Nobody reads it yet; wire Maya and she does, through her tools and the line in her prompt.
  await expect(card.locator('.runway__foot')).toContainText('Nobody reads these yet.');
  const stage = await (await page.request.get('/api/stage')).json();
  await page.request.put('/api/stage', { data: { ...stage, wires: [...stage.wires, { id: `marketing-${id}`, from: 'marketing', fromHandle: 'r', to: id, toHandle: 'l' }] } });
  await page.reload();
  await expect(card.locator('.runway__foot')).toContainText('These numbers reach whichever model Maya uses');
  const read = await send(page, 'marketing', '/tool read_runway {}');
  await expect(read.locator('.chip--ok summary')).toHaveText('Read the runway');
  await read.locator('.chip summary').click();
  await expect(read.locator('.chip pre')).toContainText('Base: cash $120,000 on');
  await expect(read.locator('.chip pre')).toContainText('Other plans: "Lose Sales".');

  // A suggestion waits on the card and in Needs you, and counts only when the founder accepts it.
  const asked = await send(page, 'marketing', '/tool propose_flow {"label":"Engineer","monthly":-9000,"from":"2027-01","why":"The build plan needs one"}');
  await expect(asked.locator('.chip--ok summary')).toHaveText('Suggested a flow');
  const waiting = card.getByRole('list', { name: 'Suggestions waiting for you' });
  await expect(waiting).toContainText('Maya suggests "Engineer", -$9,000 a month from 2027-01.');
  await expect(page.getByRole('button', { name: /Needs you: [1-9]/ })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/runway-suggestion.png`, clip: (await card.boundingBox())! });
  await waiting.getByRole('button', { name: 'Accept' }).click();
  await expect(waiting).toHaveCount(0);
  await expect(card.getByLabel('Engineer a month')).toHaveValue('-$9,000');

  // Cash drops to three weeks' worth: the months turn red, Needs you says so once, and Seen puts it away.
  await card.getByLabel('Cash in the bank').fill('15000');
  await card.getByLabel('Cash in the bank').press('Enter');
  await expect(card.getByLabel('Months left')).toHaveClass(/is-red/);
  const alert = card.getByRole('status');
  await expect(alert).toContainText('Under three months of cash.');
  await page.getByRole('button', { name: /Needs you: [1-9]/ }).click();
  await expect(page.getByText(/^Cash runs out in \d/)).toBeVisible();
  await page.keyboard.press('Escape');
  await page.screenshot({ path: `${SHOTS}/runway-low.png`, clip: (await card.boundingBox())! });
  await alert.getByRole('button', { name: 'Seen' }).click();
  await expect(alert.getByRole('button', { name: 'Seen' })).toHaveCount(0);
  await expect(page.getByText(/^Cash runs out in \d/)).toHaveCount(0);
});

test('a pasted bank statement becomes candidate flows, and only ticked ones count', async ({ page }) => {
  await page.getByRole('button', { name: 'More cards' }).click();
  await page.getByRole('menuitem', { name: 'Add runway', exact: true }).click();
  const card = page.locator('.react-flow__node-runway');
  await card.getByRole('button', { name: 'Paste bank CSV' }).click();
  const panel = card.getByRole('dialog', { name: 'Paste a bank statement' });
  await panel.getByLabel('Bank CSV').fill(['Date,Description,Amount', '2026-07-01,Office rent July,-2000', '2026-08-01,Office rent August,-2000', '2026-07-28,GUSTO PAYROLL,"-8,000.00"', '2026-08-28,GUSTO PAYROLL,"-8,000.00"', '2026-08-03,Corner coffee,-6'].join('\n'));
  await expect(panel).toContainText('5 rows over 2 months');
  await expect(panel.getByRole('list', { name: 'Lines found' }).locator('li')).toHaveCount(3);
  await expect(panel.getByRole('button', { name: 'Tick what repeats' })).toBeDisabled();
  await panel.getByRole('checkbox', { name: /GUSTO PAYROLL/ }).check();
  await panel.getByRole('checkbox', { name: /Office rent/ }).check();
  await page.screenshot({ path: `${SHOTS}/runway-bank.png`, clip: (await card.boundingBox())! });
  await panel.getByRole('button', { name: 'Add 2 to Base' }).click();
  await expect(panel).toHaveCount(0);
  await expect(card.getByLabel('GUSTO PAYROLL a month')).toHaveValue('-$8,000');
  await expect(card.locator('.runway__table tbody tr:not(.runway__add)')).toHaveCount(2);
  await expect(card.locator('.runway__split')).toContainText('People $8,000');
  await expect(card.locator('.runway__split')).toContainText('Rent $2,000');
});
