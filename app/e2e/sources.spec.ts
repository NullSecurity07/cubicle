import { expect, test, type Page } from '@playwright/test';

const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);

// Journeys share one workspace, so this one brings its own person (a fresh conversation, so the last receipt is this
// journey's) and puts the four seed cards back when it is done, leaving the stage as it found it.
const PERSON = 'sources-person';
async function seed(page: Page, withPerson: boolean) {
  const stage = await (await page.request.get('/api/stage')).json();
  const keep = new Set(['marketing', 'build', 'brand-doc', 'company-brief']);
  const rooms = stage.rooms.filter((room: { id: string }) => keep.has(room.id)).map((room: object) => ({ ...room, model: undefined }));
  const build = rooms.find((room: { id: string }) => room.id === 'build');
  await page.request.put('/api/stage', { data: {
    rooms: withPerson ? [...rooms, { ...build, id: PERSON, name: 'Mia', role: 'Research', x: build.x, y: build.y + build.h + 60 }] : rooms,
    docs: stage.docs.filter((doc: { id: string }) => keep.has(doc.id)), cards: [],
    wires: stage.wires.filter((wire: { id: string }) => wire.id === 'marketing-brand-doc'),
  } });
}

// Browser, project, board, note, picture, link and source cards sit behind the dock's plus button.
async function addCard(page: Page, name: string) {
  await page.getByRole('button', { name: 'More cards' }).click();
  await page.getByRole('menuitem', { name, exact: true }).click();
}

const send = async (page: Page, room: string, text: string) => {
  await expect(node(page, room).locator('.status--idle')).toBeVisible();
  await node(page, room).locator('.ask textarea').fill(text);
  await node(page, room).locator('.ask textarea').press('Enter');
};

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await seed(page, true);
  await page.reload();
  await expect(node(page, PERSON)).toBeVisible();
});

test.afterEach(async ({ page }) => { await seed(page, false); });

test('a source website is searched by anyone when it fits, and people may propose one', async ({ page }) => {
  await addCard(page, 'Add source website');
  const card = page.locator('.react-flow__node-source');
  await card.getByLabel('Web address').fill('https://startups.rip/');
  await card.getByLabel('What people find here').fill('startup case studies');
  await card.getByLabel('Web address').press('Enter');
  // The fake runner's page title.
  await expect(card).toContainText('Example Domain');
  await expect.poll(async () => (await (await page.request.get('/api/stage')).json()).cards?.[0]?.about).toBe('startup case studies');

  // Nobody is wired to it; a person searches it anyway.
  await send(page, PERSON, '/tool search_source {"source":"startups.rip","queries":["why subscriptions die"]}');
  const searched = node(page, PERSON).locator('.chip--ok').last();
  await expect(searched.locator('summary')).toHaveText('Searched startups.rip: why subscriptions die');
  await searched.locator('summary').click();
  await expect(searched.locator('pre')).toContainText('https://startups.rip/a-page');

  // A person proposes another; the founder accepts it from Needs you and a card lands.
  await send(page, PERSON, '/tool propose_source {"url":"https://indiehackers.com/","about":"founder interviews","why":"they answer pricing questions"}');
  await expect(node(page, PERSON).locator('.chip--ok summary').last()).toHaveText('Proposed indiehackers.com');
  await page.getByRole('button', { name: /Needs you/ }).click();
  const row = page.locator('.needs li').filter({ hasText: 'indiehackers.com' });
  await expect(row).toContainText('suggests a website');
  await row.getByRole('button', { name: 'Accept' }).click();
  await expect(page.locator('.react-flow__node-source')).toHaveCount(2);
  const accepted = page.locator('.react-flow__node-source').nth(1);
  // Its name arrives on its own, without the founder typing anything.
  await expect(accepted.locator('.card__name')).toHaveText('Example Domain');
  await expect(accepted.getByLabel('What people find here')).toHaveValue('founder interviews');
  await expect(page.locator('.needs li').filter({ hasText: 'indiehackers.com' })).toHaveCount(0);

  // A second proposal, declined: it leaves Needs you and no card lands.
  await send(page, PERSON, '/tool propose_source {"url":"https://news.ycombinator.com/","about":"what founders argue about","why":"threads on pricing"}');
  await page.getByRole('button', { name: /Needs you/ }).click();
  const declined = page.locator('.needs li').filter({ hasText: 'news.ycombinator.com' });
  await declined.getByRole('button', { name: 'Decline' }).click();
  await expect(declined).toHaveCount(0);
  await expect(page.locator('.react-flow__node-source')).toHaveCount(2);

  await expect.poll(async () => (await (await page.request.get('/api/stage')).json()).cards?.length).toBe(2);
  await page.reload();
  await expect(page.locator('.react-flow__node-source')).toHaveCount(2);
  await expect(page.locator('.react-flow__node-source').nth(1).getByLabel('What people find here')).toHaveValue('founder interviews');
});
