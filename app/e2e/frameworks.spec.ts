import { expect, test, type Page } from '@playwright/test';

// The frameworks journey: the founder opens the panel, puts the built-in evaluation team on the stage in one press,
// asks the judge a question and is answered out of their own notes, then keeps two of the cards as a framework of
// their own. The stage is shared with every other journey, so this one puts it back exactly as it found it.
const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const panel = (page: Page) => page.getByRole('dialog', { name: 'Frameworks' });
const person = (page: Page, role: string) => page.locator('.react-flow__node-room').filter({ hasText: role });
const NOTE = 'Evaluating a Startup Idea — First-Time Founder Notes';
const MINE = 'pressure-team';

const broke: string[] = [];
let held: unknown = null;
test.beforeEach(async ({ page }) => {
  broke.length = 0;
  page.on('pageerror', (error) => broke.push(error.message));
  // The stage exactly as this journey found it: placing a team adds five people, a doc and two cards, and all of it
  // goes again afterwards.
  held = await (await page.request.get('/api/stage')).json();
  await page.goto('/');
  await expect(node(page, 'marketing')).toBeVisible();
});

test.afterEach(async ({ page }) => {
  await page.goto('about:blank');
  await page.request.put('/api/stage', { data: held });
  await page.request.delete(`/api/frameworks/${MINE}`);
  expect(broke).toEqual([]);
});

test('the built-in team lands on the stage, answers from the founder\'s note, and a selection becomes a framework', async ({ page }) => {
  // The dock's own way in, next to the cards.
  await page.getByLabel('Frameworks', { exact: true }).click();
  await expect(panel(page)).toContainText('Startup evaluation');
  await expect(panel(page)).toContainText('5 people · 1 doc · 1 browser · 1 note');
  // The note it was built from is in the library from the first start, so it is named rather than asked for.
  await expect(panel(page).getByText(`Built from ${NOTE}`)).toBeVisible();

  // One press, and the whole team is standing there: the five steps, the doc they share, the browser and the note.
  // Other teams ship beside it, so the press is on this one's own row.
  await panel(page).locator('.frameworks__one').filter({ hasText: 'Startup evaluation' }).getByRole('button', { name: 'Place' }).click();
  await expect(panel(page)).toBeHidden();
  for (const role of ['Assumption finder', 'Death hunter', 'Pain validator', 'Founder-fit', 'Verdict judge']) {
    await expect(person(page, role)).toHaveCount(1);
  }
  await expect(page.locator('.react-flow__node-doc').filter({ hasText: 'Evaluation' })).toHaveCount(1);
  await expect(page.locator('.react-flow__node-browser')).toHaveCount(1);
  await expect(page.locator('.react-flow__node-library')).toContainText(NOTE);
  // Sixteen wires of its own, on top of the one the seed stage came with.
  await expect(page.locator('.react-flow__edge')).toHaveCount(17);

  // The stage saves itself shortly after it changes, so the people are waited for rather than assumed.
  const rooms = async () => ((await (await page.request.get('/api/stage')).json()) as { rooms: { id: string; role: string }[] }).rooms;
  await expect.poll(async () => (await rooms()).some((room) => room.role === 'Verdict judge')).toBe(true);
  const judge = (await rooms()).find((room) => room.role === 'Verdict judge')!.id;

  // Fitting the whole team into the window, which is what a reload does: the judge stands at the far right of it.
  await page.reload();
  await expect(node(page, judge)).toBeVisible();
  await expect(node(page, judge).locator('.status--idle')).toBeVisible();
  await node(page, judge).locator('.ask textarea').fill('Which verdict, and how do I score the rubric out of 10?');
  await node(page, judge).locator('.ask textarea').press('Enter');
  await expect(node(page, judge).locator('.status--idle')).toBeVisible({ timeout: 20_000 });
  // The note reached the prompt: the passage of it that answers the question, under the name of the note.
  await expect(node(page, judge).locator('.msg--assistant').last()).toContainText(`Library: ${NOTE} —`);

  // Two cards chosen on the canvas are a group, and a group can be kept.
  await page.locator('.react-flow__node-library .card__header').click();
  await page.locator('.react-flow__node-browser .card__header').click({ modifiers: ['ControlOrMeta'] });
  const keep = page.getByRole('button', { name: 'Save 2 as framework' });
  await expect(keep).toBeVisible();
  await keep.click();
  await page.getByLabel('Framework name').fill('Pressure team');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved “Pressure team”')).toBeVisible();

  // And it is in the panel, beside the one that shipped with the app.
  await page.getByLabel('Frameworks', { exact: true }).click();
  await expect(panel(page)).toContainText('Pressure team');
  await expect(panel(page).getByText('1 browser · 1 note', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel(page)).toBeHidden();
});

test('the new teams are on the shelf, and the LinkedIn content system lands whole with the LinkedIn card, the leads and a board', async ({ page }) => {
  await page.getByLabel('Frameworks', { exact: true }).click();
  for (const name of ['LinkedIn content system', 'Weekly metrics', 'Customer discovery', 'Investor update', 'Product-market fit engine', 'Seed round prep', 'Pre-mortem']) {
    await expect(panel(page).locator('.frameworks__one').filter({ hasText: name })).toHaveCount(1);
  }
  const row = panel(page).locator('.frameworks__one').filter({ hasText: 'LinkedIn content system' });
  await expect(row).toContainText('5 people · 5 docs · 1 sticky note · 1 note · 1 browser · 1 lead list · 1 task board');
  await expect(row.getByText('Built from LinkedIn Founder-Led Content System — Notes v2')).toBeVisible();
  await row.getByRole('button', { name: 'Place' }).click();
  await expect(panel(page)).toBeHidden();

  for (const role of ['Buyer researcher', 'Post writer', 'Distributor', 'Scorekeeper', 'Outbound']) await expect(person(page, role)).toHaveCount(1);
  // A doc's title is the value of its title box, so the titles are read from there rather than from the words inside.
  const titles = async () => (await page.locator('.react-flow__node-doc').getByLabel('Doc title').evaluateAll((boxes) => boxes.map((box) => (box as HTMLInputElement).value)));
  await expect.poll(async () => (await titles()).filter((title) => ['ICP worksheet', 'Content calendar', 'Posts', 'Weekly scorecard', 'DM drafts'].includes(title)).sort())
    .toEqual(['Content calendar', 'DM drafts', 'ICP worksheet', 'Posts', 'Weekly scorecard']);
  await expect(page.locator('.react-flow__node-browser')).toHaveCount(1);
  await expect(page.locator('.react-flow__node-browser')).toContainText('LinkedIn');
  await expect(page.locator('.react-flow__node-leads')).toHaveCount(1);
  await expect(page.locator('.react-flow__node-board')).toHaveCount(1);
  await expect(page.locator('.react-flow__node-library')).toContainText('LinkedIn Founder-Led Content System — Notes v2');
  // Thirty wires of its own, on top of the one the seed stage came with.
  await expect(page.locator('.react-flow__edge')).toHaveCount(31);
  await expect.poll(async () => ((await (await page.request.get('/api/stage')).json()) as { rooms: { role: string }[] }).rooms.some((room) => room.role === 'Outbound')).toBe(true);
  await page.screenshot({ path: 'test-results/shots/linkedin-content-system.png' });
});
