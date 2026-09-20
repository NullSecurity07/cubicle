import { expect, test, type Page } from '@playwright/test';

// Everybody on the stage answers in a voice of their own. Nothing here makes a sound — the app is running its stand-in
// voice, which is a second of quiet — so what this journey watches is which voice was asked for, and whether it is
// still that one tomorrow. The model's own ids say which pool a voice is from: af_/bf_ are its women, am_/bm_ its men.
const WOMAN = /^[ab]f_/;
const MAN = /^[ab]m_/;
const SHOT = '/tmp/stage-shots';
type Person = { id: string; name: string; gender?: string; voice?: string };
const rooms = async (page: Page): Promise<Person[]> => (await (await page.request.get('/api/stage')).json()).rooms;

test.describe.configure({ mode: 'serial' });
const broke: string[] = [];
test.beforeEach(async ({ page }) => {
  broke.length = 0;
  page.on('pageerror', (error) => broke.push(error.message));
  await page.goto('/');
  await expect(page.locator('.react-flow__node[data-id="marketing"]')).toBeVisible();
});
test.afterEach(() => { expect(broke).toEqual([]); });

// This journey hires somebody, and the stage is shared with every other one: they are let go again at the end.
test.afterAll(async ({ playwright }) => {
  const script = await playwright.request.newContext({
    baseURL: `http://localhost:${Number(process.env.E2E_PORT ?? 7430)}`, extraHTTPHeaders: { 'x-stage-token': 'e2e-token' },
  });
  const stage = await (await script.get('/api/stage')).json();
  await script.put('/api/stage', { data: { ...stage, rooms: stage.rooms.filter((room: Person) => room.name !== 'Priya') } });
  await script.dispose();
});

test('a person is born with a gender guessed from their name and a voice of their own', async ({ page }) => {
  await page.getByRole('button', { name: 'Add person' }).click();
  const card = page.locator('.react-flow__node', { has: page.locator('form.setup') });
  const voice = card.getByLabel('Voice', { exact: true });

  await card.getByLabel('Name').fill('Priya');
  await card.getByLabel('Role').fill('Design');
  await card.getByLabel('What they do for you').fill('Screens, flows and the look of the thing.');
  // Named, and already a woman with a woman's voice — nobody had to say so.
  await expect(card.getByLabel('A woman')).toBeChecked();
  await expect(voice).toHaveValue(WOMAN);

  await card.evaluate((node) => Promise.all(node.getAnimations({ subtree: true }).map((one) => one.finished)));
  await page.waitForTimeout(300);
  await card.screenshot({ path: `${SHOT}/person-form.png` });

  // Heard before it is chosen, in the voice the picker is on.
  const asked = page.waitForRequest((request) => request.url().includes('/api/reach/speak'));
  await card.getByRole('button', { name: /Hear this voice/ }).click();
  expect(JSON.parse((await asked).postData() ?? '{}')).toMatchObject({ voice: await voice.inputValue() });

  // The founder says otherwise, and a voice from the other pool is suggested in its place.
  const first = await voice.inputValue();
  await card.getByLabel('A man').check();
  await expect(voice).toHaveValue(MAN);
  expect(await voice.inputValue()).not.toBe(first);

  // And their own ear beats both: every voice there is, and one they picked by hand is never taken back off them.
  await card.getByLabel('Show all voices').check();
  await voice.selectOption('bf_emma');
  await card.getByLabel('A woman').check();
  await expect(voice).toHaveValue('bf_emma');
  await card.getByLabel('A man').check();
  await expect(voice).toHaveValue('bf_emma');
  await card.getByRole('button', { name: 'Done' }).click();

  await expect.poll(async () => (await rooms(page)).find((room) => room.name === 'Priya')).toMatchObject({ gender: 'man', voice: 'bf_emma' });

  // Still hers after the window has been shut and opened again.
  await page.reload();
  const priya = page.locator('.react-flow__node', { hasText: 'Priya' });
  await priya.locator('.card__header').hover();
  await priya.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(priya.getByLabel('A man')).toBeChecked();
  await expect(priya.getByLabel('Voice', { exact: true })).toHaveValue('bf_emma');
  await priya.getByRole('button', { name: 'Cancel' }).click();
});

test('two people are never said out loud in the same voice', async ({ page }) => {
  const said = await page.request.post('/api/reach/speak', { data: { text: 'Here is what I found.', roomId: 'marketing' } });
  expect(said.headers()['content-type']).toBe('audio/wav');
  await page.request.post('/api/reach/speak', { data: { text: 'Here is what I found.', roomId: 'build' } });

  // Saying something is the first time these two ever needed a voice, and it is written down on them there and then.
  const here = await rooms(page);
  const maya = here.find((room) => room.id === 'marketing')!;
  const dev = here.find((room) => room.id === 'build')!;
  expect(maya).toMatchObject({ gender: 'woman', voice: expect.stringMatching(WOMAN) });
  expect(dev).toMatchObject({ gender: 'man', voice: expect.stringMatching(MAN) });
  expect(maya.voice).not.toBe(dev.voice);
});
