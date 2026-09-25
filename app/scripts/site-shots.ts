// Screenshots for the product website, taken from the app itself so the site never drifts from it.
// It seeds a small stage in a throwaway workspace (three rooms, docs, a leads card, a video studio, two pages that
// changed), starts the app on its own ports with the fake model, and captures each view at desktop and phone size
// into site/media/ as WebP. Nothing of the founder's own workspace, keys or running app is touched.
//
//   cd app && node scripts/site-shots.ts
//
// Desktop gives the whole stage and a crop of each card on it; phone gives the app as a phone shows it. The app has
// one theme, dark, so each view is captured once; the site shows the same pictures in both of its themes.
// SITE_SHOTS_PORT moves the pair of ports (default 7530 for the page, 7531 for the api).
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Locator, type Page } from '@playwright/test';
import sharp from 'sharp';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(app, '..', 'site', 'media');
const port = Number(process.env.SITE_SHOTS_PORT ?? 7530);
const token = 'site-shots';
const base = `http://localhost:${port}`;
const now = Date.now();
const ago = (minutes: number) => now - minutes * 60_000;
let serial = 0;
const id = () => `seed-${++serial}`;

// ---- The seeded company: a made-up studio-booking product, so no real person or business appears. ----
const stage = {
  rooms: [
    { id: 'marketing', name: 'Maya', role: 'Marketing', accent: '#ee8a72', brief: 'You are the marketing lead: positioning, copy, launch, audience.', x: 0, y: 0, w: 400, h: 470 },
    { id: 'build', name: 'Dev', role: 'Build', accent: '#4e8cff', brief: 'You are the engineering lead: architecture, scope, build order, technical risk.', x: 0, y: 530, w: 400, h: 420 },
    { id: 'sales', name: 'Rafa', role: 'Sales', accent: '#5cc9a7', brief: 'You are the sales lead: who to sell to, first messages, follow-ups.', x: 1320, y: 470, w: 400, h: 420 },
  ],
  docs: [
    { id: 'brand-doc', title: 'Brand doc', x: 500, y: 20, w: 400, h: 260 },
    { id: 'company-brief', title: 'Company brief', pinned: true, x: 500, y: 330, w: 400, h: 240 },
  ],
  wires: [
    { id: 'marketing-brand-doc', from: 'marketing', fromHandle: 'r', to: 'brand-doc', toHandle: 'l' },
    { id: 'marketing-film', from: 'marketing', fromHandle: 'r', to: 'film', toHandle: 'l' },
    { id: 'sales-leads', from: 'sales', fromHandle: 't', to: 'leads', toHandle: 'b' },
    { id: 'build-roadmap', from: 'build', fromHandle: 'r', to: 'company-brief', toHandle: 'l' },
  ],
  cards: [
    { kind: 'leads', id: 'leads', x: 1000, y: 0, w: 720, h: 400 },
    { kind: 'videogen', id: 'film', brief: 'A 30 second explainer for pottery studios: stop taking class bookings by DM.', x: 500, y: 620, w: 400, h: 400 },
    { kind: 'note', id: 'roadmap', text: 'Ship waitlist export before the Friday demo.\nNo payments until ten studios say yes.', color: 'yellow', x: 1000, y: 470, w: 300, h: 120 },
  ],
};

const docs: Record<string, string> = {
  'brand-doc': '# Kiln Hours\n\nClass bookings for small pottery studios.\n\n**Voice:** warm, plain, never cute.\n**Promise:** your students book, pay a deposit and get reminded; you stop answering DMs at 11pm.\n',
  'company-brief': '# Company brief\n\nWe sell to studios with one to three teachers.\nPrice: free until ten studios pay.\nThis quarter: 40 studios on the waitlist.\n',
};

const tool = (name: string, args: Record<string, unknown>, result: string) => ({ id: id(), name, args, ok: true, result });
const chats: Record<string, unknown[]> = {
  marketing: [
    { id: id(), role: 'user', text: 'Draft a headline for the waitlist page. Keep it to the brand doc.', at: ago(42) },
    {
      id: id(), role: 'assistant', at: ago(41), provider: 'groq', model: 'llama-3.3-70b',
      tools: [tool('read_doc', { id: 'brand-doc' }, 'Kiln Hours: class bookings for small pottery studios…'), tool('web_search', { query: 'pottery studio booking complaints' }, '6 results')],
      text: 'Three options, in the brand voice:\n\n1. **Stop taking bookings by DM.**\n2. **Your classes fill. Your evenings stay yours.**\n3. **Bookings, deposits and reminders for small studios.**\n\nI would lead with the first. The six threads I read all complain about the same thing: chasing students in messages.',
    },
    { id: id(), role: 'user', text: 'Good. Make the 30 second film from the first one.', at: ago(12) },
    { id: id(), role: 'assistant', at: ago(11), provider: 'gemini', model: 'gemini-2.5-flash', tools: [tool('generate_video', { brief: 'Stop taking bookings by DM' }, 'started')], text: 'Started it in the video studio beside me. The draft is ready in about a minute; I will say when the full cut is done.' },
  ],
  build: [
    { id: id(), role: 'user', text: 'What do we need before the Friday demo?', at: ago(90) },
    { id: id(), role: 'assistant', at: ago(89), provider: 'groq', model: 'llama-3.3-70b', tools: [tool('read_file', { path: 'roadmap' }, 'note')], text: 'Two things from your note: the waitlist export and a clean empty state. Payments can wait, as the note says. I put both on the board as tasks.' },
  ],
  sales: [
    { id: id(), role: 'user', text: 'Who should we write to first?', at: ago(30) },
    { id: id(), role: 'assistant', at: ago(29), provider: 'groq', model: 'llama-3.3-70b', tools: [tool('list_leads', {}, '5 leads')], text: 'Start with Priya at Clayfield. She asked for exactly this in a forum thread last month, so the first message can quote her. I scored her 9 of 10.' },
  ],
};

const lead = (name: string, title: string, company: string, stageName: string, score?: number, why?: string, minutes = 300) => ({
  id: id(), person: { name, title }, company: { name: company, size: '1-10' }, stage: stageName,
  ...(score ? { fit: { score, why, at: ago(minutes) } } : {}), notes: [], source: 'person', addedAt: ago(minutes), updatedAt: ago(minutes / 2),
});
const leads = [
  lead('Priya Raman', 'Owner', 'Clayfield Studio', 'fit', 9, 'Asked for online booking in a forum thread', 400),
  lead('Tom Achebe', 'Teacher', 'Wheel & Kiln', 'contacted', 7, 'Runs four classes a week, books by Instagram', 900),
  lead('Lena Voss', 'Founder', 'Slip House', 'replied', 8, 'Replied: wants deposits', 1600),
  lead('Marco Bell', 'Owner', 'Riverbank Ceramics', 'new', undefined, undefined, 60),
  lead('June Park', 'Director', 'Fireside Clay', 'meeting', 9, 'Two teachers, a waitlist of 30', 3000),
];

// Two watched pages that changed: each is a row in Needs you and on the dashboard.
const watch = (room: string, title: string, url: string, diff: string, minutes: number) => [{
  id: id(), url, what: 'their prices', roomId: room, title, hash: 'x', text: '', addedAt: ago(60 * 48), checkedAt: ago(5), changedAt: ago(minutes), diff,
}];

async function seed(dir: string) {
  for (const sub of ['docs', 'rooms', 'leads', 'watch']) await mkdir(join(dir, sub), { recursive: true });
  await writeFile(join(dir, 'stage.json'), JSON.stringify(stage, null, 2));
  // The first-run checklist is for a founder's first day, not for a picture of the product.
  await writeFile(join(dir, 'missions.json'), JSON.stringify({ dismissed: true }));
  for (const [key, text] of Object.entries(docs)) await writeFile(join(dir, 'docs', `${key}.md`), text);
  for (const [key, list] of Object.entries(chats)) await writeFile(join(dir, 'rooms', `${key}.json`), JSON.stringify(list, null, 2));
  await writeFile(join(dir, 'leads', 'leads.json'), JSON.stringify(leads, null, 2));
  await writeFile(join(dir, 'watch', 'marketing.json'), JSON.stringify(watch('marketing', 'Rival pricing', 'https://rival.example/pricing', '+ Studio plan is now $29 a month', 20)));
  await writeFile(join(dir, 'watch', 'sales.json'), JSON.stringify(watch('sales', 'Kilnbook changelog', 'https://kilnbook.example/changelog', '+ Waitlists for classes', 70)));
}

async function up(url: string, headers: Record<string, string> = {}) {
  for (let tries = 0; tries < 240; tries++) {
    try { if ((await fetch(url, { headers })).ok) return; } catch { /* not yet */ }
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(`the app did not answer at ${url}`);
}

// The whole window. A desktop window is scaled back to its own width, which is plenty for the top of the page; a
// phone keeps its double density, since a phone shows it at that.
async function shot(page: Page, name: string, size: string) {
  await page.waitForTimeout(700); // let panels finish their entrance
  const png = await page.screenshot({ type: 'png' });
  const file = join(out, `${name}-${size}.webp`);
  await (size === 'desktop' ? sharp(png).resize({ width: page.viewportSize()!.width }) : sharp(png)).webp({ quality: 80 }).toFile(file);
  console.log('wrote', file);
}

// A part of the window around some cards, with a little of the stage showing round them, at full pixel density: a
// card read at the size the site shows it, rather than a whole window shrunk until nothing in it can be read.
async function crop(page: Page, name: string, around: Locator[], { most = 1200, pad = 28, below = pad } = {}) {
  await page.waitForTimeout(700);
  const parts = (await Promise.all(around.map((part) => part.all()))).flat();
  const boxes = (await Promise.all(parts.map((part) => part.boundingBox()))).filter((box) => box !== null);
  if (!boxes.length) throw new Error(`nothing to crop for ${name}`);
  const view = page.viewportSize()!;
  const x = Math.max(0, Math.min(...boxes.map((box) => box.x)) - pad);
  const y = Math.max(0, Math.min(...boxes.map((box) => box.y)) - pad);
  const right = Math.min(view.width, Math.max(...boxes.map((box) => box.x + box.width)) + pad);
  const bottom = Math.min(view.height, Math.max(...boxes.map((box) => box.y + box.height)) + below, y + most);
  const png = await page.screenshot({ type: 'png', clip: { x, y, width: right - x, height: bottom - y } });
  const file = join(out, `${name}.webp`);
  await sharp(png).webp({ quality: 82 }).toFile(file);
  console.log('wrote', file);
}

// Focus mode on one card, by its own Focus button (a phone-sized canvas may have the card off screen).
async function focus(page: Page, card: string) {
  await page.locator(`.react-flow__node[data-id="${card}"]`).getByRole('button', { name: 'Focus', exact: true }).dispatchEvent('click');
  await page.getByRole('dialog', { name: 'Focused card' }).waitFor();
}
async function unfocus(page: Page) {
  await page.keyboard.press('Escape');
  await page.getByRole('dialog', { name: 'Focused card' }).waitFor({ state: 'hidden' });
}

const workspace = await mkdtemp(join(tmpdir(), 'site-shots-'));
await seed(workspace);
await mkdir(out, { recursive: true });
const server = spawn('node', ['scripts/dev.mjs'], {
  cwd: app, stdio: 'ignore', detached: true,
  env: { ...process.env, STAGE_PORT: String(port), STAGE_API_PORT: String(port + 1), STAGE_FAKE_MODEL: '1', STAGE_API_TOKEN: token, STAGE_WORKSPACE: workspace, STAGE_NO_CODE_WATCH: '1', STAGE_NO_LOCAL: '1' },
});
const stop = () => { try { process.kill(-server.pid!, 'SIGTERM'); } catch { /* already gone */ } };
process.on('exit', stop);

const browser = await chromium.launch();
try {
  // Both halves must answer: a page opened before the api is up draws an empty stage.
  await up(base);
  await up(`http://127.0.0.1:${port + 1}/api/stage`, { 'x-stage-token': token });
  // Desktop: the whole stage for the top of the page, then each card cropped from it for the parts below.
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark' });
    const page = await context.newPage();
    page.setDefaultTimeout(90_000); // a busy machine compiles the page slowly the first time
    await page.goto(base);
    await page.locator('.react-flow__node[data-id="marketing"] .msg--assistant').first().waitFor();
    await page.locator('.react-flow__node[data-id="leads"] .lead').first().waitFor();
    await shot(page, 'stage', 'desktop');

    const card = (id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
    await crop(page, 'wires-crop', [card('marketing'), card('build'), card('brand-doc'), card('company-brief'), card('film')], { below: 4 }); // the dock sits just under the studio
    await crop(page, 'room-crop', [card('marketing')]);
    await crop(page, 'film-crop', [card('film')], { below: 4 });
    await crop(page, 'leads-crop', [card('leads')]);

    const dash = page.getByRole('dialog', { name: 'Dashboard' });
    await page.keyboard.press('Control+d');
    await dash.waitFor();
    await dash.locator('.dash__chart svg').waitFor();
    await crop(page, 'dashboard-crop', [dash], { most: 560 });
    await page.keyboard.press('Control+d');
    await dash.waitFor({ state: 'hidden' });

    await page.getByRole('button', { name: /^Needs you/ }).click();
    await page.locator('.needs li').first().waitFor();
    await crop(page, 'needs-crop', [page.getByRole('dialog', { name: 'Needs you' })]);
    await context.close();
  }

  // Phone: the app as a phone shows it, cropped to what is on screen so a picture is not half empty.
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'dark' });
    const page = await context.newPage();
    page.setDefaultTimeout(90_000);
    await page.goto(base);
    await page.locator('.react-flow__node[data-id="marketing"] .msg--assistant').first().waitFor();
    await page.locator('.react-flow__node[data-id="leads"] .lead').first().waitFor();
    await crop(page, 'stage-phone', [page.locator('.react-flow__node')], { pad: 16 });

    await focus(page, 'leads');
    await crop(page, 'leads-phone', [page.getByRole('dialog', { name: 'Focused card' })], { most: 300 });
    await unfocus(page);

    const dash = page.getByRole('dialog', { name: 'Dashboard' });
    await page.keyboard.press('Control+d');
    await dash.waitFor();
    await dash.locator('.dash__chart svg').waitFor();
    await shot(page, 'dashboard', 'phone');
    await page.keyboard.press('Control+d');
    await dash.waitFor({ state: 'hidden' });

    await page.getByRole('button', { name: /^Needs you/ }).click();
    await page.locator('.needs li').first().waitFor();
    await crop(page, 'needs-phone', [page.getByRole('dialog', { name: 'Needs you' })]);
    await context.close();
  }
} catch (error) {
  // Leave a picture of what the page showed when a wait gave up, beside the shots but out of git.
  const pages = browser.contexts().flatMap((context) => context.pages());
  if (pages.length) await pages.at(-1)!.screenshot({ path: resolve(app, '..', 'site', '.shots', 'site-shots-failed.png') }).catch(() => {});
  throw error;
} finally {
  await browser.close();
  stop();
  await rm(workspace, { recursive: true, force: true });
}
