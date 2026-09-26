import { expect, test, type Page } from '@playwright/test';

// The forge journey: the founder opens the frameworks panel, presses Forge, picks the note that shipped with the
// app, says what they want a team for, reads the proposal, renames somebody, builds it and places the team on their
// stage. The model is the stand-in one, so this is the whole road with no key to anything. The stage is shared with
// every other journey, so this one puts it back exactly as it found it.
const panel = (page: Page) => page.getByRole('dialog', { name: 'Frameworks' });
const person = (page: Page, role: string) => page.locator('.react-flow__node-room').filter({ hasText: role });
const NOTE = 'Evaluating a Startup Idea — First-Time Founder Notes';
const FORGED = 'forged-team';

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
  // Put back whole, whatever was saved since: no revision, so it is not refused as a save over a newer stage.
  await page.request.put('/api/stage', { data: { ...(held as object), rev: undefined } });
  for (const id of [FORGED, `${FORGED}-2`]) await page.request.delete(`/api/frameworks/${id}`);
  expect(broke).toEqual([]);
});

test('a team is forged from the founder\'s own note, scored, and placed on the stage', async ({ page }) => {
  await page.getByLabel('Frameworks', { exact: true }).click();
  await panel(page).getByRole('button', { name: 'Forge', exact: true }).click();

  // The notes the founder has, the line that says what this team is for, and what each mode will cost.
  await panel(page).locator('.forge__notes label', { hasText: NOTE }).click();
  await panel(page).getByLabel('What is this team for?').fill('a team that pressure-tests a startup idea');
  await expect(panel(page).getByRole('button', { name: /Quick/ })).toContainText('about 12 calls');
  await expect(panel(page).getByRole('button', { name: /Full/ })).toContainText('about 60 calls');
  await panel(page).getByRole('button', { name: /Quick/ }).click();
  await panel(page).getByRole('button', { name: 'Forge a team' }).click();

  // Read, Propose, and then the proposal itself, in the founder's hands.
  await expect(panel(page).locator('.forge__steps li', { hasText: 'Preview' })).toHaveClass(/is-now/, { timeout: 30_000 });
  const names = panel(page).getByLabel('Person name');
  await expect(names).toHaveCount(2);
  await expect(panel(page).locator('.forge__person textarea').first()).toContainText(/section/i);
  await expect(panel(page).locator('.forge__case')).toHaveCount(2);
  await names.first().fill('Nadia');

  // Built, tested and scored, with what it cost said in the open.
  await panel(page).getByRole('button', { name: 'Build' }).click();
  await expect(panel(page).locator('.forge__card')).toBeVisible({ timeout: 60_000 });
  await expect(panel(page).locator('.forge__card')).toContainText('Forged team');
  await expect(panel(page).locator('.forge__card li')).toHaveCount(2);
  await expect(panel(page).locator('.forge__spent')).toContainText('3 calls used');
  await expect(panel(page).locator('.forge__lines')).toContainText('Nadia');

  // And one press puts the team on the stage, where the founder can talk to them.
  await panel(page).getByRole('button', { name: 'Place' }).click();
  await expect(panel(page)).toBeHidden();
  await expect(person(page, 'Assumption finder')).toHaveCount(1);
  await expect(person(page, 'Verdict judge')).toHaveCount(1);
  await expect(person(page, 'Assumption finder')).toContainText('Nadia');
  await expect(page.locator('.react-flow__node-library').filter({ hasText: NOTE })).toHaveCount(1);

  // The stage really was saved with them on it, and the team is in the panel beside the built-in one.
  const rooms = async () => ((await (await page.request.get('/api/stage')).json()) as { rooms: { role: string }[] }).rooms;
  await expect.poll(async () => (await rooms()).some((room) => room.role === 'Verdict judge')).toBe(true);
  await page.getByLabel('Frameworks', { exact: true }).click();
  await expect(panel(page)).toContainText('Forged team');
  await expect(panel(page)).toContainText('2 people · 1 doc · 1 note');
  await page.keyboard.press('Escape');
  await expect(panel(page)).toBeHidden();
});
