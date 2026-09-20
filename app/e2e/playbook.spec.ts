import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// The playbook journey. It runs before the stage journeys (the files go in order), so the company starts out having
// learned nothing — the one state that cannot be arranged afterwards.
// The fake person names what it learns after the work it was given, so the names below are what the founder would see.
const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const panel = (page: Page) => page.getByRole('dialog', { name: 'Playbook' });
const rowFor = (page: Page, name: string) => panel(page).locator('.skill').filter({ hasText: name });

// A board on the stage, wired to Maya. Put there through the api rather than dragged: drawing wires is the stage
// journey's business, and this one is about what a person takes away from the work.
async function boardWiredToMaya(page: Page) {
  type Card = { id: string; kind: string };
  type Wire = { id: string; from: string; to: string };
  const stage = await (await page.request.get('/api/stage')).json();
  const had = (stage.cards as Card[] | undefined)?.find((card) => card.kind === 'board');
  const id = had?.id ?? 'board-playbook';
  await page.request.put('/api/stage', { data: {
    ...stage,
    cards: had ? stage.cards : [...(stage.cards ?? []), { kind: 'board', id, x: 980, y: 0, w: 720, h: 380 }],
    wires: (stage.wires as Wire[]).some((wire) => wire.to === id || wire.from === id)
      ? stage.wires : [...stage.wires, { id: `marketing-${id}`, from: 'marketing', fromHandle: 'r', to: id, toHandle: 'l' }],
  } });
  await page.reload();
  await expect(node(page, id)).toBeVisible();
  return id;
}

// Opens the command bar and runs the first thing it offers for what was typed.
async function bar(page: Page, typed: string) {
  await page.keyboard.press('Control+k');
  const box = page.getByRole('dialog', { name: 'Command bar' }).getByRole('combobox');
  await box.fill(typed);
  await expect(page.getByRole('dialog', { name: 'Command bar' }).getByRole('option').first()).toContainText(typed, { ignoreCase: true });
  await page.keyboard.press('Enter');
}

async function send(page: Page, room: string, text: string) {
  await expect(node(page, room).locator('.status--idle')).toBeVisible();
  await node(page, room).locator('.ask textarea').fill(text);
  await node(page, room).locator('.ask textarea').press('Enter');
  await expect(node(page, room).locator('.status--idle')).toBeVisible({ timeout: 20_000 });
  return node(page, room).locator('.msg--assistant').last();
}

// A task with the work written into it, given to Maya and run to the end.
async function runTask(page: Page, boardId: string, title: string, detail: string) {
  const board = node(page, boardId);
  await board.getByLabel('New task').fill(title);
  await board.getByLabel('New task').press('Enter');
  await board.getByRole('region', { name: 'To do' }).getByRole('button', { name: new RegExp(title) }).click();
  const view = board.getByRole('dialog', { name: title });
  await view.getByLabel('Task detail').fill(detail);
  await view.getByLabel('Task title').click();
  await view.getByLabel('Assignee').selectOption({ label: 'Maya' });
  await expect(node(page, 'marketing').locator('.status--idle')).toBeVisible();
  await view.getByRole('button', { name: 'Run' }).click();
  await expect(view.locator('.msg__foot')).toContainText('· done', { timeout: 30_000 });
  return view;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(node(page, 'marketing')).toBeVisible();
});

// The stage, the playbook and the page about the founder are shared with every other journey, so this one leaves all
// three as it found them. The window goes first, or its own last save would put the board back after the tidying up.
test.afterEach(async ({ page }) => {
  await page.goto('about:blank');
  const stage = await (await page.request.get('/api/stage')).json();
  await page.request.put('/api/stage', { data: { ...stage, cards: [], wires: (stage.wires as { id: string }[]).filter((wire) => wire.id === 'marketing-brand-doc') } });
  for (const skill of (await (await page.request.get('/api/skills')).json()) as { id: string }[]) await page.request.delete(`/api/skills/${skill.id}`);
  await page.request.put('/api/founder', { data: { text: '' } });
});

test('the playbook starts with nothing in it and nothing to set up, and the page about the founder is theirs', async ({ page }) => {
  await bar(page, 'playbook');
  await expect(panel(page)).toContainText('Nothing here yet, and nothing to set up.');
  await expect(panel(page).getByLabel('About you')).toHaveValue('');
  await expect(panel(page)).toContainText('0 of 1,200 characters');
  await page.screenshot({ path: '.shots/playbook-empty.png' });

  const about = 'Mornings are for building. Say it in plain words, and say what you are unsure about.';
  await panel(page).getByLabel('About you').fill(about);
  await expect(panel(page)).toContainText(`${about.length} of 1,200 characters`);
  await panel(page).getByRole('button', { name: 'Save' }).click();
  await expect(panel(page).getByRole('button', { name: 'Save' })).toHaveCount(0);
  expect((await (await page.request.get('/api/founder')).json()).text).toBe(about);

  // Over the cap it says so and will not save, rather than quietly cutting the end off.
  await panel(page).getByLabel('About you').fill('x'.repeat(1300));
  await expect(panel(page)).toContainText('100 characters more than fits');
  await expect(panel(page).getByRole('button', { name: 'Save' })).toBeDisabled();
  await panel(page).getByLabel('About you').fill(about);
  await page.keyboard.press('Escape');
  await expect(panel(page)).toBeHidden();
});

test('a person learns from a task they finished, the founder reads it, and the next turn is answered with it', async ({ page }) => {
  // A board, wired to Maya, and a task with three steps of real work in it.
  const boardId = await boardWiredToMaya(page);
  const view = await runTask(page, boardId, 'Write the launch FAQ', [
    '/tool remember {"fact":"The launch FAQ answers ten questions."}',
    '/tool recall {"query":"what the launch FAQ should cover"}',
    '/tool list_files {}',
  ].join('\n'));
  // Three calls that got somewhere is real effort, so Maya writes down how it is done and says so in the run's log.
  await expect(view.locator('.taskview__log')).toContainText('learned: "How to Write the launch FAQ"', { timeout: 30_000 });
  await view.getByRole('button', { name: 'Close task' }).click();

  // The founder opens the playbook from Maya's own card and reads what she learned.
  const maya = node(page, 'marketing');
  await maya.locator('.card__header').hover();
  await maya.getByRole('button', { name: 'Playbook' }).click();
  const skill = rowFor(page, 'How to Write the launch FAQ');
  await expect(skill).toContainText('Maya learned this');
  await expect(skill).toContainText('not used yet');
  // Opened from her card it is still the one company playbook; what she learned is only marked.
  await expect(panel(page)).toContainText("Maya's are marked");
  await expect(skill).toHaveClass(/is-theirs/);
  // Everything in a row can be reached from the keyboard: the buttons show themselves the moment one of them has it.
  await skill.getByRole('button', { name: /How to Write the launch FAQ/ }).focus();
  await page.keyboard.press('Tab');
  await expect(skill.getByRole('button', { name: 'Edit' })).toBeFocused();
  await expect(skill.locator('.skill__acts')).toHaveCSS('opacity', '1');

  await skill.getByRole('button', { name: /How to Write the launch FAQ/ }).click();
  await expect(skill).toContainText('When the founder asks for Write the launch FAQ');
  await expect(skill).toContainText('Read what is wired to you');
  await page.screenshot({ path: '.shots/playbook-one-skill-open.png' });
  await page.keyboard.press('Escape');

  // The next time the same kind of work comes round, it is in front of her before she starts.
  await expect(await send(page, 'marketing', 'how should I write the launch FAQ this time')).toContainText('Playbook: How to Write the launch FAQ.');

  // Switched off, nobody is shown it.
  await maya.locator('.card__header').hover();
  await maya.getByRole('button', { name: 'Playbook' }).click();
  // The switch is the playbook's, not the page's: it flips when the server has really put it away.
  await panel(page).getByLabel('Use "How to Write the launch FAQ"').click();
  await expect(panel(page).getByLabel('Use "How to Write the launch FAQ"')).not.toBeChecked();
  await expect.poll(async () => ((await (await page.request.get('/api/skills')).json()) as { name: string; state: string }[]).find((one) => one.name === 'How to Write the launch FAQ')?.state).toBe('off');
  await page.keyboard.press('Escape');
  await expect(await send(page, 'marketing', 'and the launch FAQ again please')).not.toContainText('Playbook:');

  // Edited by hand, and put back with one press.
  await bar(page, 'playbook');
  await panel(page).getByLabel('Use "How to Write the launch FAQ"').click();
  await expect(panel(page).getByLabel('Use "How to Write the launch FAQ"')).toBeChecked();
  await skill.getByRole('button', { name: 'Edit' }).click();
  await skill.getByLabel('Done when').fill('The founder has read it and has no more questions.');
  await skill.getByRole('button', { name: 'Save' }).click();
  await expect(skill).toContainText('The founder has read it and has no more questions.');
  await skill.getByRole('button', { name: 'Undo last change' }).click();
  await expect(skill).toContainText('The founder can see Write the launch FAQ without asking.');
  await expect(skill).not.toContainText('no more questions');
  await page.keyboard.press('Escape');
});

test('a finished task can be learned from on purpose, and says in one line what came of it', async ({ page }) => {
  const boardId = await boardWiredToMaya(page);
  const view = await runTask(page, boardId, 'Pick the webinar date', '/tool remember {"fact":"The webinar is in the second week."}');
  // One call is not effort, so nothing was learned by itself: this is the founder asking for it.
  await expect(view.locator('.taskview__log')).not.toContainText('learned:');
  await view.getByRole('button', { name: 'Learn this' }).click();
  await expect(view.locator('.taskview__learn span')).toHaveText('Learned: "How to Pick the webinar date".', { timeout: 30_000 });
  await page.screenshot({ path: '.shots/playbook-board-learn-this.png' });

  // Asked again about the same work, there is nothing left to take away from it.
  await view.getByRole('button', { name: 'Learn this' }).click();
  await expect(view.locator('.taskview__learn span')).toHaveText('Nothing new here worth keeping.', { timeout: 30_000 });
  await view.getByRole('button', { name: 'Close task' }).click();
});

test('what a person learns in a conversation says so once, quietly, where it happened', async ({ page }) => {
  await send(page, 'marketing', 'write me three taglines');
  // The founder putting somebody right is the other thing worth learning from.
  await send(page, 'marketing', 'no, plain words only and never any hype');
  const line = node(page, 'marketing').locator('.msg--learned');
  await expect(line).toBeVisible({ timeout: 30_000 });
  await expect(line).toHaveText(/^(learned|improved): ".+"$/);
  await page.screenshot({ path: '.shots/playbook-chat-learned-line.png' });

  // The line is the way in: it opens the playbook on what was just learned.
  const name = (await line.innerText()).replace(/^\w+: "/, '').replace(/"$/, '');
  await line.click();
  await expect(rowFor(page, name).first()).toContainText('Maya learned this');
  await page.keyboard.press('Escape');

  // It was never a message: nothing of it is in the conversation the server keeps.
  const chat = await (await page.request.get('/api/rooms/marketing/chat')).json();
  expect(JSON.stringify(chat)).not.toContain('learned: "');
});

test('the playbook holds a shelf full of skills, one of them as long as a skill may be', async ({ page }) => {
  const folder = join(process.env.STAGE_WORKSPACE!, 'skills');
  await mkdir(folder, { recursive: true });
  const fill = (start: string, said: string) => `${start} ${said.repeat(3)}`.slice(0, 95).trim();
  const longest = {
    name: 'How to answer a customer who has waited more than a day',
    when: 'When somebody has been waiting since yesterday and nobody has written back to them yet',
    procedure: Array.from({ length: 8 }, (_, at) => fill(`Step ${at + 1}:`, 'say what changed and where the founder can see it, ')),
    pitfalls: Array.from({ length: 5 }, (_, at) => fill(`Watch out ${at + 1}:`, 'never call it done before a tool has said so, ')),
    verify: fill('Done when:', 'the founder can see it without asking anybody, '),
  };
  const size = [longest.name, longest.when, ...longest.procedure, ...longest.pitfalls, longest.verify].join('\n').length;
  expect(size).toBeGreaterThan(1300);
  expect(size).toBeLessThan(1500);

  for (let at = 0; at < 12; at += 1) {
    await writeFile(join(folder, `seeded-${at}.json`), JSON.stringify({
      ...(at === 0 ? longest : {
        name: `How to run the week ${at} review`, when: `When the week ${at} review comes round and the numbers are not written down yet`,
        procedure: ['Read what is wired to you before you start', 'Do the work with your tools, one call at a time', 'Say in a line what changed'],
        pitfalls: ['Never say it is done unless a tool said so'], verify: 'The founder can see the review without asking.',
      }),
      state: at === 11 ? 'stale' : at === 10 ? 'off' : 'active',
      by: { roomId: at % 2 ? 'build' : 'marketing', name: at % 2 ? 'Dev' : 'Maya' },
      source: { kind: 'run', ref: 'seeded' }, uses: at, patches: 0, createdAt: Date.now() - at * 60_000, history: [],
    }, null, 2));
  }
  await page.reload();
  await expect(node(page, 'marketing')).toBeVisible();
  await bar(page, 'playbook');

  const held = (await (await page.request.get('/api/skills')).json()) as { state: string }[];
  await expect(panel(page).locator('.skill')).toHaveCount(held.length);
  // What nobody has reached for lately is folded away, in words that say what that means.
  const folded = panel(page).getByRole('group');
  await expect(folded).toContainText(`Not used lately (${held.filter((one) => one.state === 'stale').length})`);
  await expect(rowFor(page, 'How to answer a customer who has waited more than a day')).toBeVisible();
  await page.screenshot({ path: '.shots/playbook-many.png' });

  // The longest a skill may be still reads as one row, and opens without pushing anything else off the panel.
  await rowFor(page, 'How to answer a customer').getByRole('button', { name: /How to answer a customer/ }).click();
  await expect(rowFor(page, 'How to answer a customer').getByRole('listitem')).toHaveCount(13);
  await page.keyboard.press('Escape');
});
