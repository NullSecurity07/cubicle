import { expect, test, type Page } from '@playwright/test';

// The founder writes to a person from their phone and the canvas is already open. Everything they would have seen
// had they typed it here — their own words, the person going to work, the reply being written, the finished
// message — has to arrive on the card without anybody reloading anything.
const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);

// Exactly what the phone bridge does: a message posted to the app's own chat route, from outside this window.
// Not awaited by the caller — the route holds the request open for the whole turn, and the point is what the card
// does while it is still running.
const fromOutside = (page: Page, room: string, text: string, via?: string) =>
  page.request.post(`/api/rooms/${room}/chat`, { data: { text, ...(via ? { via } : {}) } });

const broke: string[] = [];
test.beforeEach(async ({ page }) => {
  broke.length = 0;
  page.on('pageerror', (error) => broke.push(error.message));
  // The cards' feed has to be listening before anything is sent from outside. A window that opens mid-turn catches
  // up at the end of it, which is right but is not what is being checked here.
  const listening = page.waitForResponse((response) => response.url().includes('/api/rooms/events'));
  await page.goto('/');
  await expect(node(page, 'marketing')).toBeVisible();
  await listening;
});

// Every journey shares one workspace: this one leaves both conversations and the seed wires as it found them.
test.afterEach(async ({ page }) => {
  const stage = await (await page.request.get('/api/stage')).json();
  await page.request.put('/api/stage', { data: { ...stage, cards: [], wires: (stage.wires as { id: string }[]).filter((wire) => wire.id === 'marketing-brand-doc') } });
  for (const room of ['marketing', 'build']) {
    for (const message of (await (await page.request.get(`/api/rooms/${room}/chat`)).json()) as { id: string }[]) await page.request.delete(`/api/rooms/${room}/chat/${message.id}`);
  }
  expect(broke).toEqual([]);
});

test('a message sent from the phone appears, is answered live, and is drawn exactly once', async ({ page }) => {
  const maya = node(page, 'marketing');
  // `/slow` makes the fake person speak a word at a time, so there is a reply in flight to be caught watching.
  const sent = fromOutside(page, 'marketing', '/slow taglines please', 'phone');

  // The founder's own words, with the quiet line saying where they were standing when they said them.
  await expect(maya.locator('.msg--user').last()).toContainText('/slow taglines please');
  await expect(maya.locator('.msg__via')).toHaveText('from your phone');
  // She is working, and the reply is being written on a card that asked for none of it.
  await expect(maya.locator('.status--thinking')).toBeVisible();
  await expect(maya.locator('.card__doing')).toHaveText('working…');
  await expect(maya.locator('.msg--assistant').last()).toContainText('Maya here');

  expect((await sent).ok()).toBe(true);
  await expect(maya.locator('.status--idle')).toBeVisible();
  await expect(maya.locator('.msg--assistant').last()).toContainText('You said: "/slow taglines please"');
  // Once each: the draft became the stored message rather than sitting beside it.
  await expect(maya.locator('.msg--user')).toHaveCount(1);
  await expect(maya.locator('.msg--assistant')).toHaveCount(1);
  await expect(maya.locator('.msg__via')).toHaveCount(1);
});

test('a message this window sent is still drawn once, though the feed says it too', async ({ page }) => {
  const maya = node(page, 'marketing');
  await maya.locator('.ask textarea').fill('from the stage');
  await maya.locator('.ask textarea').press('Enter');
  await expect(maya.locator('.status--idle')).toBeVisible({ timeout: 20_000 });
  await expect(maya.locator('.msg--assistant').last()).toContainText('You said: "from the stage"');

  // The window streamed this turn itself and heard it on the feed as well; neither the question nor the answer doubled.
  await expect(maya.locator('.msg--user')).toHaveCount(1);
  await expect(maya.locator('.msg--assistant')).toHaveCount(1);
  // Typed at the stage, so nothing claims it came from somewhere else.
  await expect(maya.locator('.msg__via')).toHaveCount(0);
  await page.waitForTimeout(500);
  await expect(maya.locator('.msg--assistant')).toHaveCount(1);
});

test('work handed to a colleague shows up live in the colleague\'s own card', async ({ page }) => {
  const stage = await (await page.request.get('/api/stage')).json();
  await page.request.put('/api/stage', { data: { ...stage, wires: [...stage.wires, { id: 'marketing-build', from: 'marketing', fromHandle: 'b', to: 'build', toHandle: 't' }] } });
  await page.reload();
  await expect(node(page, 'build')).toBeVisible();
  await expect(node(page, 'build').locator('.msg--colleague')).toHaveCount(0);

  const dev = node(page, 'build');
  await node(page, 'marketing').locator('.ask textarea').fill('/tool ask_person {"name":"Dev","question":"How long is SSO?"}');
  await node(page, 'marketing').locator('.ask textarea').press('Enter');

  // Maya's question landed in Dev's room, and Dev's card drew it and his answer without being touched.
  await expect(dev.locator('.msg--colleague')).toContainText('Maya asked');
  await expect(dev.locator('.msg--colleague')).toContainText('How long is SSO?');
  await expect(dev.locator('.msg--assistant').last()).toContainText('Dev here');
  await expect(node(page, 'marketing').locator('.status--idle')).toBeVisible({ timeout: 40_000 });
  await expect(dev.locator('.msg--colleague')).toHaveCount(1);
});
