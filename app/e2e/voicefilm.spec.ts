import { expect, test, type Page } from '@playwright/test';

// A Voice studio wired to a Video studio is the film's narrator: the founder picks a voice on the voice card, the
// video card says whose voice it will use before Make is pressed, and the film is read in it. A narrator the founder
// picks on the video card itself still wins. The stage is left as it was found.
const broke: string[] = [];

async function addCard(page: Page, name: string) {
  await page.getByRole('button', { name: 'More cards' }).click();
  await page.getByRole('menuitem', { name, exact: true }).click();
}

type Card = { id: string; kind: string };
const stageOf = async (page: Page) => (await page.request.get('/api/stage')).json();
// What the newest film on a card was made of, read from the record written beside it.
const newestRecord = async (page: Page, id: string) => {
  const film = (await (await page.request.get(`/api/media/${id}`)).json()).results[0]?.film as string | undefined;
  return film ? (await page.request.get(`/api/files/${film}`)).json() : null;
};

// A film in fake mode is quick, but this box is often busy: give the journey room rather than a flake.
test.setTimeout(120_000);

test.beforeEach(async ({ page }) => {
  broke.length = 0;
  page.on('pageerror', (error) => broke.push(error.message));
  const stage = await stageOf(page);
  await page.request.put('/api/stage', { data: { ...stage, cards: [], wires: (stage.wires as { id: string }[]).filter((wire) => wire.id === 'marketing-brand-doc') } });
  await page.goto('/');
  await expect(page.locator('.react-flow__node[data-id="marketing"]')).toBeVisible({ timeout: 60_000 });
});

test.afterEach(async ({ page }) => {
  await page.goto('about:blank');
  const stage = await stageOf(page);
  await page.request.put('/api/stage', { data: { ...stage, cards: [], wires: (stage.wires as { id: string }[]).filter((wire) => wire.id === 'marketing-brand-doc') } });
  expect(broke).toEqual([]);
});

test('a wired voice studio reads the film in its voice, and the video card says so', async ({ page }) => {
  await addCard(page, 'Add voice studio');
  await addCard(page, 'Add video studio');
  // Both cards are on the stage once the page has saved them; the wire between them is drawn by the API.
  let voiceId = '';
  let filmId = '';
  await expect.poll(async () => {
    const cards = (await stageOf(page)).cards as Card[];
    voiceId = cards.find((card) => card.kind === 'voicegen')?.id ?? '';
    filmId = cards.find((card) => card.kind === 'videogen')?.id ?? '';
    return !!voiceId && !!filmId;
  }).toBe(true);
  const stage = await stageOf(page);
  await page.request.put('/api/stage', { data: { ...stage, wires: [...stage.wires, { id: `${voiceId}-${filmId}`, from: voiceId, fromHandle: 'r', to: filmId, toHandle: 'l' }] } });
  await page.reload();

  const voice = page.locator(`.react-flow__node[data-id="${voiceId}"]`);
  const film = page.locator(`.react-flow__node[data-id="${filmId}"]`);
  await expect(film).toBeVisible();
  // Before a voice is picked, the studio's default voice is the one named.
  await expect(film.locator('.studio__using')).toHaveText('Using: the voice of the Voice studio, Heart');

  // The founder picks Sarah on the voice card, and the video card follows at once.
  await voice.getByLabel('Voice').selectOption('af_sarah');
  await expect(film.locator('.studio__using')).toHaveText('Using: the voice of the Voice studio, Sarah');
  await film.getByText('More', { exact: false }).click();
  await expect(film.getByLabel('Narrator')).toHaveValue('');
  await expect(film.getByLabel('Narrator').locator('option').first()).toHaveText("The Voice studio's voice");

  await film.getByLabel('What the film is about').fill('a short hello to our first customers');
  await film.getByRole('button', { name: 'Make' }).click();
  await expect(film.locator('.studio__result video')).toBeVisible();
  await expect.poll(async () => (await newestRecord(page, filmId))?.narrator?.voice).toBe('af_sarah');
  const log = (await (await page.request.get(`/api/media/${filmId}`)).json()).log.join('\n');
  expect(log).toContain('using: the voice of the Voice studio, Sarah');
  await film.screenshot({ path: 'test-results/shots/voicefilm-using.png' });
  await voice.screenshot({ path: 'test-results/shots/voicefilm-voice-studio.png' });

  // A narrator picked on the video card wins, and the card stops naming the studio's voice.
  await film.getByLabel('Narrator').selectOption('bm_george');
  await expect(film.locator('.studio__using')).toHaveCount(0);
  const before = (await (await page.request.get(`/api/media/${filmId}`)).json()).results.length;
  await film.getByRole('button', { name: 'Make' }).click();
  await expect.poll(async () => (await (await page.request.get(`/api/media/${filmId}`)).json()).results.length).toBe(before + 1);
  expect((await newestRecord(page, filmId))?.narrator?.voice).toBe('bm_george');
});
