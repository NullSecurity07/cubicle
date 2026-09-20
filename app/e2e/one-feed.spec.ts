import { expect, test, type Page } from '@playwright/test';

// The founder's own window, the morning it stopped answering. Four boards and two studios on the stage: every live
// feed used to be a connection of its own, and a browser allows about six to one site, so the seventh request —
// a conversation, a mission, a picture — queued behind them for ever and the app looked empty rather than broken.
const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const BOARDS = ['feed-one', 'feed-two', 'feed-three', 'feed-four'];

test('one live connection carries every feed, and everything else the page asks for still answers', async ({ page }) => {
  const before = await (await page.request.get('/api/stage')).json();
  await page.request.put('/api/stage', { data: { ...before, cards: [
    ...BOARDS.map((id, index) => ({ kind: 'board', id, x: 980, y: index * 460, w: 900, h: 420 })),
    { kind: 'imagegen', id: 'feed-image', x: 1950, y: 0, w: 320, h: 420 },
    { kind: 'voicegen', id: 'feed-voice', x: 1950, y: 460, w: 320, h: 340 },
  ] } });
  await page.request.post(`/api/boards/${BOARDS[0]}/tasks`, { data: { title: 'Book the launch venue' } });

  // Every long-lived feed this window holds, counted as it opens and dropped as it ends: a feed never ends, so
  // whatever is left in here is what the page is holding open right now.
  const live = new Map<unknown, string>();
  page.on('request', (request) => { if (new URL(request.url()).pathname.endsWith('/events')) live.set(request, new URL(request.url()).pathname); });
  page.on('requestfinished', (request) => live.delete(request));
  page.on('requestfailed', (request) => live.delete(request));
  const holding = () => [...live.values()].sort();

  try {
    await page.goto('/');
    await expect(node(page, BOARDS[0])).toContainText('Book the launch venue');
    expect(holding()).toEqual(['/api/events']);

    // The Messages panel used to list nothing at all here, because `/api/threads` never came back.
    await page.getByRole('button', { name: 'Messages' }).click();
    const list = page.getByRole('dialog', { name: 'Messages' }).getByRole('navigation', { name: 'Conversations' });
    await expect(list.getByRole('button').filter({ hasText: 'Maya' }).first()).toBeVisible({ timeout: 3000 });
    await expect(list.getByRole('button').filter({ hasText: 'Dev' }).first()).toBeVisible({ timeout: 3000 });
    await page.keyboard.press('Escape');

    // An ordinary request from the page itself: it answers, rather than waiting behind the feeds for ever.
    const missions = await page.evaluate(() => Promise.race([
      fetch('/api/missions').then((response) => (response.ok ? 'answered' : `refused ${response.status}`)),
      new Promise((resolve) => { setTimeout(() => resolve('never answered'), 5000); }),
    ]));
    expect(missions).toBe('answered');

    // The last board on the stage is as live as the first: one connection, every board on it.
    await page.request.post(`/api/boards/${BOARDS[3]}/tasks`, { data: { title: 'Pick the launch date' } });
    await expect(node(page, BOARDS[3])).toContainText('Pick the launch date');

    // A board put down after the window opened joins the feed that is already running, without a reload.
    await page.getByRole('button', { name: 'More cards' }).click();
    await page.getByRole('menuitem', { name: 'Add task board' }).click();
    const ids = await page.locator('.react-flow__node-board').evaluateAll((cards) => cards.map((card) => card.getAttribute('data-id') ?? ''));
    const fresh = ids.find((id) => !BOARDS.includes(id))!;
    expect(fresh).toBeTruthy();
    await expect.poll(async () => ((await (await page.request.get('/api/stage')).json()).cards as { id: string }[]).some((card) => card.id === fresh)).toBe(true);
    await page.request.post(`/api/boards/${fresh}/tasks`, { data: { title: 'Ring the printer' } });
    await expect(node(page, fresh)).toContainText('Ring the printer');
    expect(holding()).toEqual(['/api/events']);
  } finally {
    await page.goto('about:blank');
    await page.request.put('/api/stage', { data: before });
  }
});
