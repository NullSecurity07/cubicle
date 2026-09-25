import { expect, test, type Page } from '@playwright/test';

// The Survey card: the founder adds it from the dock, starts from the PMF template, names the product, copies the
// questions out, pastes back the CSV that Tally exported, and sees the score against 40% and the segment that would
// miss the product most. A wired person then reads the answers with read_survey and in their own prompt, and Write
// summary asks them for a doc. The stage is left as it was found.
const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const handle = (page: Page, id: string, side: string) => node(page, id).locator(`.react-flow__handle[data-handleid="${side}"]`);
const centre = (box: { x: number; y: number; width: number; height: number }) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

// Ten answers as Tally exports them, with its bookkeeping columns, a column the survey did not ask, and a blank row.
const CSV = [
  'Submission ID,Respondent ID,Submitted at,How would you feel if you could no longer use Acme?,What type of people do you think would most benefit from Acme?,What is the main benefit you receive from Acme?,How can we improve Acme for you?,Email',
  'a1,p1,2026-09-20 10:00:00,Very disappointed,Agency founders,"It saves me the Monday report, every week",Faster exports,a@x.io',
  'a2,p2,2026-09-20 11:00:00,Very disappointed,agency founders,Saves me the Monday report,More integrations,b@x.io',
  'a3,p3,2026-09-21 09:00:00,Somewhat disappointed,Agency founders,Nice dashboards,Faster exports please,',
  'a4,p4,2026-09-21 12:00:00,Very disappointed,Freelancers,The Monday report writes itself,,',
  'a5,p5,2026-09-22 08:00:00,Not disappointed,Freelancers,Not much,Cheaper,',
  'a6,p6,2026-09-22 09:00:00,Somewhat disappointed,Freelancers,Dashboards,Faster exports,',
  'a7,p7,2026-09-22 10:00:00,Very disappointed,Founders of agencies,Client reporting on autopilot,Mobile app,',
  'a8,p8,2026-09-23 10:00:00,Not disappointed,Students,Free plan,Cheaper plan,',
  'a9,p9,2026-09-23 11:00:00,Somewhat disappointed,Students,Dashboards look nice,Mobile app,',
  'a10,p10,2026-09-24 11:00:00,Very disappointed,Agency founders,Saves hours on the Monday report,,',
  'a11,p11,2026-09-24 12:00:00,,,,,',
].join('\n');

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps = 12) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.up();
}
// The same way stage.spec draws one: bring both ends into view, panning or zooming out, then try each side until a
// wire appears.
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
      // Too far apart for the screen: zoom out. Otherwise slide the pair toward the middle.
      if (a && b && (Math.abs(a.x - b.x) > 1400 || Math.abs(a.y - b.y) > 800)) { await page.mouse.move(12, 12); await page.mouse.wheel(0, 400); } else if (a && b) await pan((a.x + b.x) / 2, (a.y + b.y) / 2);
      await page.waitForTimeout(250);
    }
    const [start, end] = [await handle(page, from, side).boundingBox(), await handle(page, to, side).boundingBox()];
    if (!inside(start) || !inside(end)) continue;
    await drag(page, centre(start!), centre(end!), 24);
    await page.waitForTimeout(250);
    if ((await edges.count()) > before) return;
  }
  await page.screenshot({ path: `test-results/wire-fail-${to}.png` });
  throw new Error(`could not wire ${from} to ${to}: ${JSON.stringify({ from: await handle(page, from, 'l').boundingBox(), to: await handle(page, to, 'l').boundingBox(), view: await page.locator('.react-flow__viewport').getAttribute('style') })}`);
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
  await expect(node(page, 'marketing')).toBeVisible({ timeout: 20_000 });
});

test.afterEach(async ({ page }) => {
  await page.goto('about:blank');
  await tidy(page);
  const chat = (await (await page.request.get('/api/rooms/marketing/chat')).json()) as { id: string; text: string }[];
  const from = chat.findIndex((message) => message.text.startsWith('/tool read_survey'));
  if (from >= 0) for (const message of chat.slice(from)) await page.request.delete(`/api/rooms/marketing/chat/${message.id}`);
  expect(broke).toEqual([]);
});

test('the founder writes a PMF survey, copies it out, imports the answers, and a wired person reads and sums them up', async ({ page }) => {
  test.slow(); // Two turns with a person and a wire drawn by hand; the default thirty seconds is tight on a busy machine.
  await page.getByRole('button', { name: 'More cards' }).click();
  await page.getByRole('menuitem', { name: 'Add survey', exact: true }).click();
  const card = page.locator('.react-flow__node-survey');
  await expect(card).toBeVisible();
  const id = (await card.getAttribute('data-id'))!;
  await card.screenshot({ path: 'test-results/shots/survey-start.png', animations: 'disabled' });

  // Start from the Sean Ellis template, and name the product the questions are about.
  await card.getByRole('group', { name: 'Start from' }).getByRole('button', { name: /Product-market fit/ }).click();
  await expect(card.getByLabel('Survey name')).toHaveValue('PMF survey');
  await expect(card.getByRole('radio', { name: 'PMF' })).toHaveAttribute('aria-checked', 'true');
  const list = card.getByRole('region', { name: 'Questions' }).locator('.survey__q');
  await expect(list).toHaveCount(4);
  await card.getByLabel('Product name').fill('Acme');
  await expect(list.first()).toContainText('How would you feel if you could no longer use Acme?');
  await expect(list.first()).toContainText('Very disappointed · Somewhat disappointed · Not disappointed');

  // Copied out: a plain list for an email, and one shaped for a form editor.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await card.getByRole('button', { name: 'Copy questions' }).click();
  await expect(card.getByRole('button', { name: 'Copied' })).toBeVisible();
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text.split('\n')).toEqual([
    '1. How would you feel if you could no longer use Acme? (Very disappointed / Somewhat disappointed / Not disappointed)',
    '2. What type of people do you think would most benefit from Acme?',
    '3. What is the main benefit you receive from Acme?',
    '4. How can we improve Acme for you?',
  ]);
  await card.getByRole('button', { name: 'Copy for Tally / Forms' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('1. How would you feel if you could no longer use Acme?\n   [Multiple choice, one answer]\n   - Very disappointed');
  await card.screenshot({ path: 'test-results/shots/survey-questions.png', animations: 'disabled' });

  // The export pasted back: every question matched by its words, the blank row skipped and said, the extra column named.
  await card.getByRole('button', { name: 'Import answers' }).click();
  await card.getByLabel('Paste answers').fill(CSV);
  await card.getByRole('button', { name: 'Import', exact: true }).click();
  const said = card.getByRole('status');
  await expect(said).toContainText('10 answers imported from the pasted table. Matched 4 of 4 questions. Skipped 1:');
  await expect(said).toContainText('row 12: no answer to any of the survey\'s questions');
  await expect(said).toContainText('Not used: Email');

  // The results open on their own: the score against 40%, and who would miss it most.
  await expect(card.getByRole('tab', { name: 'Results 10' })).toHaveAttribute('aria-selected', 'true');
  const score = card.getByRole('region', { name: 'Product-market fit score' });
  await expect(score.locator('.survey__big')).toHaveText('50%at or above 40%');
  await expect(score).toContainText('5 very · 3 somewhat · 2 not disappointed, of 10');
  await expect(score).toContainText('Under 30 answers: too few to trust yet.');
  const segments = card.getByRole('region', { name: 'Segments' });
  await expect(segments.locator('.survey__top')).toHaveText('Agency founders 80% of 5');
  await expect(card.getByRole('region', { name: 'Top reasons' })).toContainText('Saves me the Monday report');
  await expect(card.getByRole('region', { name: 'Top asks' })).toContainText('Faster exports');
  await page.screenshot({ path: 'test-results/shots/survey-results.png', clip: (await card.boundingBox())! });

  // The same file again adds nothing.
  await card.getByRole('button', { name: 'Import more' }).click();
  await card.getByLabel('Paste answers').fill(CSV);
  await card.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(said).toContainText('No new answers in the pasted table. 10 already here.');
  await expect(card.getByRole('tab', { name: 'Results 10' })).toBeVisible();

  // Nobody is wired yet, so nobody can be asked for the summary.
  await expect(card.getByRole('button', { name: 'Write summary' })).toBeDisabled();
  await wire(page, 'marketing', id);
  const read = await send(page, 'marketing', '/tool read_survey {"query":"monday report"}');
  await expect(read.locator('.chip--ok summary')).toHaveText('Read the survey', { timeout: 20_000 });
  await read.locator('.chip summary').click();
  await expect(read.locator('.chip pre')).toContainText('4 of 10 answers hold "monday report":');
  await expect(read.locator('.chip pre')).toContainText('disappointed: Very disappointed · segment: agency founders · benefit: Saves me the Monday report · improve: More integrations');
  // The lines the person read, exactly as the model was handed them, dated by the newest answer.
  const heard = (await (await page.request.get(`/api/surveys/${id}/heard/marketing`)).json()) as { text: string };
  expect(heard.text).toBe([
    '- PMF survey "PMF survey": 10 answers, 50% very disappointed (at or above 40%). Most disappointed: agency founders (80%, 5 answers). Top reason: \'Saves me the Monday report\'.',
    '  Under 30 answers: too few to trust. Raw answers with read_survey. Newest answer 2026-09-24.',
  ].join('\n'));
  await expect(node(page, 'marketing').locator('.status--idle')).toBeVisible({ timeout: 20_000 });

  // Write summary puts the ask in the wired person's room and brings them forward.
  await card.getByRole('button', { name: 'Write summary' }).click();
  const focused = page.locator('.card--focused');
  await expect(focused.locator('.msg--user').last()).toContainText('Write a summary doc of the survey "PMF survey": read it with read_survey, then create a doc with the share very disappointed against the 40% benchmark');
  await expect(focused.locator('.status--idle')).toBeVisible({ timeout: 20_000 });
});
