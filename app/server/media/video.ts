import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Shape } from '../../shared/model.ts';
import { CHROMES } from '../browser.ts';
import type { Maker, Piece } from './jobs.ts';
import { composition, FORMATS, LOOKS, projectFile, sceneSeconds, type Look, type Shot } from './templates/index.ts';
import { wavSeconds } from './voice.ts';

export const LAYOUTS = ['title', 'statement', 'bullets', 'picture', 'stat', 'quote', 'outro'] as const;
export type Layout = (typeof LAYOUTS)[number];
// One scene of a video, as a model or a person fills it in. `say` is the line spoken over it; `image_prompt` is the
// still drawn for it. Which fields a layout needs is what `parseSpec` checks.
export type Scene = { layout: Layout; heading?: string; text?: string; bullets?: string[]; image_prompt?: string; say?: string };
export type Spec = { title: string; scenes: Scene[] };

const MAX_SCENES = 10;
const CAPS = { title: 80, heading: 80, text: 240, bullet: 90, bullets: 6, say: 400, image_prompt: 300 };
export const SETUP_HINT = 'No video renderer is set up. The founder installs Chrome and ffmpeg — both are free — and restarts the app.';

const words = (value: unknown, what: string, limit: number): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${what} must be a line of text`);
  if (value.length > limit) throw new Error(`${what} is too long (${value.length} characters, limit ${limit})`);
  return value.trim();
};

// The storyboard, checked by hand so that whatever went wrong comes back in a line a model or a person can act on.
export function parseSpec(raw: unknown): Spec {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('the storyboard must be a JSON object with "title" and "scenes"');
  const asked = raw as Record<string, unknown>;
  const title = words(asked.title, '"title"', CAPS.title);
  if (!Array.isArray(asked.scenes) || !asked.scenes.length) throw new Error('"scenes" must be a list with at least one scene');
  if (asked.scenes.length > MAX_SCENES) throw new Error(`a video can have at most ${MAX_SCENES} scenes, not ${asked.scenes.length}`);
  const scenes = asked.scenes.map((one, index): Scene => {
    const where = `scene ${index + 1}`;
    if (!one || typeof one !== 'object' || Array.isArray(one)) throw new Error(`${where} must be an object`);
    const scene = one as Record<string, unknown>;
    if (!(LAYOUTS as readonly unknown[]).includes(scene.layout)) throw new Error(`${where}: "layout" must be one of ${LAYOUTS.join(', ')}`);
    const layout = scene.layout as Layout;
    const made: Scene = { layout };
    if (scene.heading !== undefined && scene.heading !== null) made.heading = words(scene.heading, `${where}: "heading"`, CAPS.heading);
    if (scene.text !== undefined && scene.text !== null) made.text = words(scene.text, `${where}: "text"`, CAPS.text);
    if (scene.say !== undefined && scene.say !== null) made.say = words(scene.say, `${where}: "say"`, CAPS.say);
    if (scene.image_prompt !== undefined && scene.image_prompt !== null) made.image_prompt = words(scene.image_prompt, `${where}: "image_prompt"`, CAPS.image_prompt);
    if (scene.bullets !== undefined && scene.bullets !== null) {
      if (!Array.isArray(scene.bullets) || !scene.bullets.length) throw new Error(`${where}: "bullets" must be a list of short lines`);
      if (scene.bullets.length > CAPS.bullets) throw new Error(`${where}: at most ${CAPS.bullets} bullets fit on screen, not ${scene.bullets.length}`);
      made.bullets = scene.bullets.map((bullet, at) => words(bullet, `${where}: bullet ${at + 1}`, CAPS.bullet));
    }
    if ((layout === 'title' || layout === 'stat') && !made.heading) throw new Error(`${where}: a ${layout} scene needs "heading"`);
    if ((layout === 'statement' || layout === 'quote' || layout === 'outro') && !made.text) throw new Error(`${where}: a ${layout} scene needs "text"`);
    if (layout === 'bullets' && !made.bullets) throw new Error(`${where}: a bullets scene needs "bullets"`);
    // A picture scene must read as something even when no picture can be drawn, so it always carries words of its own.
    if (layout === 'picture' && (!made.image_prompt || !(made.text || made.heading))) throw new Error(`${where}: a picture scene needs "image_prompt" and a caption in "text"`);
    return made;
  });
  return { title, scenes };
}

const STORYBOARD = `You are storyboarding a short video from a founder's brief. Answer with one JSON object and nothing else.

{"title": "the film's title, a few words", "scenes": [ ... ]}

Each scene is {"layout": one of ${LAYOUTS.join(', ')}, "heading": ..., "text": ..., "bullets": [...], "image_prompt": ..., "say": ...}.
- title: "heading" is the title, "text" one short line under it. Open with this.
- statement: "text" is one sentence, the point of the scene. "heading" is optional and must be two or three words.
- bullets: "heading" plus two to five short "bullets", a few words each.
- picture: "image_prompt" describes a whole scene to draw (subject, setting, style, light) and "text" is the caption. Use at most two of these.
- stat: "heading" is one number or figure, "text" says what it measures.
- quote: "text" is the quotation, "heading" is who said it.
- outro: "text" is the closing line. End with this.
Write four to seven scenes. Give every scene a "say": one or two spoken sentences, written the way someone would read them aloud.
Keep "heading" under 80 characters, "text" under 240, each bullet under 90. Plain words, no exclamation marks, no hashtags.`;

// The model writes the storyboard, and gets exactly one more go with the reason its first answer could not be used.
export async function storyboardOf(brief: string, think: (prompt: string) => Promise<string>): Promise<Spec> {
  let problem = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const said = await think(`${STORYBOARD}${problem ? `\n\nYour last answer could not be used: ${problem}\nAnswer again, JSON only.` : ''}\n\nThe brief:\n${brief}`);
    try {
      const body = said.slice(said.indexOf('{'), said.lastIndexOf('}') + 1);
      if (!body) throw new Error('the answer held no JSON object');
      let parsed: unknown;
      try { parsed = JSON.parse(body); } catch { throw new Error('the answer was not valid JSON'); }
      return parseSpec(parsed);
    } catch (error) { problem = (error as Error).message; }
  }
  throw new Error(`the storyboard could not be written: ${problem}`);
}

// Where Chrome is on this machine. The renderer takes it by name in the environment, not as a flag.
export const chromePath = (): string | null => CHROMES.find((path) => existsSync(path)) ?? null;

type Ran = { code: number; out: string };
function run(command: string, args: string[], at: string, onLine: (line: string) => void, signal?: AbortSignal): Promise<Ran> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd: at, env: { ...process.env, HYPERFRAMES_BROWSER_PATH: chromePath() ?? '', NO_COLOR: '1' } });
    let out = '';
    let rest = '';
    const read = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      out += text;
      rest += text;
      const lines = rest.split('\n');
      rest = lines.pop() ?? '';
      for (const line of lines) onLine(line.replace(/\[[0-9;]*m/g, '').trim());
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    const stop = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', stop, { once: true });
    child.on('error', fail);
    child.on('close', (code) => { signal?.removeEventListener('abort', stop); done({ code: code ?? 1, out: out.replace(/\[[0-9;]*m/g, '') }); });
  });
}

// What a video studio was asked for: the brief in `prompt`, and for a person the storyboard itself.
export type VideoAsk = { prompt: string; format?: string; look?: string; narrate?: boolean; spec?: Spec };

// The renderer: our own scenes written as one HTML page, which headless Chrome steps through frame by frame and ffmpeg
// turns into an MP4. Nothing leaves this machine, and the same storyboard always renders the same film.
export function hyperframesVideos(deps: { dir: string; images?: Maker; voices?: Maker; think: (prompt: string) => Promise<string> }): Maker {
  const bin = resolve(import.meta.dirname, '../../node_modules/.bin/hyperframes');
  const vendor = resolve(import.meta.dirname, 'templates/vendor');
  return {
    name: 'Hyperframes',
    ready: () => (chromePath() ? null : SETUP_HINT),
    async make(ask, { report, signal }): Promise<Piece> {
      const asked = ask as VideoAsk;
      const shape: Shape = (FORMATS[asked.format as Shape] ? asked.format : 'wide') as Shape;
      const look: Look = (LOOKS as readonly string[]).includes(asked.look ?? '') ? asked.look as Look : 'clean';
      const spec = asked.spec ?? await (async () => { report('writing the storyboard…'); return storyboardOf(asked.prompt, deps.think); })();
      report(`${spec.scenes.length} scenes: ${spec.title}`);

      const at = join(deps.dir, '.video', Date.now().toString(36));
      try {
        await mkdir(join(at, 'assets'), { recursive: true });
        await mkdir(join(at, 'vendor'), { recursive: true });
        for (const file of ['gsap.min.js', 'inter.woff2', ...(look === 'sketch' ? ['rough.js'] : [])]) await copyFile(join(vendor, file), join(at, 'vendor', file));

        // Pictures and narration are made side by side: they are the slow part, and neither waits on the other.
        const drawing = deps.images && !deps.images.ready() ? deps.images : null;
        const saying = deps.voices && !deps.voices.ready() && asked.narrate !== false ? deps.voices : null;
        if (!drawing && spec.scenes.some((scene) => scene.layout === 'picture')) report('no picture maker is set up, so those scenes are written out in words');
        report('drawing the pictures and recording the narration…');
        const shots: Shot[] = spec.scenes.map((scene) => ({ scene, seconds: 0 }));
        await Promise.all(spec.scenes.flatMap((scene, index) => [
          ...(drawing && scene.layout === 'picture' && scene.image_prompt ? [(async () => {
            try {
              const piece = await drawing.make({ prompt: scene.image_prompt!, shape }, { report: () => {}, signal });
              shots[index].image = `shot-${index}.${piece.ext}`;
              await writeFile(join(at, 'assets', shots[index].image!), piece.bytes);
            } catch (error) { report(`scene ${index + 1} has no picture: ${(error as Error).message}`); }
          })()] : []),
          ...(saying && scene.say ? [(async () => {
            try {
              const piece = await saying.make({ prompt: scene.say!, voice: 'af_heart' }, { report: () => {}, signal });
              const file = `say-${index}.wav`;
              await writeFile(join(at, 'assets', file), piece.bytes);
              shots[index].voice = { file, seconds: wavSeconds(piece.bytes) };
            } catch (error) { report(`scene ${index + 1} is silent: ${(error as Error).message}`); }
          })()] : []),
        ]));
        if (signal?.aborted) throw new Error('stopped');

        // A scene with no picture becomes the words it carries, so a founder with no picture key still gets a video.
        for (const shot of shots) {
          if (shot.scene.layout === 'picture' && !shot.image) shot.scene = { ...shot.scene, layout: 'statement', text: shot.scene.text || shot.scene.heading, heading: shot.scene.text ? shot.scene.heading : undefined };
          shot.seconds = sceneSeconds([shot.scene.heading, shot.scene.text, ...(shot.scene.bullets ?? [])].filter(Boolean).join(' '), shot.voice?.seconds ?? 0);
        }
        const total = shots.reduce((sum, shot) => sum + shot.seconds, 0);
        await writeFile(join(at, 'index.html'), composition({ title: spec.title, shape, look, shots }));
        await writeFile(join(at, 'hyperframes.json'), projectFile);

        // A finding here is worth saying out loud, but it is not worth withholding the film over: render either way.
        report('checking the composition…');
        const checked = await run(bin, ['check', '.'], at, () => {}, signal);
        if (checked.code !== 0) report(`the check was not happy: ${(checked.out.match(/^.*(error|warning|finding).*$/im)?.[0] ?? 'see the render').trim().slice(0, 160)}`);

        report(`rendering ${Math.round(total)} seconds…`);
        let last = 0;
        const rendered = await run(bin, ['render', '.', '--no-browser-gpu', '--quiet', '-o', 'out.mp4'], at, (line) => {
          // The renderer talks a lot; a line a second is enough for the founder to see it moving.
          if (!line || Date.now() - last < 1000) return;
          last = Date.now();
          report(`rendering · ${line.slice(0, 120)}`);
        }, signal);
        if (signal?.aborted) throw new Error('stopped');
        if (rendered.code !== 0) throw new Error(`the render stopped: ${(rendered.out.trim().split('\n').filter(Boolean).at(-1) ?? 'no reason given').slice(0, 200)}`);
        const bytes = await readFile(join(at, 'out.mp4'));

        // One frame out of the opening scene stands in for the film wherever it cannot be played.
        report('taking the poster frame…');
        let poster: Piece['poster'];
        await run(bin, ['snapshot', '.', '--at', (shots[0].seconds * 0.6).toFixed(2), '--no-end', '--describe=false', '-o', 'poster'], at, () => {}, signal);
        const shot = (await readdir(join(at, 'poster')).catch(() => [])).find((name) => name.endsWith('.png'));
        if (shot) poster = { ext: 'png', bytes: await readFile(join(at, 'poster', shot)) };
        return { ext: 'mp4', bytes, poster };
      } finally {
        await rm(at, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}

// A second of one flat colour, so the checks and the fake-model mode never need Chrome.
const CLIP = 'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAOwbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAA+gAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAtt0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAA+gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAPoAAAIAAABAAAAAAJTbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAoAAAAKABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAAB/m1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAb5zdGJsAAAAvnN0c2QAAAAAAAAAAQAAAK5hdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEABIAAAASAAAAAAAAAABFExhdmM2My4xLjEwMSBsaWJ4MjY0AAAAAAAAAAAAAAAAGP//AAAANGF2Y0MBZAAK/+EAF2dkAAqs2V7ARAAAAwAEAAADAFA8SJZYAQAGaOvjyyLA/fj4AAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAABoYAAAAAAAAABhzdHRzAAAAAAAAAAEAAAAKAAAEAAAAABRzdHNzAAAAAAAAAAEAAAABAAAAYGN0dHMAAAAAAAAACgAAAAEAAAgAAAAAAQAAFAAAAAABAAAIAAAAAAEAAAAAAAAAAQAABAAAAAABAAAUAAAAAAEAAAgAAAAAAQAAAAAAAAABAAAEAAAAAAEAAAgAAAAAHHN0c2MAAAAAAAAAAQAAAAEAAAAKAAAAAQAAADxzdHN6AAAAAAAAAAAAAAAKAAACyQAAAAwAAAAMAAAADAAAAAwAAAASAAAADgAAAAwAAAAMAAAAEgAAABRzdGNvAAAAAAAAAAEAAAPgAAAAYXVkdGEAAABZbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAsaWxzdAAAACSpdG9vAAAAHGRhdGEAAAABAAAAAExhdmY2My4xLjEwMQAAAAhmcmVlAAADS21kYXQAAAKuBgX//6rcRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY1IHIzMjIyIGIzNTYwNWEgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDI1IC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MSByZWY9MyBkZWJsb2NrPTE6MDowIGFuYWx5c2U9MHgzOjB4MTEzIG1lPWhleCBzdWJtZT03IHBzeT0xIHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTEgbWVfcmFuZ2U9MTYgY2hyb21hX21lPTEgdHJlbGxpcz0xIDh4OGRjdD0xIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PS0yIHRocmVhZHM9MSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTMgYl9weXJhbWlkPTIgYl9hZGFwdD0xIGJfYmlhcz0wIGRpcmVjdD0xIHdlaWdodGI9MSBvcGVuX2dvcD0wIHdlaWdodHA9MiBrZXlpbnQ9MjUwIGtleWludF9taW49MTAgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVhZD00MCByYz1jcmYgbWJ0cmVlPTEgY3JmPTIzLjAgcWNvbXA9MC42MCBxcG1pbj0wIHFwbWF4PTY5IHFwc3RlcD00IGlwX3JhdGlvPTEuNDAgYXE9MToxLjAwAIAAAAATZYiEABH//ufj/AptY+nCoYzc8QAAAAhBmiRsQQ/+4AAAAAhBnkJ4h3+3gQAAAAgBnmF0Q3+6gAAAAAgBnmNqQ3+6gQAAAA5BmmhJqEFomUwId//+4QAAAApBnoZFESw7/7eBAAAACAGepXRDf7qBAAAACAGep2pDf7qAAAAADkGaqUmoQWyZTAhv//7g';
const POSTER = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
export const fakeVideos: Maker = {
  name: 'fake',
  ready: () => null,
  async make(ask, { report }) {
    const asked = ask as VideoAsk;
    const spec = asked.spec ?? { title: asked.prompt.slice(0, 60), scenes: [{ layout: 'title' as const, heading: asked.prompt.slice(0, 60) }] };
    report(`${spec.scenes.length} scenes: ${spec.title}`);
    report('rendering 6 seconds…');
    return { ext: 'mp4', bytes: Buffer.from(CLIP, 'base64'), poster: { ext: 'png', bytes: Buffer.from(POSTER, 'base64') } };
  },
};
