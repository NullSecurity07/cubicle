import { expect, test, type Page } from '@playwright/test';

// The board doing things on its own: a schedule the founder says in words, work that is a script and never troubles a
// model, and one task starting the next with what it found.
const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);

// A board on the stage, wired to Maya. Put there through the api: drawing wires is the stage journey's business.
async function boardWiredToMaya(page: Page) {
  type Card = { id: string; kind: string };
  type Wire = { id: string; from: string; to: string };
  const stage = await (await page.request.get('/api/stage')).json();
  const had = (stage.cards as Card[] | undefined)?.find((card) => card.kind === 'board');
  const id = had?.id ?? 'board-automation';
  await page.request.put('/api/stage', { data: {
    ...stage,
    cards: had ? stage.cards : [...(stage.cards ?? []), { kind: 'board', id, x: 980, y: 0, w: 780, h: 420 }],
    wires: (stage.wires as Wire[]).some((wire) => wire.to === id || wire.from === id)
      ? stage.wires : [...stage.wires, { id: `marketing-${id}`, from: 'marketing', fromHandle: 'r', to: id, toHandle: 'l' }],
  } });
  await page.reload();
  await expect(node(page, id)).toBeVisible();
  return id;
}

// A task in To do, opened. Everything the founder sets on it is set in the view that opens.
async function openTask(page: Page, boardId: string, title: string) {
  const board = node(page, boardId);
  await board.getByLabel('New task').fill(title);
  await board.getByLabel('New task').press('Enter');
  await board.getByRole('region', { name: 'To do' }).getByRole('button', { name: new RegExp(title) }).click();
  return board.getByRole('dialog', { name: title });
}

// What the people have spent so far. A script task must not add a line to it, so the count is read once it has stopped
// moving: the run before this one writes its own line after the founder already has the answer.
async function turnsSoFar(page: Page) {
  let last = -1;
  for (let at = 0; at < 20; at += 1) {
    const { turns } = (await (await page.request.get('/api/trace')).json()) as { turns: number };
    if (turns === last) return turns;
    last = turns;
    await page.waitForTimeout(400);
  }
  return last;
}

const broke: string[] = [];
test.beforeEach(async ({ page }) => {
  broke.length = 0;
  page.on('pageerror', (error) => broke.push(error.message));
  await page.goto('/');
  await expect(node(page, 'marketing')).toBeVisible();
});

// The stage is shared with every other journey, so this one leaves it as it found it.
test.afterEach(async ({ page }) => {
  await page.goto('about:blank');
  const stage = await (await page.request.get('/api/stage')).json();
  await page.request.put('/api/stage', { data: { ...stage, cards: [], wires: (stage.wires as { id: string }[]).filter((wire) => wire.id === 'marketing-brand-doc') } });
  expect(broke).toEqual([]);
});

test('a schedule is said in words, answered at once, and what it cannot read it says so', async ({ page }) => {
  const boardId = await boardWiredToMaya(page);
  const view = await openTask(page, boardId, 'Morning numbers');
  const field = view.getByLabel('When it runs');

  await field.fill('weekdays at 9');
  await expect(view.locator('.taskview__hint').first()).toContainText(/Next: \w{3},? \d{1,2}:\d{2}/);
  await expect(view.locator('.taskview__hint').first()).toContainText('only while the app is open');

  // Quicker than the free models can stand is not refused, it is slowed down, and the field says so.
  await field.fill('every 2m');
  await expect(view.locator('.taskview__hint').first()).toContainText('every 15 minutes');

  // Nonsense comes back as the words it could not place, with the shapes that do work.
  await field.fill('every blue moon');
  await expect(view.locator('.automation__problem')).toContainText('I did not understand "blue moon"');
  await expect(view.locator('.automation__problem')).toContainText('every day at 9am');
  await page.screenshot({ path: '.shots/automation-schedule.png' });

  // Kept when they leave the field, and read back on the card the same way.
  await field.fill('mondays at 14:30');
  await view.getByLabel('Task title').click();
  await expect(view.getByLabel('If one is missed')).toBeVisible();
  const tasks = (await (await page.request.get(`/api/boards/${boardId}`)).json()) as { repeat?: unknown; nextRun?: number }[];
  expect(tasks[0].repeat).toEqual({ every: 'week', time: '14:30', weekday: 1 });
  expect(tasks[0].nextRun).toBeGreaterThan(Date.now());
  await view.getByRole('button', { name: 'Close task' }).click();
  await expect(node(page, boardId).locator('.task__meta em').first()).toHaveText('↻ Mon 14:30');
});

test('a task that is a script runs by itself, and no model is ever asked', async ({ page }) => {
  const boardId = await boardWiredToMaya(page);
  const before = await turnsSoFar(page);
  const view = await openTask(page, boardId, 'Count the visitors');

  await view.getByLabel('How it is done').selectOption('script');
  await view.getByLabel('The script').fill("const visitors = ['ann', 'ben', 'cass'];\nconsole.log(visitors.length + ' visitors so far.');");
  await view.getByLabel('Task title').click();
  await expect(view.getByLabel('Written in')).toHaveValue('javascript');

  // Nobody is on it, and the Run button is there all the same: a script needs no one.
  await expect(view.getByLabel('Assignee')).toHaveValue('');
  await view.getByRole('button', { name: 'Run' }).click();
  await expect(view.locator('.taskview__result')).toContainText('3 visitors so far.', { timeout: 60_000 });
  await expect(view.locator('.taskview__log')).toContainText('the script finished');
  await page.screenshot({ path: '.shots/automation-script.png' });
  await view.getByRole('button', { name: 'Close task' }).click();
  await expect(node(page, boardId).getByRole('region', { name: 'Review' })).toContainText('Count the visitors');

  // Nothing was spent: the trace has not a line more in it than before the script ran.
  expect(await turnsSoFar(page)).toBe(before);
});

test('one task starts the next, and hands over what it found', async ({ page }) => {
  const boardId = await boardWiredToMaya(page);
  const board = node(page, boardId);
  const first = await openTask(page, boardId, 'Read the numbers');
  await first.getByLabel('Assignee').selectOption({ label: 'Maya' });
  await first.getByRole('button', { name: 'Close task' }).click();

  const second = await openTask(page, boardId, 'Write the note');
  await second.getByLabel('Assignee').selectOption({ label: 'Maya' });
  await second.getByLabel('Start it after').selectOption({ label: 'Read the numbers' });
  await expect(second).toContainText('It starts on its own when that task is done');
  await second.getByRole('button', { name: 'Close task' }).click();

  await expect(node(page, 'marketing').locator('.status--idle')).toBeVisible();
  await board.getByRole('region', { name: 'To do' }).getByRole('button', { name: /Read the numbers/ }).click();
  await first.getByRole('button', { name: 'Run' }).click();
  await expect(first.locator('.msg__foot')).toContainText('· done', { timeout: 60_000 });
  await first.getByRole('button', { name: 'Close task' }).click();

  // The second one was never pressed: it starts when the first is done, and says on its own card where it came from.
  await expect(board.getByRole('region', { name: 'Review' })).toContainText('Write the note', { timeout: 60_000 });
  await board.getByRole('region', { name: 'Review' }).getByRole('button', { name: /Write the note/ }).click();
  await expect(second.locator('.taskview__log')).toContainText('after "Read the numbers"');
  await expect(second.locator('.msg__foot')).toContainText('· done');
  await page.screenshot({ path: '.shots/automation-chain.png' });
  await second.getByRole('button', { name: 'Close task' }).click();
});
