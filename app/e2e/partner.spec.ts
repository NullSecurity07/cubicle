import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { advanceDay, resetClock } from './helpers.ts';

// The partner, in fake mode. "add a partner called Sam" puts Sam on the stage wired to the stage's own Company brief,
// which is adopted as the company's one document: its text kept, its six sections added, no second doc. "morning note" has Sam write today's note: it is said at the top of the
// window, it is first in Today's five, and Needs you lets the founder say it is read. Everything is taken away after.
const WORKSPACE = process.env.STAGE_WORKSPACE!;
type Stage = { rooms: { id: string; name: string; partner?: boolean }[]; docs: { id: string; title: string; pinned?: boolean }[]; wires: { id: string; from: string; to: string }[] };
const stageOf = async (page: Page) => (await (await page.request.get('/api/stage')).json()) as Stage;

async function bar(page: Page, words: string, pick: string) {
  await page.keyboard.press('Control+k');
  const input = page.getByRole('combobox', { name: 'Command or search' });
  await input.fill(words);
  await expect(page.getByRole('listbox', { name: 'Suggestions' }).getByRole('option').first()).toContainText(pick);
  await input.press('Enter');
}

const broke: string[] = [];
let brief = '';
// The lines each team room held before the check: what a check or Sam's review adds to Maya's or Dev's thread is cut
// after it, so a later journey that counts a room's chips or conversations sees only its own.
const ROOMS = ['marketing', 'build'];
const before = new Map<string, Set<string>>();
const lines = async (page: Page, room: string) => (await (await page.request.get(`/api/rooms/${room}/chat`)).json()) as { id: string }[];
test.beforeEach(async ({ page }) => {
  test.setTimeout(90_000);
  broke.length = 0;
  page.on('pageerror', (error) => broke.push(error.message));
  // The Getting started list is in its corner, as on a first run, whatever an earlier check did with it.
  await rm(join(WORKSPACE, 'missions.json'), { force: true });
  await page.goto('/');
  await expect(page.locator('.react-flow__node[data-id="marketing"]')).toBeVisible({ timeout: 30_000 });
  brief = ((await (await page.request.get('/api/docs/company-brief')).json()) as { text: string }).text;
  for (const room of ROOMS) before.set(room, new Set((await lines(page, room)).map((one) => one.id)));
});

test.afterEach(async ({ page }) => {
  await page.goto('about:blank');
  const stage = await stageOf(page);
  const gone = new Set([...stage.rooms.filter((room) => room.partner).map((room) => room.id), ...stage.docs.filter((doc) => doc.title === 'Company').map((doc) => doc.id)]);
  await page.request.put('/api/docs/company-brief', { data: { text: brief } });
  await page.request.put('/api/stage', { data: { ...stage, rooms: stage.rooms.filter((room) => !gone.has(room.id)), docs: stage.docs.filter((doc) => !gone.has(doc.id)), wires: stage.wires.filter((wire) => !gone.has(wire.from) && !gone.has(wire.to)) } });
  for (const name of ['partner.json', 'bets.json', 'today.json', 'promises.json', 'reviews.json', 'partner-watch.json', 'unasked.json']) await rm(join(WORKSPACE, name), { force: true });
  for (const room of ROOMS) {
    const kept = before.get(room) ?? new Set();
    for (const one of (await lines(page, room)).filter((line) => !kept.has(line.id))) {
      // A reply still being written answers 409: wait for the person to finish, then cut the line.
      await expect.poll(async () => (await page.request.delete(`/api/rooms/${room}/chat/${one.id}`)).status(), { timeout: 30_000 }).not.toBe(409);
    }
  }
  expect(broke).toEqual([]);
});

test('the founder adds a partner who keeps the Company document and leaves a morning note', async ({ page }) => {
  await bar(page, 'add a partner called Sam', 'Add Sam, your partner');
  const notice = page.getByRole('status').filter({ hasText: 'Sam is your partner' });
  await expect(notice).toBeVisible({ timeout: 15_000 });

  const stage = await stageOf(page);
  const sam = stage.rooms.find((room) => room.name === 'Sam')!;
  const company = stage.docs.find((doc) => doc.id === 'company-brief')!;
  // The line sits at the top of the window, clear of the two cards it is about, and goes by itself after six seconds.
  const box = (await notice.boundingBox())!;
  expect(box.y).toBeLessThan(40);
  expect(box.height).toBeLessThan(48);
  for (const id of [sam.id, company.id]) {
    await expect.poll(async () => {
      const card = (await page.locator(`.react-flow__node[data-id="${id}"]`).boundingBox())!;
      return card.y >= box.y + box.height || card.x >= box.x + box.width || card.x + card.width <= box.x;
    }).toBe(true);
  }
  await expect(notice).toBeHidden({ timeout: 7_000 });

  // The stage moves Sam into the corner where the Getting started list sits (as a new card elsewhere does, gliding the
  // view to it): the list keeps clear of Sam's ask box, tucked to its head or out of the way until Sam moves on.
  const missions = page.locator('.missions');
  const ask = page.locator(`.react-flow__node[data-id="${sam.id}"] .ask`);
  await expect(missions).toBeVisible();
  const [list, desk] = [(await missions.boundingBox())!, (await ask.boundingBox())!];
  const spot = await page.evaluate(() => {
    for (let y = 60; y < 400; y += 20) for (let x = 400; x < 1500; x += 20) if (document.elementFromPoint(x, y)?.classList.contains('react-flow__pane')) return { x, y };
    return null;
  });
  const [dx, dy] = [list.x + 120 - (desk.x + desk.width / 2), list.y + list.height - 24 - (desk.y + desk.height / 2)];
  await page.mouse.move(spot!.x, spot!.y);
  await page.mouse.down();
  for (let step = 1; step <= 10; step += 1) await page.mouse.move(spot!.x + (dx * step) / 10, spot!.y + (dy * step) / 10);
  await page.mouse.up();
  const clear = async () => {
    const [shown, over] = [await missions.isVisible() ? (await missions.boundingBox())! : null, (await ask.boundingBox())!];
    return !shown || shown.x >= over.x + over.width || over.x >= shown.x + shown.width || shown.y >= over.y + over.height || over.y >= shown.y + shown.height ? 'clear' : 'over the ask box';
  };
  await expect.poll(clear).toBe('clear');
  expect(sam.partner).toBe(true);
  expect(company.pinned).toBe(true);
  expect(stage.docs.filter((doc) => doc.pinned)).toHaveLength(1);
  expect(stage.wires.some((wire) => wire.from === sam.id && wire.to === company.id)).toBe(true);
  const text = ((await (await page.request.get(`/api/docs/${company.id}`)).json()) as { text: string }).text;
  expect(text.startsWith(brief.trimEnd())).toBe(true);
  expect(text).toContain('## Idea');
  expect(text).toContain('## Open questions');
  await expect(page.locator(`.react-flow__node[data-id="${company.id}"] .doc__all`)).toBeVisible();
  // The open card was told of the new sections and shows them.
  await expect(page.locator(`.react-flow__node[data-id="${company.id}"]`)).toContainText('## Open questions');
  // Asked twice, the bar does not make a second partner: it brings Sam forward.
  await bar(page, 'add partner', 'Add your partner');
  await expect(page.getByRole('status').filter({ hasText: 'Sam is already your partner' })).toBeVisible();
  await page.keyboard.press('Escape');
  expect((await stageOf(page)).rooms.filter((room) => room.partner)).toHaveLength(1);

  await bar(page, 'morning note', 'Morning note');
  await expect(page.getByRole('status').filter({ hasText: "Sam's morning note: Fill the empty sections" })).toBeVisible({ timeout: 15_000 });
  const today = (await (await page.request.get('/api/today')).json()) as { items: { kind: string; reason: string }[] };
  expect(today.items[0]).toMatchObject({ kind: 'morning-note', reason: expect.stringContaining('From your partner') });

  await bar(page, 'needs', 'Needs you');
  const needs = page.getByRole('dialog', { name: 'Needs you' });
  const row = needs.locator('.needs__item--morning-note');
  await expect(row).toContainText('Sam left you the morning note');
  await row.getByRole('button', { name: 'Done' }).click();
  await expect(row).toHaveCount(0);

  await page.keyboard.press('Escape');
  await bar(page, 'bets', 'Bets');
  const bets = page.getByRole('dialog', { name: 'Bets' });
  await expect(bets).toContainText('Morning note');
  await expect(bets).toContainText('No bets yet');
});

// A promise the founder makes in any room is kept, dated, and comes to Needs you and Today's five on its day; the
// founder closes it there.
test('the command bar adds the partner by the name typed, with Enter pressed at once', async ({ page }) => {
  // Typed fast: no wait between the words and Enter. The dock asks for "add partner" on its own renders, which once
  // left the bar running the plain "Add your partner" and a partner called Partner.
  await page.keyboard.press('Control+k');
  const input = page.getByRole('combobox', { name: 'Command or search' });
  await input.fill('add a partner');
  await input.fill('add a partner called Sam');
  // The dock's partner button asks the same words with "add partner" whenever it redraws; done here the way it does it.
  await page.evaluate(async () => {
    const slices = (await import(/* @vite-ignore */ `${location.origin}/src/slices/index.ts`)) as { sliceCommands(): { when?(typed: string): boolean }[] };
    slices.sliceCommands().find((one) => one.when?.('add partner'));
  });
  await input.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: 'Sam is your partner' })).toBeVisible({ timeout: 15_000 });
  const partners = (await stageOf(page)).rooms.filter((room) => room.partner).map((room) => room.name);
  expect(partners).toEqual(['Sam']);
});

test('a promise the founder makes comes to Needs you on its day, and the founder closes it', async ({ page }) => {
  await page.request.post('/api/rooms/marketing/chat', { data: { text: 'OK. I\'ll call 5 beta users today.' } });
  const chat = (await (await page.request.get('/api/rooms/marketing/chat')).json()) as { text: string }[];
  expect(chat.at(-1)!.text).toMatch(/\*Kept as a promise: call 5 beta users today \(due \d{4}-\d{2}-\d{2}\)\. It comes to Needs you on the day\.\*$/);
  const today = (await (await page.request.get('/api/today')).json()) as { items: { kind: string; reason: string }[] };
  expect(today.items.find((one) => one.kind === 'promise')).toMatchObject({ reason: expect.stringContaining('Something you said you would do') });

  await bar(page, 'needs', 'Needs you');
  const row = page.getByRole('dialog', { name: 'Needs you' }).locator('.needs__item--promise');
  await expect(row).toContainText('You said you would call 5 beta users today');
  await expect(row).toContainText('Due today.');
  await row.getByRole('button', { name: 'Done' }).click();
  await expect(row).toHaveCount(0);
});

// Journey 13: Tom's Unit Economics had a net burn of €1,380, the €534 a month the boxes cost left out, worked out with
// calc so nothing stopped it, and the partner never looked. Now Sam reads a colleague's finished doc on the next tick,
// unasked: the wrong figure comes to Needs you with the right working, and Fix sends the colleague the ask.
test('the partner reviews a colleague\'s doc unasked, and Fix sends the colleague the ask', async ({ page }) => {
  test.setTimeout(120_000);
  await bar(page, 'add a partner called Sam', 'Add Sam, your partner');
  await expect(page.getByRole('status').filter({ hasText: 'Sam is your partner' })).toBeVisible({ timeout: 15_000 });
  const company = ((await (await page.request.get('/api/docs/company-brief')).json()) as { text: string }).text;
  const numbers = '- Paying offices: 3\n- Price: €240 a month per office\n- Produce + delivery cost: €41 per box, about €178 a month per office\n- MRR: €720\n- Cash: €12,000\n- Burn: €2,100 a month\n';
  await page.request.put('/api/docs/company-brief', { data: { text: company.replace(/## Numbers\n[\s\S]*?(?=\n## |$)/, `## Numbers\n\n${numbers}`) } });

  const calc = JSON.stringify({ expression: 'burn - mrr', values: 'burn=2100, mrr=720' });
  const doc = JSON.stringify({ title: 'Unit Economics', text: '# Unit Economics\n\n- Net burn at current MRR (€720): €1,380 per month' });
  await page.request.post('/api/rooms/marketing/chat', { data: { text: `/tool calc ${calc}\n/tool create_doc ${doc}` } });
  const chat = async () => (await (await page.request.get('/api/rooms/marketing/chat')).json()) as { role: string; text: string; from?: string }[];
  await expect.poll(async () => (await chat()).find((one) => one.from === 'Sam')?.text ?? '', { timeout: 45_000 })
    .toContain('Net burn is €1,914 a month, not €1,380: 2100 - 3 * (240 - 178) = 1,914 (calc)');
  // The line in Maya's room is Sam's review of her doc, not a question Sam asked (journey 16: "SAM ASKED").
  await expect(page.locator('.react-flow__node[data-id="marketing"] .msg--colleague').filter({ hasText: 'Unit Economics' }).last()).toContainText('Sam reviewed your doc');

  await bar(page, 'needs', 'Needs you');
  const row = page.getByRole('dialog', { name: 'Needs you' }).locator('.needs__item--review-flag');
  await expect(row).toContainText('Sam reviewed a team doc');
  await expect(row).toContainText('Sam flagged: Maya\'s "Unit Economics". Fix first: net burn is €1,914 a month, not €1,380.');
  await expect(row).toContainText('it leaves out what the 3 paying offices cost (€534 a month)');
  await row.getByRole('button', { name: 'Fix' }).click();
  await expect.poll(async () => (await chat()).filter((one) => one.role === 'user' && !one.from).at(-1)?.text ?? '', { timeout: 15_000 })
    .toMatch(/^Please fix "Unit Economics" before I act on it: Net burn is €1,914 a month, not €1,380/);
  await expect.poll(async () => ((await (await page.request.get('/api/attention')).json()) as { kind: string }[]).some((one) => one.kind === 'review-flag')).toBe(false);

  // The doc the check made goes with it.
  await page.goto('about:blank');
  const stage = await stageOf(page);
  const made = new Set(stage.docs.filter((one) => one.title === 'Unit Economics').map((one) => one.id));
  await page.request.put('/api/stage', { data: { ...stage, docs: stage.docs.filter((one) => !made.has(one.id)), wires: stage.wires.filter((wire) => !made.has(wire.from) && !made.has(wire.to)) } });
});

// The partner watch: the verdict's kill signal is "weekly signups below 5", kept as a check. A Signups reading of 4
// comes in on the Metrics card, the watch looks (the tick does this on a real run), and Needs you shows Sam's own
// proposal, unasked, with the number and a ready task; Run puts it on a board.
test('a reading below the kill line wakes the partner: Sam proposes, with the number and Run or Don\'t', async ({ page }) => {
  const dayOf = (back: number) => { const day = new Date(Date.now() - back * 86_400_000); return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`; };
  await bar(page, 'add a partner called Sam', 'Add Sam, your partner');
  await expect(page.getByRole('status').filter({ hasText: 'Sam is your partner' })).toBeVisible({ timeout: 15_000 });
  const sam = (await stageOf(page)).rooms.find((room) => room.name === 'Sam')!;
  const stage = await (await page.request.get('/api/stage')).json();
  await page.request.put('/api/stage', { data: { ...stage, cards: [...(stage.cards ?? []), { id: 'metrics-watch', kind: 'metrics', title: 'Numbers', x: 2400, y: 0, w: 380, h: 440 }] } });
  await writeFile(join(WORKSPACE, 'promises.json'), JSON.stringify({ promises: [{ id: 'promise-kill', what: 'weekly signups below 5', due: dayOf(-20), said: dayOf(7), at: Date.now() - 7 * 86_400_000, roomId: sam.id, status: 'open', check: true }] }));
  try {
    await page.request.post('/api/metrics/metrics-watch/import', { data: { text: `date,Signups\n${dayOf(7)},6\n${dayOf(0)},4`, name: 'pasted' } });
    // The card's file is written a moment after the answer: the watch looks until it reads the new number.
    await expect.poll(async () => ((await (await page.request.post('/api/partner/watch')).json()) as { made: unknown[] }).made.length + ((await (await page.request.get('/api/partner/watch')).json()) as { proposals: unknown[] }).proposals.length, { timeout: 10_000 }).toBeGreaterThan(0);

    await bar(page, 'needs', 'Needs you');
    const row = page.getByRole('dialog', { name: 'Needs you' }).locator('.needs__item--partner-proposal');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('Sam proposes:');
    await expect(row).toContainText('Unasked · Signups crossed the kill line.');
    await expect(row).toContainText(`Signups: 4 on ${dayOf(0)}, from 6 on ${dayOf(7)}; the kill line is 5`);
    await expect(row).toContainText('Ready: the task');
    await expect(row.getByRole('button', { name: "Don't" })).toBeVisible();
    // A second look raises no second row.
    await page.request.post('/api/partner/watch');
    await expect(row).toHaveCount(1);
    await row.getByRole('button', { name: 'Run' }).click();
    await expect(row).toHaveCount(0);
    const board = ((await (await page.request.get('/api/stage')).json()).cards as { id: string; kind: string }[]).find((card) => card.kind === 'board');
    expect(board).toBeTruthy();
  } finally {
    const now = await (await page.request.get('/api/stage')).json();
    await page.request.put('/api/stage', { data: { ...now, cards: (now.cards ?? []).filter((card: { id: string; kind: string }) => card.id !== 'metrics-watch' && !(card.kind === 'board' && !(stage.cards ?? []).some((one: { id: string }) => one.id === card.id))) } });
  }
});

// Journey 16: a lead asked "Can you deliver on Thursday instead of Sunday? And are the meals nut-free?" and Sam's ready
// reply promised both. The fake partner says yes to each question as a careless model would; Needs you shows the reply
// with neither promise in it and a line saying what was left out.
test('a lead\'s reply wakes the partner, and the ready answer promises nothing the record does not say', async ({ page }) => {
  const LEADS = 'leads-watch-e2e';
  await bar(page, 'add a partner called Sam', 'Add Sam, your partner');
  await expect(page.getByRole('status').filter({ hasText: 'Sam is your partner' })).toBeVisible({ timeout: 15_000 });
  const stage = await (await page.request.get('/api/stage')).json();
  await page.request.put('/api/stage', { data: { ...stage, cards: [...(stage.cards ?? []), { id: LEADS, kind: 'leads', x: 2400, y: 0, w: 900, h: 460 }] } });
  try {
    const lead = (await (await page.request.post(`/api/leads/${LEADS}`, { data: { name: 'Anna Kowalski', company: 'St. Marien Hospital', email: 'anna@marien.example' } })).json()) as { id: string };
    await page.request.patch(`/api/leads/${LEADS}/${lead.id}`, { data: { stage: 'contacted' } });
    // The first look only learns where every lead stands.
    await page.request.post('/api/partner/watch');
    await page.request.post(`/api/leads/${LEADS}/${lead.id}/replied`, { data: { text: 'Three of us on the night ward would try it. Can you deliver on Thursday instead of Sunday? And are the meals nut-free? Anna' } });
    await expect.poll(async () => ((await (await page.request.post('/api/partner/watch')).json()) as { made: unknown[] }).made.length + ((await (await page.request.get('/api/partner/watch')).json()) as { proposals: unknown[] }).proposals.length, { timeout: 10_000 }).toBeGreaterThan(0);

    await bar(page, 'needs', 'Needs you');
    const row = page.getByRole('dialog', { name: 'Needs you' }).locator('.needs__item--partner-proposal');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('Ready: an email to anna@marien.example');
    await expect(row).toContainText('(left out: nothing on record about delivery on Thursday, nut-free)');
    // One row for the reply: Sam's ready answer settles the plain "Draft an answer?" ask for Anna.
    await expect(page.getByRole('dialog', { name: 'Needs you' }).locator('.needs__item--lead-replied')).toHaveCount(0);
    await expect(row).not.toContainText('we can deliver on Thursday');
    await expect(row).not.toContainText('are nut-free');
  } finally {
    for (const one of ((await (await page.request.get(`/api/leads/${LEADS}`)).json()) as { leads: { id: string }[] }).leads ?? []) await page.request.delete(`/api/leads/${LEADS}/${one.id}`);
    const now = await (await page.request.get('/api/stage')).json();
    await page.request.put('/api/stage', { data: { ...now, cards: (now.cards ?? []).filter((card: { id: string }) => card.id !== LEADS) } });
  }
});

// Journey 16: the founder put two inputs right in chat (11 of 14 pay; €59 is a week's price) and the stored call never
// heard it; the next morning's refresh said "stop". Now the correction is kept in code with the founder's words, the
// call made on the numbers before is stale, and the next morning's look quotes the old call and what changed, with
// break-even worked from the one picture of the numbers.
test('the founder\'s correction makes the verdict stale, and the next morning\'s refresh quotes it', async ({ page }) => {
  test.setTimeout(120_000);
  await bar(page, 'add a partner called Sam', 'Add Sam, your partner');
  await expect(page.getByRole('status').filter({ hasText: 'Sam is your partner' })).toBeVisible({ timeout: 15_000 });
  const sam = (await stageOf(page)).rooms.find((room) => room.name === 'Sam')!;
  const company = ((await (await page.request.get('/api/docs/company-brief')).json()) as { text: string }).text;
  const numbers = '- Price: €59 per subscriber\n- Subscribers: 14\n- Paying subscribers: 14\n- Cash: €6,000\n- Burn: €1,900 a month\n';
  await page.request.put('/api/docs/company-brief', { data: { text: company.replace(/## Numbers\n[\s\S]*?(?=\n## |$)/, `## Numbers\n\n${numbers}`) } });
  const chat = async () => (await (await page.request.get(`/api/rooms/${sam.id}/chat`)).json()) as { role: string; text: string }[];
  const said = async () => (await chat()).filter((one) => one.role === 'assistant').at(-1)?.text ?? '';
  try {
    await page.request.post(`/api/rooms/${sam.id}/chat`, { data: { text: 'Your verdict: keep going, pivot or stop?' } });
    await expect.poll(said, { timeout: 30_000 }).toContain('My call: **keep going**.');
    await page.request.post(`/api/rooms/${sam.id}/chat`, { data: { text: 'No, 14 subscribers is not 14 paying, 11 pay. And €59 is per week, not per month.' } });
    await expect.poll(said, { timeout: 30_000 }).toContain('*Taken as the numbers: paying 11; price a week (your words).');
    expect(await said()).toContain('so it is stale: I make it again on the next look.*');
    // The next morning: the stale call is looked at again, unasked.
    await advanceDay(page, 1);
    await expect.poll(async () => (await chat()).some((one) => one.text.includes('I said keep going at 14 paying subscribers')), { timeout: 30_000 }).toBe(true);
    const refresh = (await chat()).find((one) => one.text.includes('I said keep going at 14 paying subscribers'))!.text;
    expect(refresh).toContain('now break-even is 8 paying subscribers and the company has 11, cash-positive: still keep going.');
    expect(refresh).toContain('Since then: price €59 a month → €59 a week (founder: "And €59 is per week, not per month"); paying subscribers 14 → 11 (founder: "No, 14 subscribers is not 14 paying, 11 pay").');
    expect(refresh).not.toMatch(/wind|\bstop\b/i);
  } finally {
    await resetClock(page);
  }
});
