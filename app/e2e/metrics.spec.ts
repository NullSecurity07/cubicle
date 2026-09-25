import { expect, test, type Page } from '@playwright/test';

// The Metrics card: the founder adds it from the dock, pastes a small table and sees the north star move, types
// today's value, wires a person who then reads the numbers in their own prompt, suggests a target the founder
// accepts in Needs you, and writes a number only once the founder says yes. The stage is left as it was found.
const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const handle = (page: Page, id: string, side: string) => node(page, id).locator(`.react-flow__handle[data-handleid="${side}"]`);
const centre = (box: { x: number; y: number; width: number; height: number }) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
const pad = (value: number) => String(value).padStart(2, '0');
const dayOf = (day: Date) => `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
const today = () => dayOf(new Date());
// Days counted from today, so the journey reads the same whatever the calendar says.
const shift = (days: number) => { const day = new Date(); day.setDate(day.getDate() + days); return dayOf(day); };
// The Mondays of the three weeks before this one: the pasted rows sit in past weeks, and a value typed today opens a
// new week of its own, so each delta below compares this week with the last.
const monday = (weeksBack: number) => shift(-((new Date().getDay() + 6) % 7) - 7 * weeksBack);
const CSV = `date,Weekly active teams,MRR\n${monday(3)},30,"$2,880"\n${monday(2)},34,$3000\n${monday(1)},42,$3120\nnot a day,1,2`;
const BY = shift(98);

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
  return node(page, room).locator('.msg--assistant').last();
}
async function tidy(page: Page) {
  const stage = await (await page.request.get('/api/stage')).json();
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
  await expect(node(page, 'marketing')).toBeVisible();
});

test.afterEach(async ({ page }) => {
  await page.goto('about:blank');
  await tidy(page);
  for (const room of ['marketing', 'build']) {
    const chat = (await (await page.request.get(`/api/rooms/${room}/chat`)).json()) as { id: string; text: string }[];
    const from = chat.findIndex((message) => message.text.startsWith('/tool read_metrics'));
    if (from >= 0) for (const message of chat.slice(from)) await page.request.delete(`/api/rooms/${room}/chat/${message.id}`);
  }
  expect(broke).toEqual([]);
});

test('the founder pastes numbers, a wired person reads them, suggests a target the founder accepts, and writes a number only with a yes', async ({ page }) => {
  test.slow(); // Five turns with people and a wire drawn by hand; the default thirty seconds is tight on a busy machine.
  await page.getByRole('button', { name: 'More cards' }).click();
  await page.getByRole('menuitem', { name: 'Add metrics', exact: true }).click();
  const card = page.locator('.react-flow__node-metrics');
  await expect(card).toBeVisible();
  const id = (await card.getAttribute('data-id'))!;
  await expect(card.getByText('Paste a table or drop a CSV: a date, then one column for each number.')).toBeVisible();
  await page.screenshot({ path: 'test-results/shots/metrics-empty.png', clip: (await card.boundingBox())! });

  await card.getByLabel('Paste numbers').fill(CSV);
  await card.getByRole('button', { name: 'Read', exact: true }).click();
  const star = card.getByRole('region', { name: 'North star: Weekly active teams' });
  await expect(star.locator('.metrics__big b')).toHaveText('42');
  await expect(star.locator('.metrics__delta')).toHaveText('+8 · +24% vs last week');
  await expect(star.locator('.metrics__delta')).toHaveClass(/is-good/);
  await expect(card.getByRole('status')).toContainText('6 readings from the pasted table. Skipped 1:');
  await expect(card.getByRole('status')).toContainText('row 5: "not a day" is not a date');
  await expect(card.getByRole('list', { name: 'Other numbers' })).toContainText('MRR$3,120+$120');

  // Every point says where it came from.
  const spark = star.locator('.spark');
  const box = (await spark.boundingBox())!;
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2);
  await expect(star.getByRole('tooltip')).toContainText('pasted, row 4');
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await expect(star.getByRole('tooltip')).toContainText('pasted, row 2');

  // Today's value, typed by the founder.
  await card.getByLabel('Which number').selectOption({ label: 'MRR' });
  await card.getByLabel("Today's value").fill('3300');
  await card.getByRole('button', { name: 'Log', exact: true }).click();
  await expect(card.getByRole('list', { name: 'Other numbers' })).toContainText('$3,300');
  await page.screenshot({ path: 'test-results/shots/metrics-card.png', clip: (await card.boundingBox())! });

  // A person not wired to the card is never offered its tools, so nothing runs.
  const alone = await send(page, 'build', '/tool read_metrics {}');
  await expect(node(page, 'build').locator('.status--idle')).toBeVisible({ timeout: 20_000 });
  await expect(alone.locator('.chip')).toHaveCount(0);

  await wire(page, 'marketing', id);
  const read = await send(page, 'marketing', '/tool read_metrics {"key":"MRR"}');
  await expect(read.locator('.chip--ok summary')).toHaveText('Read the numbers', { timeout: 20_000 });
  await read.locator('.chip summary').click();
  await expect(read.locator('.chip pre')).toContainText(`- ${today()}: $3,300 · founder, typed`);
  // The block the person read, exactly as the model was handed it, dated by the newest entry.
  const heard = (await (await page.request.get(`/api/metrics/${id}/heard/marketing`)).json()) as { text: string };
  expect(heard.text).toBe([
    '- A Metrics card. Read more with read_metrics.',
    '  North star: Weekly active teams 42 (+8, +24% vs last week; 2 weeks up).',
    `  MRR $3,300 (+$180). Last entry ${today()}.`,
  ].join('\n'));

  const proposed = await send(page, 'marketing', `/tool propose_target {"key":"Weekly active teams","value":100,"by":"${BY}","why":"The seed round asks for it."}`);
  await expect(proposed.locator('.chip--ok summary')).toHaveText('Suggested a target', { timeout: 20_000 });
  await page.getByRole('button', { name: /^Needs you: \d+ waiting$/ }).click();
  const need = page.locator('.needs__item--proposed-target');
  await expect(need).toContainText('Maya suggests a target');
  await expect(need).toContainText(`Weekly active teams: 100 by ${BY}`);
  await expect(need).toContainText('The seed round asks for it.');
  await page.screenshot({ path: 'test-results/shots/metrics-needs-you.png' });
  await need.getByRole('button', { name: 'Accept' }).click();
  await expect(need).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(star.locator('.metrics__target')).toContainText('Target 100 by');
  await expect(star.locator('.metrics__target')).toContainText('on pace');

  // A number a person writes waits for the founder's yes, and says who wrote it.
  await send(page, 'marketing', '/tool log_metric {"key":"Weekly active teams","value":47,"source":"founder in chat"}');
  const ask = node(page, 'marketing').getByRole('group', { name: 'Allow log_metric?' });
  await expect(ask).toContainText(`Write 47 for Weekly active teams on ${today()}?`);
  await ask.getByRole('button', { name: 'Allow' }).click();
  await expect(node(page, 'marketing').locator('.chip--ok summary').last()).toHaveText('Wrote a number', { timeout: 20_000 });
  await expect(star.locator('.metrics__big b')).toHaveText('47');
  await expect(star.locator('.metrics__delta')).toHaveText('+5 · +12% vs last week');
  await page.screenshot({ path: 'test-results/shots/metrics-after.png', clip: (await card.boundingBox())! });
});
