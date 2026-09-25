import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// Today's five, the follow-up nudge and the monthly update, in fake mode. A lead who replied four days ago and a
// Metrics card with no entry for twenty days are written straight into the workspace before their cards go on the
// stage, the way the stores themselves write them. The dashboard opens on Today's five with both; one is put away
// for the day and stays gone. The nudge is a quiet mark on the lead and a Needs you row whose button has Maya draft
// the reply. Then Maya gathers the month and the receipt shows what she read. Everything is taken away afterwards.
const WORKSPACE = process.env.STAGE_WORKSPACE!;
const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const DAY = 86_400_000;
const pad = (value: number) => String(value).padStart(2, '0');
const dayOf = (at: number) => { const day = new Date(at); return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`; };
const run = Date.now().toString(36);
const LEADS = `today-leads-${run}`;
const METRICS = `today-metrics-${run}`;
const BOARD = `today-board-${run}`;

async function send(page: Page, room: string, text: string) {
  await expect(node(page, room).locator('.status--idle')).toBeVisible();
  await node(page, room).locator('.ask textarea').fill(text);
  await node(page, room).locator('.ask textarea').press('Enter');
  await expect(node(page, room).locator('.status--idle')).toBeVisible({ timeout: 20_000 });
  return node(page, room).locator('.msg--assistant').last();
}
async function openDashboard(page: Page) {
  const dash = page.getByRole('dialog', { name: 'Dashboard' });
  await expect(async () => {
    if (!await dash.isVisible()) await page.keyboard.press('Control+d');
    await expect(dash).toBeVisible({ timeout: 1_500 });
  }).toPass({ timeout: 15_000 });
  return dash;
}

const broke: string[] = [];
test.beforeEach(async ({ page }) => {
  // A cold dev server can reload the page once while it optimises; three stops follow in one journey.
  test.setTimeout(120_000);
  broke.length = 0;
  page.on('pageerror', (error) => broke.push(error.message));
  const now = Date.now();
  await mkdir(join(WORKSPACE, 'leads'), { recursive: true });
  await writeFile(join(WORKSPACE, 'leads', `${LEADS}.json`), JSON.stringify([
    { id: 'lead-ana', person: { name: 'Ana' }, company: { name: 'Acme' }, stage: 'replied', notes: [{ at: now - 9 * DAY, by: 'Founder', text: 'Met at the meetup' }], source: 'founder', addedAt: now - 10 * DAY, updatedAt: now - 4 * DAY - 3_600_000 },
  ]));
  await mkdir(join(WORKSPACE, 'metrics'), { recursive: true });
  await writeFile(join(WORKSPACE, 'metrics', `${METRICS}.json`), JSON.stringify({ updatedAt: now, metrics: [
    { key: 'mrr', label: 'MRR', unit: '$', better: 'up', northStar: true, points: [{ at: dayOf(now - 50 * DAY), value: 2800, from: 'founder' }, { at: dayOf(now - 20 * DAY), value: 3100, from: 'founder' }] },
  ] }));
  const stage = await (await page.request.get('/api/stage')).json();
  await page.request.put('/api/stage', { data: {
    ...stage,
    cards: [...(stage.cards ?? []), { kind: 'leads', id: LEADS, x: 980, y: 0, w: 760, h: 380 }, { kind: 'metrics', id: METRICS, x: 980, y: 440, w: 420, h: 360 }, { kind: 'board', id: BOARD, x: 1440, y: 440, w: 820, h: 360 }],
    wires: [...stage.wires,
      { id: `marketing-${LEADS}`, from: 'marketing', fromHandle: 'r', to: LEADS, toHandle: 'l' },
      { id: `marketing-${METRICS}`, from: 'marketing', fromHandle: 'r', to: METRICS, toHandle: 'l' },
      { id: `marketing-${BOARD}`, from: 'marketing', fromHandle: 'r', to: BOARD, toHandle: 'l' }],
  } });
  await page.goto('/');
  await expect(node(page, LEADS)).toBeVisible({ timeout: 30_000 });
});

test.afterEach(async ({ page }) => {
  await page.goto('about:blank');
  const stage = await (await page.request.get('/api/stage')).json();
  await page.request.put('/api/stage', { data: { ...stage, cards: [], wires: (stage.wires as { id: string }[]).filter((wire) => wire.id === 'marketing-brand-doc') } });
  const chat = (await (await page.request.get('/api/rooms/marketing/chat')).json()) as { id: string; text: string }[];
  const from = chat.findIndex((message) => message.text.startsWith('Ana at Acme replied'));
  if (from >= 0) for (const message of chat.slice(from)) await page.request.delete(`/api/rooms/marketing/chat/${message.id}`);
  for (const path of [join('leads', `${LEADS}.json`), join('metrics', `${METRICS}.json`), 'today.json', join('nudges', 'leads.json'), join('boards', `${BOARD}.json`)]) await rm(join(WORKSPACE, path), { force: true });
  expect(broke).toEqual([]);
});

test('the day opens on five ranked things, a quiet lead is nudged, and a person gathers the month', async ({ page }) => {
  const LEAD_LINE = 'Ana at Acme replied 4 days ago. Draft a reply?';
  const METRIC_LINE = /^No entry for MRR in 20 days/;

  // The nudge is a quiet mark on the lead itself.
  await expect(node(page, LEADS).locator('.lead', { hasText: 'Ana' }).locator('.lead__chase')).toBeVisible({ timeout: 15_000 });
  await expect(node(page, LEADS).locator('.lead__chase')).toHaveAttribute('aria-label', 'Waiting for your reply');

  const dash = await openDashboard(page);
  const five = dash.getByRole('list', { name: 'Today\'s five' });
  await expect(five.getByRole('button', { name: LEAD_LINE, exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(five.getByRole('button', { name: METRIC_LINE })).toBeVisible();
  // The lead waited a day past its three, so it ranks above the number, and says why on hover.
  const rows = five.locator('.today__row');
  const names = await rows.evaluateAll((all) => all.map((one) => one.getAttribute('aria-label')));
  expect(names.indexOf(LEAD_LINE)).toBeLessThan(names.findIndex((name) => /No entry for MRR/.test(name ?? '')));
  await expect(five.getByRole('button', { name: LEAD_LINE, exact: true })).toHaveAttribute('title', /"A lead is waiting on you" weighs 75, plus 5 for waiting 1 day\. A fixed table ranks these; no model picks them\./);
  await page.screenshot({ path: 'test-results/shots/today-five.png' });

  // Put away for today: gone at once, and still gone when read again.
  await five.getByRole('button', { name: METRIC_LINE }).hover();
  await five.getByRole('button', { name: /^Not today: No entry for MRR/ }).click();
  await expect(five.getByRole('button', { name: METRIC_LINE })).toHaveCount(0);
  await expect(five.getByRole('button', { name: LEAD_LINE, exact: true })).toBeVisible();
  const again = (await (await page.request.get('/api/today')).json()) as { items: { title: string }[] };
  expect(again.items.map((one) => one.title)).toContain(LEAD_LINE);
  expect(again.items.some((one) => /No entry for MRR/.test(one.title))).toBe(false);
  await page.keyboard.press('Escape');
  await expect(dash).toBeHidden();

  // Needs you: the nudge, with Maya to draft the reply.
  await page.getByRole('button', { name: /^Needs you: \d+ waiting$/ }).click();
  const need = page.locator('.needs__item--lead-stale');
  await expect(need).toContainText('A lead to follow up');
  await expect(need).toContainText(LEAD_LINE);
  await expect(need).toContainText('Nothing written on this lead for 4 days.');
  await page.getByRole('dialog', { name: 'Needs you' }).screenshot({ path: 'test-results/shots/today-needs-you.png' });
  await need.getByRole('button', { name: 'Draft a reply' }).click();
  const focused = page.locator('.card--focused');
  await expect(focused.locator('.msg--user').last()).toContainText('Ana at Acme replied 4 days ago and is still waiting for an answer. Read their notes on the Leads card, then draft a reply using the evidence-outreach skill.');
  await expect(focused.locator('.status--idle')).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press('Escape');

  // The monthly update's one tool, through Maya: dated lines, each naming its card.
  // Three days back, so the lead (added ten days ago) and the last MRR reading (twenty) both fall before it, whatever the date.
  const since = dayOf(Date.now() - 3 * DAY);
  const gathered = await send(page, 'marketing', `/tool gather_month {"since":"${since}"}`);
  await expect(gathered.locator('.chip--ok summary')).toHaveText('Gathered the month');
  await gathered.locator('.chip summary').click();
  const receipt = gathered.locator('.chip pre');
  await expect(receipt).toContainText(`What changed from ${since} to ${dayOf(Date.now())}.`);
  await expect(receipt).toContainText('Leads [Leads]: 0 added, 0 stage moves. Now: 1 Replied.');
  await expect(receipt).toContainText('Numbers [Metrics]:');
  await expect(receipt).toContainText(`MRR (north star): no reading since ${since}; the last was $3,100 on ${dayOf(Date.now() - 20 * DAY)}`);
  await expect(receipt).toContainText('Tasks done [Board]:\n- none');
  await expect(receipt).toContainText('Not wired to you: Runway.');
  await page.screenshot({ path: 'test-results/shots/today-gather-month.png' });

  // The board template: one command puts the monthly task on the board, given to Maya, repeating monthly.
  const bar = page.getByRole('dialog', { name: 'Command bar' });
  await expect(async () => {
    if (!(await bar.isVisible())) await page.keyboard.press('Control+k');
    await expect(bar.getByRole('combobox')).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 15_000 });
  await bar.getByRole('combobox').fill('monthly update');
  await bar.getByRole('option', { name: /Add the monthly investor update/ }).click();
  const notice = page.getByRole('status').filter({ hasText: 'is on your board' });
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(/"Draft the \w+ update" is on your board\. It runs on the first weekday of each month at 09:00\./);
  const task = node(page, BOARD).getByText(/^Draft the \w+ update$/);
  await expect(task).toBeVisible();
  await expect(node(page, BOARD)).toContainText('first weekday of the month 09:00');
  await page.screenshot({ path: 'test-results/shots/today-monthly-task.png' });
});
