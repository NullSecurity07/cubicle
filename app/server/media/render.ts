import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CHROMES } from '../browser.ts';
import { SFX } from './audio.ts';
import { partName } from './film-record.ts';
import type { VideoDeps } from './gather.ts';
import { cachedImages } from './image.ts';
import type { Maker, Piece } from './jobs.ts';
import { FPS, type EditPlan, type EditShot, type EditSound } from './mlt.ts';
import { runLines, type Ran } from './proc.ts';
import { captionLines, composition, FORMATS, PACE, PACK, paintOf, projectFile, startsOf, type Film, type Pack } from './templates/index.ts';
import { camOf } from './templates/layouts.ts';
import { posterOf } from './poster.ts';

// The renderer: our own scenes written as one HTML page, which headless Chrome steps through frame by frame and ffmpeg
// turns into an MP4. Nothing leaves this machine except what the founder wired to the card, and the same storyboard
// always renders the same film.
//
// Everything here is shared by a new film (`video.ts`) and a film remade from notes (`remake.ts`), which is why it
// is its own file: the remake used to import the whole studio to reach it, and the studio imported the remake back.

// Where Chrome is on this machine. The renderer takes it by name in the environment, not as a flag.
export const chromePath = (): string | null => CHROMES.find((path) => existsSync(path)) ?? null;

// The renderer is told where Chrome is by name in the environment, not as a flag, and prints no colour codes; the
// few that slip through anyway are taken off every line and off what it printed.
const ANSI = /\[[0-9;]*m/g;
const run = (command: string, args: string[], at: string, onLine: (line: string) => void, signal?: AbortSignal, collect = 0): Promise<Ran> =>
  runLines(command, args, {
    cwd: at, env: { ...process.env, HYPERFRAMES_BROWSER_PATH: chromePath() ?? '', NO_COLOR: '1' }, signal, collect,
    onLine: (line) => onLine(line.replace(ANSI, '').trim()),
  }).then((ran) => ({ ...ran, out: ran.out.replace(ANSI, '') }));
// What a render printed is kept only as its last few kilobytes: it is read for its last line when it fails.
const RENDER_TAIL = 8192;

// One job's own project folder: made with the two folders a render needs, handed to the work, and thrown away after.
// The project a film was rendered from is a copy of everything the founder wired plus a few megabytes of pictures.
// When something is wrong with a finished film the only way to see why is that project — which scene silenced its
// own captions, what the picture prompt really said — so there is one switch that keeps it, and it is off unless
// somebody debugging turns it on.
export async function withJobDir<T>(dir: string, name: string, report: (line: string) => void, work: (at: string) => Promise<T>): Promise<T> {
  const at = join(dir, '.video', name);
  try {
    await mkdir(join(at, 'assets'), { recursive: true });
    await mkdir(join(at, 'vendor'), { recursive: true });
    return await work(at);
  } finally {
    if (process.env.STAGE_KEEP_PROJECT === '1') report(`the project this was rendered from is at ${at}`);
    else await rm(at, { recursive: true, force: true }).catch(() => {});
  }
}

// What draws a film's pictures, when anything can: every drawn picture is filed under what was asked for, so the same
// film rendered twice draws nothing the second time and a founder's daily quota lasts the week.
export const drawingFor = (deps: Pick<VideoDeps, 'images' | 'cacheDir' | 'dir'>): Maker | null =>
  (deps.images && !deps.images.ready()
    ? cachedImages(deps.images, deps.cacheDir ? join(deps.cacheDir, 'pictures') : join(deps.dir, '.cache', 'pictures'))
    : null);

// What a film's record names and its hand-editable export does not carry — the planes a still was cut into, the
// narration, the bed before it was ducked — read out of the project's assets and put beside the export, once each.
export async function carryExtras(handEdit: EditPlan, at: string, names: string[]): Promise<void> {
  const carried = new Set(handEdit.files.map((one) => one.name));
  for (const name of names) {
    const safe = partName(name);
    if (!safe || carried.has(safe)) continue;
    const read = await readFile(join(at, 'assets', name)).catch(() => null);
    if (read) { handEdit.files.push({ name: safe, bytes: read }); carried.add(safe); }
  }
}

// The fonts a look sets its words in, the animation library, and rough.js when the look draws by hand.
export async function stageVendor(vendor: string, at: string, pack: Pack): Promise<void> {
  for (const file of [...new Set(PACK[pack].fonts.map((one) => one.file))]) await copyFile(join(vendor, file), join(at, 'vendor', file));
  await copyFile(join(vendor, 'gsap.min.js'), join(at, 'vendor', 'gsap.min.js'));
  if (pack === 'sketch') await copyFile(join(vendor, 'rough.js'), join(at, 'vendor', 'rough.js'));
}

// The composition written, checked, rendered and photographed for its poster. The same for a film and for a film
// remade from notes, because the page is the cheap part: it is the pictures and the voice that cost.
export async function renderProject(bin: string, at: string, film: Film, help: { draft?: boolean; report: (line: string) => void; signal?: AbortSignal }): Promise<{ bytes: Buffer; poster?: Piece['poster'] }> {
  const { report, signal, draft } = help;
  await writeFile(join(at, 'index.html'), composition(film));
  await writeFile(join(at, 'hyperframes.json'), projectFile);

  // A finding here is worth saying out loud, but it is not worth withholding the film over: render either way.
  report('checking the composition…');
  const checked = await run(bin, ['check', '.'], at, () => {}, signal, Infinity);
  // Say what it disliked, not how many things it disliked: the lint's own line names the element and the reason.
  if (checked.code !== 0) {
    const found = checked.out.split('\n').map((line) => line.trim()).find((line) => line.startsWith('✗'))
      ?? checked.out.match(/^.*(error|warning|finding).*$/im)?.[0]?.trim() ?? 'see the render';
    report(`the check was not happy: ${found.replace(/^✗\s*/, '').slice(0, 200)}`);
  }

  const total = film.shots.reduce((sum, one) => sum + one.seconds, 0);
  report(`rendering ${Math.round(total)} seconds…`);
  let last = 0;
  const rendered = await run(bin, ['render', '.', '--no-browser-gpu', '--quiet', ...(draft ? ['--quality', 'draft'] : []), '-o', 'out.mp4'], at, (line) => {
    // The renderer talks a lot; a line a second is enough for the founder to see it moving.
    if (!line || Date.now() - last < 1000) return;
    last = Date.now();
    report(`rendering · ${line.slice(0, 120)}`);
  }, signal, RENDER_TAIL);
  if (signal?.aborted) throw new Error('stopped');
  if (rendered.code !== 0) throw new Error(`the render stopped: ${(rendered.out.trim().split('\n').filter(Boolean).at(-1) ?? 'no reason given').slice(0, 200)}`);
  const bytes = await readFile(join(at, 'out.mp4'));

  // One frame stands in for the film wherever it cannot be played: the opening title, settled, with no caption half
  // way through its phrase on it (`poster.ts`). The page is set once more without its caption track for it, and put
  // back afterwards, so what is left in the project is the film as rendered.
  report('taking the poster frame…');
  let poster: Piece['poster'];
  const still = posterOf(film);
  await writeFile(join(at, 'index.html'), composition(still.film));
  await run(bin, ['snapshot', '.', '--at', still.at.toFixed(2), '--no-end', '--describe=false', '-o', 'poster'], at, () => {}, signal);
  await writeFile(join(at, 'index.html'), composition(film));
  const shot = (await readdir(join(at, 'poster')).catch(() => [])).find((name) => name.endsWith('.png'));
  if (shot) poster = { ext: 'png', bytes: await readFile(join(at, 'poster', shot)) };
  return { bytes, poster };
}

// The film as an editor would lay it out, and the files it needs beside it: every picture and moving picture a shot
// shows, the narration, the bed and the sounds, read out of the project before it is thrown away. A file that
// cannot be read is left out, and its shot becomes the look's own colour rather than a hole in the timeline.
export async function editPlan(film: Film, at: string): Promise<EditPlan> {
  const { height, scale, caps, width } = FORMATS[film.shape];
  const paint = paintOf(film.look, film.brand);
  const files = new Map<string, Buffer>();
  const take = async (name: string | undefined): Promise<string | undefined> => {
    if (!name) return undefined;
    // Only a plain file name out of the project's own assets: the parts folder is flat.
    const safe = (name.split(/[\\/]/).pop() ?? '').replace(/[^\w.-]+/g, '-');
    if (!safe || safe.startsWith('.')) return undefined;
    if (files.has(safe)) return safe;
    const bytes = await readFile(join(at, 'assets', name)).catch(() => null);
    if (!bytes) return undefined;
    files.set(safe, bytes);
    return safe;
  };
  const shots: EditShot[] = [];
  for (const shot of film.shots) {
    const video = await take(shot.video);
    const image = video ? undefined : await take(shot.image ?? shot.bg);
    const words = [shot.scene.heading, shot.scene.text].filter(Boolean).join(' — ') || shot.scene.say || undefined;
    shots.push({
      seconds: shot.seconds, ground: paint.ground, ...(words ? { words } : {}),
      ...(video ? { video, from: typeof shot.scene.start === 'number' ? shot.scene.start : 0 } : {}),
      ...(image ? { image } : {}),
      ...(image && camOf(shot) ? { move: String(shot.scene.move ?? 'a slow move') } : {}),
    });
  }
  const { starts } = startsOf(film.shots);
  const narration: EditSound[] = [];
  if (film.voice) {
    const file = await take(film.voice.file);
    if (file) narration.push({ file, at: 0, seconds: film.voice.seconds });
  } else {
    for (const [index, shot] of film.shots.entries()) {
      const file = shot.voice ? await take(shot.voice.file) : undefined;
      if (file && shot.voice) narration.push({ file, at: starts[index] + PACE[film.pace ?? 'calm'].lead, seconds: shot.voice.seconds });
    }
  }
  // The bed was mixed to its level, ducked and faded before the film was rendered, so it plays at full gain here too.
  const bedFile = film.bed ? await take(film.bed.file) : undefined;
  const sounds: EditSound[] = [];
  for (const cue of film.cues ?? []) {
    const file = await take(SFX[cue.sound].file);
    if (file) sounds.push({ file, at: Math.max(0, cue.at), seconds: 1, gain: cue.gain ?? SFX[cue.sound].gain });
  }
  const captions = captionLines(film).map((line) => ({ text: line.words.map((one) => one.word).join(' '), at: line.at, seconds: line.seconds }));
  return {
    film: {
      title: film.title, width, height, fps: FPS, shots, narration, sounds, captions,
      ...(film.bed && bedFile ? { bed: { file: bedFile, at: 0, seconds: film.bed.seconds, gain: 1 } } : {}),
      ink: paint.ink, capSize: Math.round(height * 0.108) * scale, capFoot: caps,
    },
    files: [...files].map(([name, bytes]) => ({ name, bytes })),
  };
}
