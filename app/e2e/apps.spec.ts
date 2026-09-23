import { expect, test, type Page } from '@playwright/test';

const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const handle = (page: Page, id: string, side: string) => node(page, id).locator(`.react-flow__handle[data-handleid="${side}"]`);
const centre = (box: { x: number; y: number; width: number; height: number }) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps = 12) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.up();
}

// Journeys share one workspace and the stage journeys run after this one, so this one brings its own person (a
// fresh conversation, nothing left in Dev's) and puts the four seed cards back when it is done.
const PERSON = 'apps-person';
async function seed(page: Page, withPerson: boolean) {
  const stage = await (await page.request.get('/api/stage')).json();
  const keep = new Set(['marketing', 'build', 'brand-doc', 'company-brief']);
  const rooms = stage.rooms.filter((room: { id: string }) => keep.has(room.id)).map((room: object) => ({ ...room, model: undefined }));
  const build = rooms.find((room: { id: string }) => room.id === 'build');
  await page.request.put('/api/stage', { data: {
    rooms: withPerson ? [...rooms, { ...build, id: PERSON, name: 'Ava', role: 'Growth', x: build.x, y: build.y + build.h + 60 }] : rooms,
    docs: stage.docs.filter((doc: { id: string }) => keep.has(doc.id)), cards: [],
    wires: stage.wires.filter((wire: { id: string }) => wire.id === 'marketing-brand-doc'),
  } });
}

// Draws a wire between two cards: bring both ends into view, then try each side until a wire appears.
async function wire(page: Page, from: string, to: string) {
  const edges = page.locator('.react-flow__edge');
  const before = await edges.count();
  const inside = (box: { x: number; y: number } | null) => !!box && box.x > 30 && box.y > 30 && box.x < 1570 && box.y < 900;
  // Drag an empty piece of the canvas so that the point (x, y) moves toward the middle of the screen.
  const pan = async (x: number, y: number) => {
    const [dx, dy] = [Math.max(-700, Math.min(700, 800 - x)), Math.max(-400, Math.min(400, 450 - y))];
    const spots = [[dx > 0 ? 12 : 1588, dy > 0 ? 12 : 880], [dx > 0 ? 12 : 1588, 450], [800, dy > 0 ? 12 : 880]];
    const spot = await page.evaluate((list) => list.find(([px, py]) => document.elementFromPoint(px, py)?.classList.contains('react-flow__pane')) ?? null, spots);
    if (spot) await drag(page, { x: spot[0], y: spot[1] }, { x: spot[0] + dx, y: spot[1] + dy }, 8);
  };
  for (const side of ['l', 'r', 't', 'b']) {
    for (let tries = 0; tries < 10; tries += 1) {
      const [a, b] = [await handle(page, from, side).boundingBox(), await handle(page, to, side).boundingBox()];
      if (inside(a) && inside(b)) break;
      if (a && b && (Math.abs(a.x - b.x) > 1400 || Math.abs(a.y - b.y) > 800)) { await page.mouse.move(12, 12); await page.mouse.wheel(0, 400); } else if (a && b) await pan((a.x + b.x) / 2, (a.y + b.y) / 2);
      await page.waitForTimeout(250);
    }
    const [start, end] = [await handle(page, from, side).boundingBox(), await handle(page, to, side).boundingBox()];
    if (!inside(start) || !inside(end)) continue;
    await drag(page, centre(start!), centre(end!), 24);
    await page.waitForTimeout(250);
    if ((await edges.count()) > before) return;
  }
  throw new Error(`could not wire ${from} to ${to}`);
}

const send = async (page: Page, room: string, text: string) => {
  await expect(node(page, room).locator('.status--idle')).toBeVisible();
  await node(page, room).locator('.ask textarea').fill(text);
  await node(page, room).locator('.ask textarea').press('Enter');
};

// Adds an app from the dock's Apps group and returns the new card's id once the view has settled on it.
async function addApp(page: Page, name: string) {
  const cards = page.locator('.react-flow__node-browser');
  const before = await cards.count();
  await page.getByRole('button', { name: 'More cards' }).click();
  await page.getByRole('menuitem', { name, exact: true }).click();
  await expect(cards).toHaveCount(before + 1);
  await page.waitForTimeout(600);
  return (await cards.nth(before).getAttribute('data-id'))!;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await seed(page, true);
  await page.reload();
  await expect(node(page, PERSON)).toBeVisible();
});

test.afterEach(async ({ page }) => { await seed(page, false); });

test('an app card is a browser signed in as the founder', async ({ page }) => {
  const linkedin = await addApp(page, 'Add LinkedIn');
  const card = node(page, linkedin);
  await expect(card).toContainText('LinkedIn');
  await card.hover();
  await expect(card.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(card.locator('.browser__status')).toHaveText('Not signed in');
  await expect(card).toContainText('Press Sign in to sign in to LinkedIn in a real window, once.');

  // Sign in opens the window on the app itself, not on a blank page.
  // The window restarts the session; wait for that, or the address read below is the one from before it.
  const restarted = page.waitForResponse((response) => response.url().endsWith(`/api/browsers/${linkedin}/restart`));
  await card.getByRole('button', { name: 'Sign in' }).click();
  await restarted;
  await expect(card.getByRole('button', { name: 'Window shown' })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await (await page.request.get(`/api/browsers/${linkedin}`)).json()).url).toBe('https://www.linkedin.com/login');
  // Closing the window looks again: still not signed in, since nobody signed in.
  await card.getByRole('button', { name: 'Window shown' }).click();
  await expect(card.getByRole('button', { name: 'Sign in' })).toHaveAttribute('aria-pressed', 'false');
  await expect(card.locator('.browser__status')).toHaveText('Not signed in');

  // A wired person drives it by name; the receipt shows the step.
  await wire(page, PERSON, linkedin);
  await send(page, PERSON, '/tool browse {"action":"open","url":"https://www.linkedin.com/feed/","app":"LinkedIn"}');
  await expect(node(page, PERSON).locator('.chip--ok summary').last()).toHaveText('Browsed open https://www.linkedin.com/feed/');

  // A second app wired to the same person: an unnamed step is refused with both names.
  const x = await addApp(page, 'Add X');
  await expect(node(page, x)).toContainText('X');
  await wire(page, PERSON, x);
  await send(page, PERSON, '/tool browse {"action":"look"}');
  const failed = node(page, PERSON).locator('.chip--fail').last();
  await expect(failed.locator('summary')).toHaveText('Could not: browsing look');
  await failed.locator('summary').click();
  await expect(failed.locator('pre')).toContainText('Name the card in "app": LinkedIn, X');

  // Any site: a name and an address. A missing address is said plainly, under the form.
  await page.getByRole('button', { name: 'More cards' }).click();
  await page.getByRole('menuitem', { name: 'Add any app', exact: true }).click();
  await page.getByLabel('App name').fill('Notion');
  await page.getByRole('button', { name: 'Add app' }).click();
  await expect(page.locator('.dock__menu')).toContainText('An app needs a web address.');
  await page.getByLabel('App address').fill('notion.so');
  await page.getByRole('button', { name: 'Add app' }).click();
  await expect(page.locator('.react-flow__node-browser')).toHaveCount(3);
  await expect(page.locator('.react-flow__node-browser').nth(2)).toContainText('Notion');
  await expect(page.locator('.dock__menu')).toHaveCount(0);

  // It all comes back after a reload, and the plain browser in the menu is still the plain browser.
  await expect.poll(async () => (await (await page.request.get('/api/stage')).json()).cards?.length).toBe(3);
  await page.reload();
  await expect(node(page, linkedin)).toContainText('LinkedIn');
  await expect(node(page, linkedin).locator('.browser__status')).toHaveText('Not signed in');
  await expect(page.locator('.react-flow__node-browser').nth(2)).toContainText('Notion');
  expect((await (await page.request.get('/api/stage')).json()).cards[2].app).toEqual({ key: 'custom', name: 'Notion', home: 'https://notion.so/' });
});
