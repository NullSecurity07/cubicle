import { expect, test, type Page } from '@playwright/test';
import type { Framework } from '../shared/frameworks';

// The evals journey: the founder scores the team that shipped with the app against their own test cases, places it,
// and reads on one person's own panel what that person was written from and what they were worth. Then the other
// half, on a small team of their own: they edit a brief, the run that follows is refused because a case went
// backwards, they read which one and by how much, and they take it anyway. The model is the stand-in one, so this is
// the whole road with no key to anything. The stage is shared with every other journey, so this one puts it back
// exactly as it found it.
const panel = (page: Page) => page.getByRole('dialog', { name: 'Frameworks' });
const team = (page: Page, name: string) => panel(page).locator('.frameworks__one').filter({ hasText: name });
const person = (page: Page, role: string) => page.locator('.react-flow__node-room').filter({ hasText: role });
const NOTE = 'Evaluating a Startup Idea — First-Time Founder Notes';
const MINE = 'evals-check';

// A team of the founder's own, two people and one case each: small enough that a whole run is a moment, and built so
// that one brief can be made worse on purpose.
const small: Framework = {
  id: MINE, name: 'Evals check', intent: 'a team small enough to score twice', version: 1, builtAt: 1,
  notes: [{ id: 'evaluating-a-startup-idea-first-time-founder-notes', hash: 'built-from-this' }],
  rooms: [
    { key: 'finder', name: 'Ada', role: 'Check assumption finder', accent: '#ee8a72', brief: 'Name the one belief the idea rests on, as a sentence that could be shown to be false.', w: 380, h: 440 },
    { key: 'judge', name: 'Bruno', role: 'Check verdict judge', accent: '#b58cff', brief: 'Read what the finder said and give one verdict.', w: 380, h: 440 },
  ],
  docs: [{ key: 'working', title: 'Check notes', text: '# Check notes\n' }],
  cards: [], wires: [{ from: 'finder', to: 'working' }, { from: 'judge', to: 'finder' }],
  layout: { finder: { x: 0, y: 0 }, judge: { x: 460, y: 0 }, working: { x: 0, y: 520 } },
  dataset: [
    { id: 'spare-room', keys: ['finder'], input: 'Idea: people rent out a spare room to travellers. Name the core assumption.', rubric: 'One falsifiable sentence, not a hope.', addedBy: 'founder' },
    { id: 'spare-room-verdict', keys: ['judge'], input: 'The assumption holds, the flaws are survivable and the pain is real. Verdict?', expected: 'STRONG', addedBy: 'founder' },
  ],
};

const broke: string[] = [];
let held: unknown = null;
test.beforeEach(async ({ page }) => {
  broke.length = 0;
  page.on('pageerror', (error) => broke.push(error.message));
  held = await (await page.request.get('/api/stage')).json();
  await page.goto('/');
  await expect(page.locator('.react-flow__node[data-id="marketing"]')).toBeVisible();
});

test.afterEach(async ({ page }) => {
  await page.goto('about:blank');
  await page.request.put('/api/stage', { data: held });
  await page.request.delete(`/api/frameworks/${MINE}`);
  expect(broke).toEqual([]);
});

test('the built-in team is scored against the founder\'s own cases, and every person carries what they scored', async ({ page }) => {
  // Every one of the founder's cases is a whole turn of a whole person, so this journey is the slow one.
  test.setTimeout(240_000);
  await page.getByLabel('Frameworks', { exact: true }).click();
  const built = team(page, 'Startup evaluation');
  await expect(built).toBeVisible();

  // Nothing has been run yet, so there is no score to wear.
  await expect(built.locator('.score')).toHaveCount(0);
  await built.getByRole('button', { name: 'Runs' }).click();
  await expect(built).toContainText('Nothing has been run yet');

  // One press, and the team answers every one of the founder's cases, out loud, line by line.
  await built.getByRole('button', { name: 'Rerun evals' }).click();
  await expect(built.locator('.forge__lines')).toBeVisible();
  await expect(built.locator('.forge__lines')).toContainText('Ananya', { timeout: 60_000 });
  await expect(built.locator('.runs__one')).toHaveCount(1, { timeout: 200_000 });
  await expect(built.locator('.runs__one')).toContainText('promoted');
  await expect(built.locator('.runs__head')).toContainText('version 2');

  // The score is on the framework now, and it is not amber: the note is the one it was built from and the model
  // that scored it is the one still set up here.
  // Fifteen, not fourteen: one of the founder's cases names two people, and both of them answered it.
  await expect(built.locator('.score')).toContainText('15 tests');
  expect(await built.locator('.score').getAttribute('data-stale')).toBe(null);

  // Placed, and then one of the five is asked to fill the window.
  await built.getByRole('button', { name: 'Place' }).click();
  await expect(panel(page)).toBeHidden();
  const judge = person(page, 'Verdict judge');
  await expect(judge).toHaveCount(1);
  await judge.locator('.card__header').hover();
  await judge.getByRole('button', { name: 'Focus' }).click();

  // Their own panel says where they came from and what they were worth, on their own four cases rather than on
  // everything the framework was asked.
  const side = page.locator('.focus__sheet .side');
  await expect(side).toBeVisible();
  await expect(side.locator('.side__from')).toContainText(`Built from “${NOTE}”`);
  await expect(side.locator('.side__from')).toContainText('on 4 tests');
  await page.keyboard.press('Escape');
});

test('a brief that made a person worse is refused, read and then taken anyway', async ({ page }) => {
  test.setTimeout(180_000);
  await page.request.put(`/api/frameworks/${MINE}`, { data: small });
  await page.getByLabel('Frameworks', { exact: true }).click();
  const mine = team(page, 'Evals check');
  await expect(mine).toBeVisible();

  // A first run has nothing to be worse than, so it becomes the framework's word on itself.
  await mine.getByRole('button', { name: 'Rerun evals' }).click();
  await expect(mine.locator('.runs__one')).toHaveCount(1, { timeout: 120_000 });
  await expect(mine.locator('.runs__one').first()).toContainText('promoted');
  await expect(mine.locator('.runs__head')).toContainText('version 2');
  const was = await mine.locator('.score').textContent();

  // Now the founder rewrites a brief, and the rewrite is a bad one: it promises a word in the answer that the person
  // will never say, which the check that needs no model sees at once.
  await mine.getByRole('button', { name: 'Briefs' }).click();
  const brief = mine.getByLabel('Brief for Ada');
  await brief.fill(`${await brief.inputValue()} Answer with "ZORBLAX" and nothing else.`);
  await mine.getByRole('button', { name: 'Save and score' }).click();

  // The run is kept and refused, and the panel says which case fell and from what to what.
  await expect(mine.locator('.runs__one')).toHaveCount(2, { timeout: 120_000 });
  const refused = mine.locator('.runs__one').first();
  await expect(refused).toHaveClass(/is-rejected/);
  await expect(refused).toContainText('kept, not promoted');
  await expect(refused.locator('.runs__why li')).toContainText('spare-room');
  await expect(refused.locator('.runs__why li b')).toContainText('→');
  // And the framework still wears what the promoted run gave it.
  await expect(mine.locator('.score')).toHaveText(was ?? '');

  // The founder overrules the rule, and the framework moves on — with the run still saying, for good, that they did.
  await refused.getByRole('button', { name: 'Promote anyway' }).click();
  await expect(mine.locator('.runs__head')).toContainText('version 3', { timeout: 30_000 });
  await expect(refused).toContainText('promoted by hand');
  await expect(refused.getByRole('button', { name: 'Promote anyway' })).toHaveCount(0);
  await expect(mine.locator('.score')).not.toHaveText(was ?? '');

  await page.keyboard.press('Escape');
  await expect(panel(page)).toBeHidden();
});
