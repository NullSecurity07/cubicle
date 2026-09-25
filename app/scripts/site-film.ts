// The film at the top of the product website, made by the app's own Video studio rather than by hand, so the site's
// first moving picture is also proof of what the studio does. It starts the app on its own ports with the real
// models, in a throwaway workspace, puts a project card on the stage that holds the product as a visitor meets it
// (the README, the site's copy, its colours and typeface, the mark, and the screenshots the site already shows),
// wires it to a Video studio, and asks for a short film in the product's own look.
//
//   cd app && node scripts/site-film.ts
//
// Keys come from the `.env` at the top of the repository (a worktree borrows the main checkout's): Groq or Gemini
// for the storyboard, Cloudflare for the pictures. The narrator is Kokoro, on this machine. Free quota is spent
// carefully: a draft first, which costs a few small pictures, then the full film, which reuses the draft's
// storyboard. When the free pictures for today are used up the script stops and says so rather than rendering a film
// of textures. Pictures are never drawn on this machine here and nothing moving is generated, so the run does not
// take the graphics card from anyone.
//
// What it writes: `site/media/hero.mp4` (no sound track, since the page plays it muted; re-encoded to 720p when
// the film is over 2 MB), `site/media/hero.webp` (the poster) and `site/media/hero-credits.txt`, which it also
// prints. The draft is kept in `site/.shots/hero-draft.mp4`, out of git, for a look before the full render.
// SITE_FILM_PORT moves the pair of ports (default 7670 for the page, 7671 for the api).
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import sharp from 'sharp';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(app, '..');
const site = resolve(repo, 'site');
const port = Number(process.env.SITE_FILM_PORT ?? 7670);
const api = `http://127.0.0.1:${port + 1}`;
const token = 'site-film';
const LIMIT = 2 * 1024 * 1024;

const BRIEF = 'A 20 second marketing film for the top of the product website, made to be understood with the sound off: '
  + 'a canvas where a small team of AI people works beside a founder; wires are access, so each person reads only what '
  + 'is wired to them; nothing leaves the machine. Calm and confident, show the product itself, end on the promise, '
  + 'then close with the call to action "Get it, free, on your own machine."';
const ASK = { prompt: BRIEF, purpose: 'launch', length: 20, format: 'wide', look: 'brand', pace: 'calm', captions: 'on', ai: 'off', music: 'none' };

// The keys, from the `.env` beside this checkout, or the main checkout's when this is a worktree (which has none).
function keys(): Record<string, string> {
  const common = (() => {
    try { return dirname(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repo, encoding: 'utf8' }).trim()); } catch { return repo; }
  })();
  const file = [process.env.SITE_FILM_ENV, join(repo, '.env'), join(common, '.env')].find((one) => one && existsSync(one));
  if (!file) throw new Error('no .env found: the film needs real keys (GROQ_API_KEY or GEMINI_API_KEY, and CLOUDFLARE_API_TOKEN with CLOUDFLARE_ACCOUNT_ID)');
  const read = parseEnv(readFileSync(file, 'utf8')) as Record<string, string>;
  const missing = [
    !(read.GROQ_API_KEY || read.GEMINI_API_KEY) && 'GROQ_API_KEY or GEMINI_API_KEY (the storyboard)',
    !(read.CLOUDFLARE_API_TOKEN && read.CLOUDFLARE_ACCOUNT_ID) && 'CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (the pictures)',
  ].filter(Boolean);
  if (missing.length) throw new Error(`${file} is missing ${missing.join(' and ')}`);
  console.log('keys from', file);
  return read;
}

// Whether today's free pictures are already spent, as the studio itself remembers it: a film started now would be
// drawn on textures, which is not a film for the front of the site.
function picturesSpent(): string | null {
  try {
    const kept = JSON.parse(readFileSync(join(app, '.cache', 'pictures-spent.json'), 'utf8')) as Record<string, { day: number; why: string }>;
    const today = Math.floor(Date.now() / 86_400_000);
    const spent = Object.entries(kept).filter(([name, one]) => one?.day === today && /cloudflare/i.test(name));
    return spent.length ? `${spent[0][0]}: ${spent[0][1].why}` : null;
  } catch { return null; }
}

// The product as a visitor meets it, laid out the way the studio reads a project: the README and the site's own copy
// for the words, the stylesheets for the colours and the typeface, the mark, and the screenshots the site shows.
// The repository itself cannot be wired: the app refuses a project card on the folder it runs from.
async function product(dir: string) {
  await mkdir(join(dir, 'media'), { recursive: true });
  await mkdir(join(dir, 'screenshots'), { recursive: true });
  await copyFile(join(repo, 'README.md'), join(dir, 'README.md'));
  await copyFile(join(site, 'index.html'), join(dir, 'index.html'));
  await copyFile(join(site, 'style.css'), join(dir, 'style.css'));
  await copyFile(join(app, 'src', 'theme.css'), join(dir, 'theme.css'));
  await copyFile(join(site, 'media', 'inter.woff2'), join(dir, 'media', 'inter.woff2'));
  const html = await readFile(join(site, 'index.html'), 'utf8');
  const description = /<meta name="description" content="([^"]+)"/.exec(html)?.[1];
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'cubicle', description }, null, 2));
  // The site's mark, in the product's blue: two cards and the wire between them.
  // The studio puts a raster mark in a film, so it is drawn once as a PNG.
  const mark = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="512" height="512"><g fill="#4e8cff" stroke="#4e8cff" stroke-width="1.8" stroke-linecap="round"><circle cx="5" cy="6" r="3"/><circle cx="19" cy="18" r="3"/><path d="M8 6h4a3 3 0 0 1 3 3v6a3 3 0 0 0 3 3" fill="none"/></g></svg>';
  await sharp(Buffer.from(mark)).png().toFile(join(dir, 'logo.png'));
  for (const [from, to] of [['stage-desktop', 'screenshot-stage'], ['room-crop', 'screenshot-room'], ['leads-crop', 'screenshot-leads'], ['dashboard-crop', 'screenshot-dashboard']]) {
    const source = join(site, 'media', `${from}.webp`);
    if (existsSync(source)) await sharp(source).png().toFile(join(dir, 'screenshots', `${to}.png`));
  }
}

async function seed(workspace: string, project: string) {
  await mkdir(workspace, { recursive: true });
  const stage = {
    rooms: [], docs: [],
    cards: [
      { kind: 'project', id: 'product', path: project, x: 0, y: 0, w: 400, h: 300 },
      { kind: 'videogen', id: 'hero', brief: BRIEF, format: 'wide', look: 'brand', length: 20, purpose: 'launch', pace: 'calm', captions: 'on', ai: 'off', music: 'none', x: 500, y: 0, w: 400, h: 400 },
    ],
    wires: [{ id: 'product-hero', from: 'product', fromHandle: 'r', to: 'hero', toHandle: 'l' }],
  };
  await writeFile(join(workspace, 'stage.json'), JSON.stringify(stage, null, 2));
  await writeFile(join(workspace, 'missions.json'), JSON.stringify({ dismissed: true }));
}

// The api is busy while a film is made (the narrator runs in the same process), so a poll that is dropped is tried
// again rather than taken for the end of the run.
const call = async (path: string, init: RequestInit = {}) => {
  let response: Response | undefined;
  for (let tries = 0; !response; tries++) {
    try {
      response = await fetch(`${api}${path}`, { ...init, headers: { 'x-stage-token': token, 'content-type': 'application/json', ...(init.headers ?? {}) } });
    } catch (error) {
      if (tries >= 20 || server.exitCode !== null) throw error;
      await new Promise((done) => setTimeout(done, 3000));
    }
  }
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${JSON.stringify(json)}`);
  return json as Record<string, unknown>;
};

async function up() {
  for (let tries = 0; tries < 240; tries++) {
    try { if ((await fetch(`${api}/api/stage`, { headers: { 'x-stage-token': token } })).ok) return; } catch { /* not yet */ }
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(`the api did not answer at ${api}`);
}

type Result = { path: string; poster?: string; prompt: string; at: number; music?: { title: string; by: string; licence: string; source: string }; credits?: string; by?: string };
type State = { state: 'idle' | 'making' | 'failed'; log: string[]; problem?: string; results: Result[] };

// One film, from Make to the file: prints each line the card shows, and stops the job the moment the free pictures
// run out, naming the provider.
async function film(speed: 'draft' | 'full'): Promise<Result> {
  const before = (await call('/api/media/hero')) as unknown as State;
  const known = new Set(before.results.map((one) => one.path));
  await call('/api/media/hero/make', { method: 'POST', body: JSON.stringify({ ...ASK, ...(speed === 'draft' ? { speed: 'draft' } : {}) }) });
  console.log(`\n— ${speed} —`);
  let seen = 0;
  const deadline = Date.now() + 45 * 60_000;
  let started = false;
  while (Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 3000));
    const now = (await call('/api/media/hero')) as unknown as State;
    if (now.log.length < seen) seen = 0; // the log is a rolling window
    for (const line of now.log.slice(seen)) {
      console.log('  ', line);
      if (/free pictures are used up/i.test(line)) {
        await call('/api/media/hero/stop', { method: 'POST', body: '{}' }).catch(() => {});
        throw new Error('Cloudflare Workers AI is out of free pictures for today (10,000 neurons a day); the film was stopped rather than drawn on textures. Run again after midnight UTC.');
      }
    }
    seen = now.log.length;
    if (now.state === 'making') started = true;
    if (now.state === 'failed') throw new Error(`the studio failed: ${now.problem ?? now.log.at(-1) ?? 'no reason given'}`);
    const made = now.results.find((one) => !known.has(one.path));
    if (made && (started || now.state === 'idle')) return made;
  }
  throw new Error(`the ${speed} did not finish inside 45 minutes`);
}

const ffmpeg = (args: string[]) => execFileSync('ffmpeg', ['-y', '-v', 'error', ...args], { stdio: 'inherit' });
const kb = (bytes: number) => `${Math.round(bytes / 1024)} KB`;

const env = keys();
const spent = picturesSpent();
if (spent) throw new Error(`the free pictures are already spent today (${spent}); run again after midnight UTC`);

const scratch = await mkdtemp(join(tmpdir(), 'site-film-'));
const workspace = join(scratch, 'workspace');
const project = join(scratch, 'cubicle');
await product(project);
await seed(workspace, project);
await mkdir(join(site, '.shots'), { recursive: true });

const server = spawn('node', ['scripts/dev.mjs'], {
  cwd: app, stdio: ['ignore', 'inherit', 'inherit'], detached: true,
  env: {
    ...process.env, ...env, STAGE_PORT: String(port), STAGE_API_PORT: String(port + 1), STAGE_FAKE_MODEL: '0',
    STAGE_API_TOKEN: token, STAGE_WORKSPACE: workspace, STAGE_NO_CODE_WATCH: '1', STAGE_IMAGE_BACKEND: 'cloud',
  },
});
server.on('exit', (code, signal) => console.log(`the app stopped (${signal ?? code})`));
const stopServer = () => { try { process.kill(-server.pid!, 'SIGTERM'); } catch { /* already gone */ } };
process.on('exit', stopServer);
process.on('SIGINT', () => process.exit(130));

try {
  await up();
  const files = (path: string) => join(workspace, 'files', path);

  const draft = await film('draft');
  await copyFile(files(draft.path), join(site, '.shots', 'hero-draft.mp4'));
  console.log('draft:', join(site, '.shots', 'hero-draft.mp4'), kb((await stat(files(draft.path))).size));

  const full = await film('full');
  const source = files(full.path);
  const out = join(site, 'media', 'hero.mp4');
  const size = (await stat(source)).size;
  // The page plays it muted, so the sound track is weight for nothing. The picture is kept as it is when it fits.
  ffmpeg(['-i', source, '-map', '0:v:0', '-c:v', 'copy', '-an', '-movflags', '+faststart', out]);
  if ((await stat(out)).size > LIMIT) {
    for (const crf of [30, 33, 36]) {
      ffmpeg(['-i', source, '-map', '0:v:0', '-vf', 'scale=-2:720', '-c:v', 'libx264', '-preset', 'slow', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', out]);
      if ((await stat(out)).size <= LIMIT) break;
    }
  }
  const poster = join(site, 'media', 'hero.webp');
  if (full.poster) await sharp(files(full.poster)).resize({ width: 1280, withoutEnlargement: true }).webp({ quality: 78 }).toFile(poster);
  else { ffmpeg(['-ss', '1', '-i', out, '-frames:v', '1', join(scratch, 'poster.png')]); await sharp(join(scratch, 'poster.png')).resize({ width: 1280, withoutEnlargement: true }).webp({ quality: 78 }).toFile(poster); }
  const probe = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'csv=p=0', out], { encoding: 'utf8' }).trim().replace(/\n/g, ' · ');

  const credits = [
    'Hero film for the product website, made by the app\'s own Video studio.',
    `Made: ${new Date().toISOString().slice(0, 10)} · ${full.by ?? 'Hyperframes'} · brief: ${BRIEF}`,
    'Words and storyboard: the free hosted models (Groq or Gemini). Pictures: Cloudflare Workers AI (FLUX.1 schnell).',
    'Narration: Kokoro, on this machine. The site copy carries no sound track, so neither the voice nor any music is heard.',
    ...(full.music ? [`Music in the studio's own file: ${full.music.title} by ${full.music.by} · ${full.music.licence} · ${full.music.source}`] : []),
    ...(full.credits && existsSync(files(full.credits)) ? ['', (await readFile(files(full.credits), 'utf8')).trim()] : []),
    '',
    `Studio file: ${kb(size)} · site file: ${kb((await stat(out)).size)} (${probe}) · poster: ${kb((await stat(poster)).size)}`,
  ].join('\n');
  await writeFile(join(site, 'media', 'hero-credits.txt'), `${credits}\n`);
  console.log(`\n${credits}\n\nwrote ${out}\nwrote ${poster}\nwrote ${join(site, 'media', 'hero-credits.txt')}`);
} finally {
  stopServer();
  await rm(scratch, { recursive: true, force: true });
}
