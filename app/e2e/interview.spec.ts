import { expect, test, type Page } from '@playwright/test';

// The Interview card: the founder adds it from the dock and says who the call is with, ticks that they agreed to be
// recorded, drops a recording on the card and sees the transcript fill in with times (a fixed one: the checks never
// start a model), wires a person who reads it with read_interview, and asks that person for the insights, which
// makes a doc beside the card and puts the ask in their room. The stage and Maya's room are left as they were found.
const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const handle = (page: Page, id: string, side: string) => node(page, id).locator(`.react-flow__handle[data-handleid="${side}"]`);
const centre = (box: { x: number; y: number; width: number; height: number }) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
const pad = (value: number) => String(value).padStart(2, '0');
const today = () => { const day = new Date(); return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`; };

// Three seconds of silence as a plain wav: 16 kHz, one channel, 16 bits.
function silentWav(seconds: number): number[] {
  const rate = 16000;
  const data = seconds * rate * 2;
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii'); head.writeUInt32LE(36 + data, 4); head.write('WAVE', 8, 'ascii');
  head.write('fmt ', 12, 'ascii'); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36, 'ascii'); head.writeUInt32LE(data, 40);
  return [...Buffer.concat([head, Buffer.alloc(data)])];
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps = 12) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.up();
}
// The same way stage.spec draws one: bring both ends into view, then try each side until a wire appears.
async function wire(page: Page, from: string, to: string) {
  const edges = page.locator('.react-flow__edge');
  const before = await edges.count();
  const inside = (box: { x: number; y: number } | null) => !!box && box.x > 30 && box.y > 30 && box.x < 1570 && box.y < 900;
  for (const side of ['l', 'r', 't', 'b']) {
    for (let tries = 0; tries < 6; tries += 1) {
      const [a, b] = [await handle(page, from, side).boundingBox(), await handle(page, to, side).boundingBox()];
      if (inside(a) && inside(b)) break;
      await page.mouse.move(12, 12);
      await page.mouse.wheel(0, 300);
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
async function send(page: Page, room: string, text: string) {
  await expect(node(page, room).locator('.status--idle')).toBeVisible();
  await node(page, room).locator('.ask textarea').fill(text);
  await node(page, room).locator('.ask textarea').press('Enter');
  await expect(node(page, room).locator('.status--idle')).toBeVisible({ timeout: 20_000 });
  return node(page, room).locator('.msg--assistant').last();
}
async function tidy(page: Page) {
  // On a busy machine the page's server can answer before the api behind it does: wait for the api, not a guess.
  let answer = await page.request.get('/api/stage');
  for (let tries = 0; !answer.ok() && tries < 40; tries += 1) { await page.waitForTimeout(500); answer = await page.request.get('/api/stage'); }
  const stage = await answer.json();
  const keep = new Set(['marketing', 'build', 'brand-doc', 'company-brief']);
  await page.request.put('/api/stage', { data: {
    rooms: stage.rooms.filter((room: { id: string }) => keep.has(room.id)), docs: stage.docs.filter((doc: { id: string }) => keep.has(doc.id)), cards: [],
    wires: stage.wires.filter((one: { id: string }) => one.id === 'marketing-brand-doc'),
  } });
}

const broke: string[] = [];
test.beforeEach(async ({ page }) => {
  broke.length = 0;
  page.on('pageerror', (error) => broke.push(error.message));
  await tidy(page);
  await page.goto('/');
  await expect(node(page, 'marketing')).toBeVisible({ timeout: 20_000 });
});

test.afterEach(async ({ page }) => {
  await page.goto('about:blank');
  await tidy(page);
  const chat = (await (await page.request.get('/api/rooms/marketing/chat')).json()) as { id: string; text: string }[];
  const from = chat.findIndex((message) => message.text.startsWith('/tool read_interview'));
  if (from >= 0) for (const message of chat.slice(from)) await page.request.delete(`/api/rooms/marketing/chat/${message.id}`);
  expect(broke).toEqual([]);
});

test('the founder records with consent, the transcript fills in with times, and a wired person reads it and writes the insights', async ({ page }) => {
  test.slow(); // Two turns with a person and a wire drawn by hand.
  await page.getByRole('button', { name: 'More cards' }).click();
  await page.getByRole('menuitem', { name: 'Add interview', exact: true }).click();
  const card = page.locator('.react-flow__node-interview');
  await expect(card).toBeVisible();
  const id = (await card.getAttribute('data-id'))!;

  // Who and when, first. The day starts as today.
  await expect(card.getByText('Who is the conversation with?')).toBeVisible();
  await expect(card.getByLabel('Date')).toHaveValue(today());
  await card.screenshot({ path: 'test-results/shots/interview-setup.png', animations: 'disabled' });
  await card.getByLabel('Who').fill('Ana');
  await card.getByLabel('Their company').fill('Acme');
  await card.getByRole('button', { name: 'Done' }).click();
  await expect(card.locator('.card__name')).toHaveText(`Ana, Acme, ${today()}`);

  // Nothing is recorded, or taken from a file, until the founder ticks that Ana agreed.
  const record = card.getByRole('button', { name: 'Record', exact: true });
  await expect(record).toBeDisabled();
  await expect(card.getByRole('button', { name: 'choose a file' })).toBeDisabled();
  await expect(card.getByText('Recorded and written down on this machine. Nothing leaves it until you ask a wired person about it.')).toBeVisible();
  await card.screenshot({ path: 'test-results/shots/interview-consent.png', animations: 'disabled' });
  await card.getByLabel('Ana agreed to be recorded').check();
  await expect(record).toBeEnabled();

  // A recording made elsewhere, dropped on the card.
  const drop = await page.evaluateHandle((bytes) => {
    const moved = new DataTransfer();
    moved.items.add(new File([new Uint8Array(bytes)], 'ana-call.wav', { type: 'audio/wav' }));
    return moved;
  }, silentWav(3));
  const body = card.locator('.interview');
  await body.dispatchEvent('dragover', { dataTransfer: drop });
  await body.dispatchEvent('drop', { dataTransfer: drop });

  const transcript = card.getByRole('region', { name: 'Transcript' });
  await expect(transcript.locator('li')).toHaveCount(4, { timeout: 15_000 });
  await expect(transcript.locator('li').nth(1)).toContainText('0:04Last month it took us four days, mostly chasing receipts in email.');
  await expect(transcript.locator('h3')).toHaveText('Transcript 3 s');
  await expect(card.getByRole('list', { name: 'Recordings' })).toContainText('Recording 13 s');
  // Every time is a place to listen from.
  await transcript.getByRole('button', { name: 'Listen from 0:00' }).click();
  await expect(transcript.locator('li.is-playing')).toHaveCount(1);
  await card.screenshot({ path: 'test-results/shots/interview-transcript.png', animations: 'disabled' });

  // Only a person wired to the card can read it.
  const insights = card.getByRole('button', { name: 'Write insights' });
  await expect(insights).toBeDisabled();
  // Maya is above the view: step back around the middle of the window until both cards are in it.
  for (let tries = 0; tries < 4 && ((await node(page, 'marketing').boundingBox())?.y ?? -1) < 30; tries += 1) {
    await drag(page, { x: 1400, y: 150 }, { x: 1400, y: 500 });
    await page.waitForTimeout(200);
  }
  await wire(page, 'marketing', id);
  await expect(insights).toBeEnabled();
  const read = await send(page, 'marketing', '/tool read_interview {}');
  await expect(read.locator('.chip--ok summary')).toHaveText('Read the interview');
  await read.locator('.chip summary').click();
  await expect(read.locator('.chip pre')).toContainText(`Interview with Ana, Acme, ${today()}: 3 s, recorded with their consent and written down on this machine by fake.`);
  await expect(read.locator('.chip pre')).toContainText('[0:15] If something cut that to one day I would pay for it out of my own budget.');

  // The insights: a doc beside the card, wired to Maya, and the ask already in her room.
  await insights.click();
  const focused = page.locator('.card--focused');
  await expect(focused.locator('.msg--user').last()).toContainText('Read the interview with Ana at Acme with read_interview. Then, with the story-interview skill, write the insights into the doc "Insights: Ana, Acme"');
  await expect(focused.locator('.status--idle')).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press('Escape');
  const stage = await (await page.request.get('/api/stage')).json() as { docs: { id: string; title: string }[]; wires: { from: string; to: string }[] };
  const made = stage.docs.find((one) => one.title === 'Insights: Ana, Acme')!;
  expect(made).toBeTruthy();
  await expect(node(page, made.id).getByLabel('Doc title')).toHaveValue('Insights: Ana, Acme');
  expect(stage.wires.some((one) => one.from === 'marketing' && one.to === made.id)).toBe(true);
  expect(stage.wires.some((one) => one.from === id && one.to === made.id)).toBe(true);
  await expect(card.getByRole('region', { name: 'Insights' })).toContainText('Maya was asked to write them in Insights: Ana, Acme.');
  await expect(card.getByRole('button', { name: 'Ask again' })).toBeVisible();
  await card.getByRole('button', { name: 'Focus' }).click();
  await page.locator('.card--focused .interview').screenshot({ path: 'test-results/shots/interview-insights.png', animations: 'disabled' });
  await page.keyboard.press('Escape');
  const chat = (await (await page.request.get('/api/rooms/marketing/chat')).json()) as { id: string; text: string }[];
  const from = chat.findIndex((message) => message.text.startsWith('Read the interview with Ana'));
  for (const message of chat.slice(Math.max(0, from))) if (from >= 0) await page.request.delete(`/api/rooms/marketing/chat/${message.id}`);
});
