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

// Browser, project, board, note, picture and link cards sit behind the dock's plus button.
async function addCard(page: Page, name: string) {
  await page.getByRole('button', { name: 'More cards' }).click();
  await page.getByRole('menuitem', { name }).click();
}

// Journeys share one workspace, so the stage fills up. A journey that draws wires starts from the four seed cards again
// (conversations and docs stay; removed cards go to the workspace trash, as they would for the founder).
async function tidy(page: Page) {
  const stage = await (await page.request.get('/api/stage')).json();
  const keep = new Set(['marketing', 'build', 'brand-doc', 'company-brief']);
  await page.request.put('/api/stage', { data: {
    rooms: stage.rooms.filter((room: { id: string }) => keep.has(room.id)).map((room: object) => ({ ...room, model: undefined })),
    docs: stage.docs.filter((doc: { id: string }) => keep.has(doc.id)), cards: [],
    wires: stage.wires.filter((wire: { id: string }) => wire.id === 'marketing-brand-doc'),
  } });
  await page.reload();
  await expect(node(page, 'marketing')).toBeVisible();
}

// Draws a wire between two cards. Journeys share one stage, so by the later ones a handle may sit under another card or
// off screen: bring both ends into view, then try each side until a wire appears.
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

async function ask(page: Page, room: string, text: string) {
  await node(page, room).locator('.ask textarea').fill(text);
  await node(page, room).locator('.ask textarea').press('Enter');
  const reply = node(page, room).locator('.msg--assistant').last();
  await expect(reply).toContainText(`You said: "${text}"`);
  await expect(node(page, room).locator('.status--idle')).toBeVisible();
  return reply;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(node(page, 'marketing')).toBeVisible();
});

test('shows two rooms, a doc and the company brief, one wire, a dock with usage rings and nothing else', async ({ page }) => {
  await expect(page.locator('.react-flow__node')).toHaveCount(4);
  await expect(page.locator('.dock button')).toHaveCount(4);
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  await expect(node(page, 'marketing')).toContainText('Maya');
  await expect(node(page, 'brand-doc').locator('textarea.doc')).toHaveValue(/# Brand/);
  await expect(page.locator('.react-flow__minimap, .react-flow__controls, .react-flow__attribution')).toHaveCount(0);
});

test('the wallpaper stays still while the cards pan', async ({ page }) => {
  const stage = page.locator('.stage');
  const snapshot = () => stage.evaluate((el) => `${getComputedStyle(el).backgroundPosition}|${JSON.stringify(el.getBoundingClientRect())}`);
  const before = (await node(page, 'marketing').boundingBox())!;
  const wallpaperBefore = await snapshot();
  await drag(page, { x: 20, y: 20 }, { x: 220, y: 140 });
  expect((await node(page, 'marketing').boundingBox())!.x - before.x).toBeGreaterThan(150);
  expect(await snapshot()).toBe(wallpaperBefore);
});

test('a person answers in their room and reads only the docs wired to it', async ({ page }) => {
  await expect(await ask(page, 'marketing', 'three taglines')).toContainText('Maya here');
  await expect(node(page, 'marketing').locator('.msg--assistant').last()).toContainText('Docs I can read: Company brief, Brand doc.');
  await expect(node(page, 'marketing').locator('.card__doing')).toHaveText('three taglines');
  await expect(await ask(page, 'build', 'what first')).toContainText('Docs I can read: Company brief.');
});

test('typing, scrolling and dragging inside a card never move the canvas', async ({ page }) => {
  const before = (await node(page, 'marketing').boundingBox())!;
  const chat = centre((await node(page, 'marketing').locator('.chat').boundingBox())!);
  await page.mouse.move(chat.x, chat.y);
  await page.mouse.wheel(0, -400);
  await drag(page, chat, { x: chat.x + 120, y: chat.y + 60 });
  await node(page, 'marketing').locator('.ask textarea').pressSequentially('wasd ');
  const after = (await node(page, 'marketing').boundingBox())!;
  expect([after.x, after.y, after.width]).toEqual([before.x, before.y, before.width]);
});

test('layout, doc text and conversation survive a reload', async ({ page }) => {
  const bar = (await node(page, 'brand-doc').locator('.card__header').boundingBox())!;
  const header = { x: bar.x + bar.width * 0.55, y: bar.y + bar.height / 2 }; // the empty part of the header, between the title and the buttons
  await drag(page, header, { x: header.x + 90, y: header.y + 40 });
  await node(page, 'brand-doc').locator('textarea.doc').fill('We sell calm.');
  await ask(page, 'marketing', 'remember me');
  await expect.poll(async () => (await (await page.request.get('/api/stage')).json()).docs[0].x).toBeGreaterThan(560);
  await expect.poll(async () => (await (await page.request.get('/api/docs/brand-doc')).json()).text).toBe('We sell calm.');

  await page.reload();
  await expect(node(page, 'brand-doc').locator('textarea.doc')).toHaveValue('We sell calm.');
  await expect(node(page, 'marketing').locator('.msg--user').last()).toHaveText('remember me');
});

test('drawing a wire to a doc lets that person read it', async ({ page }) => {
  const from = centre((await handle(page, 'build', 'r').boundingBox())!);
  const to = centre((await handle(page, 'brand-doc', 'b').boundingBox())!);
  await drag(page, from, to, 20);
  await expect(page.locator('.react-flow__edge')).toHaveCount(2);
  await expect.poll(async () => (await (await page.request.get('/api/stage')).json()).wires.length).toBe(2);
  await expect(await ask(page, 'build', 'now what')).toContainText('Docs I can read: Company brief, Brand doc.');
});

test('screenshots and frame rate', async ({ page }, info) => {
  await page.waitForTimeout(500);
  await page.screenshot({ path: '.shots/1-fit.png' });
  await page.evaluate(() => {
    const w = window as unknown as { __frames: number; __t0: number };
    w.__frames = 0; w.__t0 = performance.now();
    const tick = () => { w.__frames += 1; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  const header = centre((await node(page, 'marketing').locator('.card__header').boundingBox())!);
  await drag(page, header, { x: header.x + 300, y: header.y + 120 }, 90);
  const fps = await page.evaluate(() => {
    const w = window as unknown as { __frames: number; __t0: number };
    return (w.__frames * 1000) / (performance.now() - w.__t0);
  });
  console.log(`drag fps: ${fps.toFixed(1)}`);
  info.annotations.push({ type: 'fps', description: fps.toFixed(1) });
  expect(fps).toBeGreaterThan(30);
});

const stageNow = async (page: Page) => (await page.request.get('/api/stage')).json();

test('a person can be added, talked to, edited and removed', async ({ page }) => {
  await page.getByRole('button', { name: 'Add person' }).click();
  const card = page.locator('.react-flow__node', { has: page.locator('form.setup') });
  await expect(card.getByRole('button', { name: 'Done' })).toBeDisabled();
  await card.getByLabel('Name').fill('Rio');
  await card.getByLabel('Role').fill('Sales');
  await card.getByLabel('What they do for you').fill('Finds the first ten customers.');
  await card.getByRole('button', { name: 'Done' }).click();

  const rio = page.locator('.react-flow__node', { hasText: 'Rio' });
  await rio.locator('.ask textarea').fill('who first');
  await rio.locator('.ask textarea').press('Enter');
  await expect(rio.locator('.msg--assistant').last()).toContainText('Rio here');
  await expect.poll(async () => (await stageNow(page)).rooms.map((room: { name: string }) => room.name)).toContain('Rio');

  await page.reload();
  await expect(rio.locator('.msg--user').last()).toHaveText('who first');
  await rio.locator('.card__header').hover();
  await rio.getByRole('button', { name: 'Edit', exact: true }).click();
  await rio.getByLabel('Name').fill('Ria');
  await rio.getByRole('button', { name: 'Done' }).click();
  const ria = page.locator('.react-flow__node', { hasText: 'Ria' });
  await expect(ria.locator('.card__name')).toContainText('Ria · Sales');

  await ria.locator('.card__header').hover();
  await ria.getByRole('button', { name: 'Remove' }).first().click();
  await ria.getByRole('alertdialog').getByRole('button', { name: 'Keep' }).click();
  await expect(ria).toBeVisible();
  await ria.getByRole('button', { name: 'Remove' }).first().click();
  await ria.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click();
  await expect(ria).toHaveCount(0);
  await expect.poll(async () => (await stageNow(page)).rooms.length).toBe(2);
  await page.reload();
  await expect(page.locator('.react-flow__node', { hasText: 'Ria' })).toHaveCount(0);
});

test('a doc can be added, named, written and removed', async ({ page }) => {
  const docsBefore = (await stageNow(page)).docs.length;
  await page.getByRole('button', { name: 'Add doc' }).click();
  const title = page.locator('input.card__title-input[value="Untitled doc"]');
  await title.fill('Pricing');
  const card = page.locator('.react-flow__node', { has: page.locator('input.card__title-input[value="Pricing"]') });
  await card.locator('textarea.doc').fill('Nine dollars a month.');
  await expect.poll(async () => (await stageNow(page)).docs.map((doc: { title: string }) => doc.title)).toContain('Pricing');

  await page.reload();
  await expect(card.locator('textarea.doc')).toHaveValue('Nine dollars a month.');
  await card.locator('.card__header').hover();
  await card.getByRole('button', { name: 'Remove' }).first().click();
  await card.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click();
  await expect.poll(async () => (await stageNow(page)).docs.length).toBe(docsBefore);
});

const send = async (page: Page, room: string, text: string) => {
  await expect(node(page, room).locator('.status--idle')).toBeVisible();
  await node(page, room).locator('.ask textarea').fill(text);
  await node(page, room).locator('.ask textarea').press('Enter');
};

test('a person rewrites a wired doc: the chip shows it, the doc card updates, the old text is kept', async ({ page }) => {
  await send(page, 'marketing', '/tool write_doc {"doc":"Brand doc","text":"# Brand\\n\\nCalm tools for founders."}');
  const reply = node(page, 'marketing').locator('.msg--assistant').last();
  await expect(reply.locator('.chip--ok summary')).toHaveText('Rewrote Brand doc');
  await expect(reply).toContainText(/Tool said: Wrote \d+ characters\./);
  await expect(node(page, 'brand-doc').locator('textarea.doc')).toHaveValue('# Brand\n\nCalm tools for founders.');
  await expect(reply.locator('.msg__foot')).toContainText('fake · fake-1 ·');
  await expect(reply.locator('.msg__foot')).toContainText('tokens');

  await page.reload();
  await expect(node(page, 'marketing').locator('.chip--ok summary')).toHaveText('Rewrote Brand doc');
  await expect(node(page, 'brand-doc').locator('textarea.doc')).toHaveValue('# Brand\n\nCalm tools for founders.');
});

test('a failed tool call shows as such and the person says what went wrong', async ({ page }) => {
  await send(page, 'build', '/tool write_doc {"doc":"Secret plan","text":"mine now"}');
  await expect(node(page, 'build').locator('.chip--fail summary')).toContainText('Could not: rewriting Secret plan');
  await expect(node(page, 'build').locator('.msg--assistant').last()).toContainText('no connected document is called "Secret plan"');
});

test('a person creates a doc: the card appears beside them, wired, and survives a reload', async ({ page }) => {
  await expect(page.locator('.react-flow__edge').first()).toBeAttached();
  const wires = await page.locator('.react-flow__edge').count();
  const docs = await page.locator('.react-flow__node-doc').count();
  await send(page, 'build', '/tool create_doc {"title":"Build plan","text":"1. Ship the stage"}');
  await expect(node(page, 'build').locator('.chip--ok summary')).toHaveText('Created Build plan');
  const card = page.locator('.react-flow__node-doc', { has: page.locator('input[value="Build plan"]') });
  await expect(card.locator('textarea.doc')).toHaveValue('1. Ship the stage');
  await expect(page.locator('.react-flow__edge')).toHaveCount(wires + 1);
  await expect.poll(async () => (await (await page.request.get('/api/stage')).json()).docs.length).toBe(docs + 1);
  await expect(await ask(page, 'build', 'what can you read')).toContainText('Build plan');

  await page.reload();
  await expect(page.locator('.react-flow__node-doc')).toHaveCount(docs + 1);
});

test('replies render markdown', async ({ page }) => {
  await send(page, 'marketing', '/markdown please');
  const reply = node(page, 'marketing').locator('.msg--assistant').last();
  await expect(reply.locator('strong')).toHaveText('Bold plan');
  await expect(reply.locator('li')).toHaveCount(2);
});

test('a reply can be stopped, and what was said is kept', async ({ page }) => {
  await send(page, 'marketing', '/slow tell me everything about the launch');
  const room = node(page, 'marketing');
  await expect(room.locator('.msg--assistant').last()).toContainText('Maya here');
  await room.getByRole('button', { name: 'Stop' }).click();
  await expect(room.locator('.status--idle')).toBeVisible();
  await expect(room.getByRole('button', { name: 'Send' })).toBeVisible();
  await expect(room.locator('.msg__foot').last()).toContainText('stopped');
  const kept = await room.locator('.msg--assistant').last().innerText();
  expect(kept).not.toContain('Docs I can read');

  await page.reload();
  await expect(node(page, 'marketing').locator('.msg__foot').last()).toContainText('stopped');
  await expect(await ask(page, 'marketing', 'still there?')).toContainText('Maya here');
});

test('the dock shows today\'s model usage and a person can be pinned to a model', async ({ page }) => {
  await ask(page, 'marketing', 'hello');
  await page.getByRole('button', { name: 'Model usage today' }).click();
  const detail = page.getByRole('dialog', { name: 'Model usage today' });
  await expect(detail).toContainText('fake');
  await expect(detail).toContainText(/\d+% left/);
  await expect(detail).toContainText(/\d+ replies · [\d,]+ tokens/);

  await node(page, 'marketing').hover();
  await node(page, 'marketing').getByRole('button', { name: 'Edit', exact: true }).click();
  await node(page, 'marketing').locator('select').selectOption('fake');
  await node(page, 'marketing').getByRole('button', { name: 'Done' }).click();
  await expect.poll(async () => (await (await page.request.get('/api/stage')).json()).rooms[0].model).toBe('fake');
  await expect(await ask(page, 'marketing', 'again')).toContainText('Maya here');
});

test('a person searches and reads the web, several at once', async ({ page }) => {
  await send(page, 'marketing', '/tool web_search {"queries":["calm software","founder tools"]}');
  const reply = node(page, 'marketing').locator('.msg--assistant').last();
  await expect(reply.locator('.chip--ok summary')).toHaveText('Searched 2 queries at once');
  await expect(reply).toContainText('https://example.com/');
  await send(page, 'marketing', '/tool web_fetch {"urls":["https://example.com"]}');
  await expect(node(page, 'marketing').locator('.chip--ok summary').last()).toHaveText('Read https://example.com');
});

test('a browser card can be added; only a wired person can drive it, and never to this machine', async ({ page }) => {
  await tidy(page);
  await send(page, 'build', '/tool browse {"action":"open","url":"https://example.com"}');
  await expect(node(page, 'build').locator('.chip--fail').last()).toBeVisible();
  await expect(node(page, 'build').locator('.msg--assistant').last()).toContainText('no browser card is connected');

  await addCard(page, 'Add browser');
  const card = page.locator('.react-flow__node-browser');
  await expect(card).toContainText('Wire a person to this browser');
  const id = (await card.getAttribute('data-id'))!;
  await page.waitForTimeout(600); // the view glides to the new card; handles sit still after that
  await wire(page, 'build', id);
  await expect.poll(async () => (await (await page.request.get('/api/stage')).json()).cards?.length).toBe(1);

  await send(page, 'build', '/tool browse {"action":"open","url":"https://example.com"}');
  await expect(node(page, 'build').locator('.chip--ok summary').last()).toHaveText('Browsed open https://example.com');
  await expect(node(page, 'build').locator('.msg--assistant').last()).toContainText('[ref=e1]');
  await send(page, 'build', '/tool browse {"action":"open","url":"http://127.0.0.1:7431/api/stage"}');
  await expect(node(page, 'build').locator('.msg--assistant').last()).toContainText('cannot be opened');

  await card.hover();
  await card.getByRole('button', { name: 'Show window' }).click();
  await expect(card.getByRole('button', { name: 'Window shown' })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await (await page.request.get('/api/stage')).json()).cards[0].headed).toBe(true);

  await page.reload();
  await expect(page.locator('.react-flow__node-browser')).toHaveCount(1);
  await expect(page.locator('.react-flow__node-browser').getByRole('button', { name: 'Window shown' })).toBeVisible();
});

test('an email waits for the founder, who can edit it, then it goes; saying no sends nothing', async ({ page }) => {
  await send(page, 'marketing', '/tool send_email {"to":"lead@example.com","subject":"Hello","body":"Hi there"}');
  const room = node(page, 'marketing');
  const ask = room.getByRole('group', { name: 'Send this email?' });
  await expect(ask).toBeVisible();
  await expect(room.locator('.card__doing')).toHaveText('needs your OK');
  await ask.getByLabel('Subject').fill('Hello from Cubicle');
  await ask.getByRole('button', { name: 'Send' }).click();
  const chip = room.locator('.chip--ok').last();
  await expect(chip.locator('summary')).toHaveText('Emailed lead@example.com');
  await expect(room.locator('.msg--assistant').last()).toContainText('Sent from person@agentmail.test.');
  await chip.locator('summary').click();
  await expect(chip.locator('pre')).toContainText('Hello from Cubicle');

  await send(page, 'marketing', '/tool send_email {"to":"lead@example.com","subject":"Again","body":"Second"}');
  await room.getByRole('group', { name: 'Send this email?' }).getByRole('button', { name: "Don't" }).click();
  await expect(room.locator('.chip--fail summary').last()).toContainText('Could not');
  await expect(room.locator('.msg--assistant').last()).toContainText('founder said no');
});

test('code runs only after the founder reads it, in the sandbox', async ({ page }) => {
  await send(page, 'build', '/tool run_code {"language":"javascript","code":"console.log(6 * 7)"}');
  const ask = node(page, 'build').getByRole('group', { name: 'Run this code?' });
  await expect(ask.getByLabel('Code')).toHaveValue('console.log(6 * 7)');
  await ask.getByRole('button', { name: 'Run' }).click();
  await expect(node(page, 'build').locator('.chip--ok summary').last()).toHaveText('Ran javascript code');
  await expect(node(page, 'build').locator('.msg--assistant').last()).toContainText('Tool said: 42');
});

test('a project card: a wired person hands coding work to an agent after the founder says start', async ({ page }) => {
  await tidy(page);
  await addCard(page, 'Add project folder');
  const card = page.locator('.react-flow__node-project');
  await expect(card).toContainText('Set the folder');
  const id = (await card.getAttribute('data-id'))!;
  await card.getByLabel('Project folder').fill('/usr/share');
  await expect(card.locator('.card__name')).toHaveText('share');
  await page.waitForTimeout(600);
  await wire(page, 'build', id);

  await send(page, 'build', '/tool delegate_coding {"task":"Add a health check endpoint"}');
  const ask = node(page, 'build').getByRole('group', { name: 'Start this coding task?' });
  await expect(ask).toContainText('Start this coding task in /usr/share?');
  await ask.getByRole('button', { name: 'Start' }).click();
  await expect(node(page, 'build').locator('.chip--ok summary').last()).toHaveText('Coded: Add a health check endpoint');
  await expect(card.locator('.project__log')).toContainText('edit src/example.ts');
  await expect(card.locator('.project__log')).toContainText('done · 1 file changed');
  await expect(node(page, 'build').locator('.msg--assistant').last()).toContainText('Changed: src/example.ts');
});

test('a pinned doc is read by everyone; unpinning takes it away again', async ({ page }) => {
  const brief = node(page, 'company-brief');
  await expect(brief.locator('.doc__all')).toHaveText('all');
  await expect(await ask(page, 'build', 'what do you read')).toContainText('Company brief');
  await brief.hover();
  await brief.getByRole('button', { name: /^Unpin/ }).click();
  await expect(brief.locator('.doc__all')).toHaveCount(0);
  await expect(await ask(page, 'build', 'and now')).not.toContainText('Company brief');
  await brief.hover();
  await brief.getByRole('button', { name: /^Pin/ }).click();
  await expect.poll(async () => (await (await page.request.get('/api/stage')).json()).docs.find((doc: { id: string }) => doc.id === 'company-brief').pinned).toBe(true);
});

test('a wire between two people lets one consult the other; the exchange shows in both rooms', async ({ page }) => {
  await tidy(page);
  await send(page, 'marketing', '/tool ask_person {"name":"Dev","question":"How long for SSO?"}');
  await expect(node(page, 'marketing').locator('.msg--assistant').last()).toContainText('no colleague called "Dev"');

  await wire(page, 'marketing', 'build');

  await send(page, 'marketing', '/tool ask_person {"name":"Dev","question":"How long for SSO?"}');
  await expect(node(page, 'marketing').locator('.chip--ok summary').last()).toHaveText('Asked Dev');
  await expect(node(page, 'marketing').locator('.msg--assistant').last()).toContainText('Dev answered:');
  await expect(node(page, 'build').locator('.msg--colleague').last()).toContainText('Maya asked');
  await expect(node(page, 'build').locator('.msg--colleague').last()).toContainText('How long for SSO?');
  await expect(node(page, 'build').locator('.msg--assistant').last()).toContainText('Dev here.');
});

test('the board: a person proposes, the founder accepts, assigns and runs; an outward step waits on the task', async ({ page }) => {
  await tidy(page);
  await addCard(page, 'Add task board');
  const board = page.locator('.react-flow__node-board');
  await expect(board.getByRole('region', { name: 'To do' })).toBeVisible();
  const id = (await board.getAttribute('data-id'))!;
  await page.waitForTimeout(600);
  await wire(page, 'marketing', id);

  // a person proposes; nothing runs until the founder takes it
  await send(page, 'marketing', '/tool propose_task {"title":"Write the launch FAQ","detail":"Ten questions."}');
  const proposed = board.getByRole('region', { name: 'Proposed' }).getByRole('button', { name: /Write the launch FAQ/ });
  await expect(proposed).toContainText('from Maya');
  await proposed.click();
  const view = board.getByRole('dialog', { name: 'Write the launch FAQ' });
  await expect(view.getByRole('button', { name: 'Run' })).toBeDisabled();
  await view.getByRole('button', { name: 'Accept' }).click();
  await view.getByLabel('Assignee').selectOption({ label: 'Maya' });
  await expect(node(page, 'marketing').locator('.status--idle')).toBeVisible(); // a person does one thing at a time: her chat turn must be over
  await view.getByRole('button', { name: 'Run' }).click();
  await expect(view.locator('.taskview__result')).toContainText('Maya here.');
  await expect(view.locator('.taskview__log')).toContainText('Maya started');
  await view.getByRole('button', { name: 'Close task' }).click();
  await expect(board.getByRole('region', { name: 'Review' }).getByRole('button', { name: /Write the launch FAQ/ })).toBeVisible();

  // the founder adds a task with an outward step: it parks on the task until the founder says yes
  await board.getByLabel('New task').fill('Email the lead');
  await board.getByLabel('New task').press('Enter');
  await board.getByRole('region', { name: 'To do' }).getByRole('button', { name: /Email the lead/ }).click();
  const mail = board.getByRole('dialog', { name: 'Email the lead' });
  await mail.getByLabel('Task detail').fill('/tool send_email {"to":"lead@example.com","subject":"Hello","body":"Hi"}');
  await mail.getByLabel('Task title').click();
  await mail.getByLabel('Assignee').selectOption({ label: 'Maya' });
  await mail.getByLabel('Repeat').selectOption('week');
  await expect(mail.locator('.taskview__hint').last()).toContainText('Runs only while the app is open');
  await mail.getByRole('button', { name: 'Run' }).click();
  await expect(mail.getByRole('group', { name: 'Send this email?' })).toBeVisible();
  await expect(board.locator('.board__badge')).toHaveText('1 needs you');
  await mail.getByRole('group', { name: 'Send this email?' }).getByRole('button', { name: 'Send' }).click();
  await expect(mail.locator('.taskview__log')).toContainText('✓ send_email lead@example.com');
  await expect(board.locator('.board__badge')).toHaveCount(0);

  await page.reload();
  await expect(page.locator('.react-flow__node-board').getByRole('region', { name: 'Review' }).getByRole('button')).toHaveCount(2);
});

test('a person keeps notes the founder can read and rewrite, and sees them in later turns', async ({ page }) => {
  await send(page, 'build', '/tool remember {"fact":"The founder wants weekly releases."}');
  const room = node(page, 'build');
  await expect(room.locator('.chip--ok summary').last()).toHaveText('Remembered The founder wants weekly releases.');
  await expect(room.locator('.status--idle')).toBeVisible();
  await room.hover();
  await room.getByRole('button', { name: 'Memory' }).click();
  const panel = room.getByRole('dialog', { name: 'What Dev remembers' });
  await expect(panel.getByLabel('Notes')).toHaveValue('- The founder wants weekly releases.');
  await panel.getByLabel('Notes').fill('- The founder wants releases every two weeks.');
  await panel.getByRole('button', { name: 'Save' }).click();
  await expect(panel).toHaveCount(0);
  expect((await (await page.request.get('/api/rooms/build/memory')).json()).notes).toBe('- The founder wants releases every two weeks.');
});

test('a reply can be regenerated, a question edited and re-asked, a message deleted; nothing is lost', async ({ page }) => {
  const room = node(page, 'build');
  await ask(page, 'build', 'first question');
  await ask(page, 'build', 'second question');
  const before = await room.locator('.msg').count();
  await room.locator('.msg--assistant').last().hover();
  await room.getByRole('button', { name: 'Regenerate' }).click();
  await expect(room.locator('.status--idle')).toBeVisible();
  await expect(room.locator('.msg')).toHaveCount(before);
  await expect(room.locator('.msg--assistant').last()).toContainText('You said: "second question"');

  await room.locator('.msg--user').last().hover();
  await room.locator('.msg--user').last().getByRole('button', { name: 'Edit message' }).click();
  await expect(room.locator('.ask__editing')).toBeVisible();
  await room.locator('.ask textarea').fill('second question, sharper');
  await room.locator('.ask textarea').press('Enter');
  await expect(room.locator('.msg--assistant').last()).toContainText('You said: "second question, sharper"');
  await expect(room.locator('.status--idle')).toBeVisible();
  await expect(room.locator('.msg')).toHaveCount(before);

  await room.locator('.msg--assistant').last().hover();
  await room.locator('.msg--assistant').last().getByRole('button', { name: 'Delete message' }).click();
  await expect(room.locator('.msg')).toHaveCount(before - 1);
  await page.reload();
  await expect(node(page, 'build').locator('.msg')).toHaveCount(before - 1);
});

test('files can be attached: a text file is read, a picture is seen and shown', async ({ page }) => {
  const room = node(page, 'marketing');
  await room.locator('input[type=file]').setInputFiles({ name: 'plan notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Plan\nLaunch in October.') });
  await expect(room.locator('.ask__file')).toContainText('plan-notes.md');
  await send(page, 'marketing', 'read this');
  await expect(room.locator('.msg--assistant').last()).toContainText('Launch in October.');
  await expect(room.locator('.msg--user').last().locator('.attached a')).toContainText('plan-notes.md');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  await room.locator('input[type=file]').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: png });
  await send(page, 'marketing', 'what is this');
  await expect(room.locator('.msg--assistant').last()).toContainText('I can see 1 picture');
  await expect(room.locator('.msg--user').last().locator('.attached img')).toBeVisible();
});

test('replies render diagrams and a live, sandboxed page preview', async ({ page }) => {
  await send(page, 'marketing', '/rich show me');
  const reply = node(page, 'marketing').locator('.msg--assistant').last();
  await expect(reply.locator('.diagram svg')).toBeVisible({ timeout: 15000 });
  const frame = reply.locator('.artifact iframe');
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
  await expect(reply.frameLocator('.artifact iframe').locator('h1')).toHaveText('Landing page');
  await reply.getByRole('button', { name: 'Show code' }).click();
  await expect(reply.locator('.artifact pre')).toContainText('<!doctype html>');
});

test('a sticky note and a link are context for the person they are wired to', async ({ page }) => {
  await tidy(page);
  await addCard(page, 'Add sticky note');
  const note = page.locator('.react-flow__node-note');
  await note.getByLabel('Note').fill('Never discount below 15 dollars');
  await addCard(page, 'Add link');
  const link = page.locator('.react-flow__node-link');
  await link.getByLabel('Web address').fill('https://example.com');
  await link.getByLabel('Web address').press('Enter');
  await expect(link.locator('.card__name')).toHaveText('Example Domain');
  await expect(link.locator('p')).toContainText('This domain is for use in examples.');

  await page.waitForTimeout(600);
  for (const card of [note, link]) {
    const id = (await card.getAttribute('data-id'))!;
    await wire(page, 'build', id);
  }
  const reply = await ask(page, 'build', 'what do you know');
  await expect(reply).toContainText('Notes: Never discount below 15 dollars.');
  await expect(reply).toContainText('Pages: Example Domain.');
  await expect(await ask(page, 'marketing', 'and you')).not.toContainText('Never discount');

  await page.reload();
  await expect(page.locator('.react-flow__node-note').getByLabel('Note')).toHaveValue('Never discount below 15 dollars');
  await expect(page.locator('.react-flow__node-link .card__name')).toHaveText('Example Domain');
});

test('the api answers the app\'s own page and refuses everyone else', async ({ browser }) => {
  // No script token here: this is what the founder's window and any other web page really send.
  const context = await browser.newContext({ baseURL: 'http://localhost:7430', extraHTTPHeaders: {} });
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.locator('.react-flow__node-room').first()).toBeVisible();
  expect(await page.evaluate(async () => (await fetch('/api/stage')).status)).toBe(200);

  // A page on another site, asking the founder's browser to carry its request to the local server.
  const stranger = await context.newPage();
  await stranger.route('https://stranger.example/', (route) => route.fulfill({ contentType: 'text/html', body: '<title>stranger</title>' }));
  await stranger.goto('https://stranger.example/');
  const outcome = await stranger.evaluate(async () => {
    const tried = await fetch('http://localhost:7431/api/stage', { method: 'PUT', mode: 'no-cors', headers: { 'content-type': 'text/plain' }, body: '{"rooms":[],"docs":[],"wires":[]}' }).then(() => 'sent', () => 'blocked');
    return tried;
  });
  expect(['sent', 'blocked']).toContain(outcome);
  // Whatever the browser did with it, the stage is untouched, and a bare request gets nothing either.
  expect(await page.evaluate(async () => (await (await fetch('/api/stage')).json()).rooms.length)).toBeGreaterThan(0);
  const bare = await fetch('http://localhost:7431/api/stage');
  expect(bare.status).toBe(403);
  const rebound = await fetch('http://localhost:7431/api/stage', { headers: { host: 'stranger.example' } }).catch(() => null);
  expect(rebound?.status ?? 403).toBe(403);
  await context.close();
});

test('focus: a card fills the window and comes back with everything it held', async ({ page }) => {
  await tidy(page);
  const room = node(page, 'marketing');
  const sheet = page.locator('.focus__sheet');
  await expect(sheet).toBeHidden();

  // The header button moves the card itself into the sheet; the person's side column appears.
  await room.locator('.card__header').hover();
  await room.getByRole('button', { name: 'Focus' }).click();
  await expect(sheet.locator('.card--focused')).toBeVisible();
  expect((await sheet.locator('.card--focused').boundingBox())!.width).toBeGreaterThan(1000);
  await expect(sheet.locator('.side')).toContainText('Brand doc');
  await expect(sheet.locator('.side')).toContainText('reads and writes');
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(0);

  // A slow reply starts in the sheet; Escape returns to the stage while it is still streaming, and nothing is lost.
  await expect(sheet.getByPlaceholder('Ask Maya…')).toBeFocused();
  await sheet.getByPlaceholder('Ask Maya…').fill('/slow focus check');
  await sheet.getByPlaceholder('Ask Maya…').press('Enter');
  await expect(sheet.locator('.chat')).toContainText('Maya here');
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(room.locator('.chat')).toContainText('You said: "/slow focus check"', { timeout: 15_000 });
  await expect(sheet.locator('.side')).toHaveCount(0);

  // F focuses the selected card; an edit in progress takes the first Escape, the sheet the second.
  await room.locator('.card__header').click();
  await page.keyboard.press('f');
  await expect(sheet.locator('.card--focused')).toBeVisible();
  await expect(sheet.locator('.side')).toContainText('Replies');
  await sheet.locator('.msg--user').last().hover();
  await sheet.getByRole('button', { name: 'Edit message' }).last().click();
  await page.keyboard.press('Escape');
  await expect(sheet.locator('.card--focused')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();

  // A doc focuses too, at reading width, and what is typed there is the doc.
  const doc = node(page, 'brand-doc');
  await doc.locator('.card__header').hover();
  await doc.getByRole('button', { name: 'Focus' }).click();
  await sheet.locator('textarea').fill('Focused writing.');
  await sheet.getByRole('button', { name: 'Back to the stage' }).click();
  await expect(sheet).toBeHidden();
  await expect(doc.locator('textarea')).toHaveValue('Focused writing.');
  await expect.poll(async () => (await (await page.request.get('/api/docs/brand-doc')).json()).text).toBe('Focused writing.');
});
