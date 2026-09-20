import type { Shape } from '../../../shared/model.ts';
import { SFX, type Cue, type Sfx } from '../audio.ts';
import { saysWhatItShows } from '../spec.ts';
import { capHtml, capLines, capSteps, wordTimes, type Word } from './captions.ts';
import { cutSteps } from './cuts.ts';
import { groundHtml, MOVING, onscreen, sceneHtml, sceneSteps, type Shot } from './layouts.ts';
import { cutAt, FORMATS, PACE, PACK, styleSheet, type Brand, type Pace, type Pack } from './looks.ts';

export { FORMATS, SAFE_1080, safeArea, LOOKS, PACKS, PACES, PACK, PACE, paintOf, lightOf, cutAt, isPack, type Brand, type Look, type Pack, type Pace, type Paint } from './looks.ts';
export type { Shot } from './layouts.ts';
export { FRAMES } from './layouts.ts';
export { wordTimes, capLines, type Part, type Word } from './captions.ts';
export { snapToBeats } from './cuts.ts';

// A scene lasts as long as the line said over it, and never less than the time it takes to read what is on it. A
// punchy film reads faster and holds less: the floor, the ceiling and the reading speed all move with the pace.
export function sceneSeconds(words: string, spoken: number, pace: Pace = 'calm'): number {
  const beat = PACE[pace];
  const count = words.trim().split(/\s+/).filter(Boolean).length;
  const readable = Math.min(beat.ceiling, Math.max(beat.floor, count / beat.read + (pace === 'punchy' ? 0.9 : 1.6)));
  return Math.round(Math.max(readable, spoken ? spoken + beat.lead + beat.tail : 0) * 100) / 100;
}

// Where the sounds land. A cut at the head of every scene, and then whatever that scene does: a figure arriving, a
// list ticking down, a comparison turning over, a wordmark dropping. A film with `sfx` off gets none of it.
const CUT: Record<Pace, Sfx> = { calm: 'cut-soft', punchy: 'cut-hard' };
export function cuesOf(shots: Shot[], starts: number[], pace: Pace): Cue[] {
  const beat = PACE[pace];
  const cues: Cue[] = [];
  shots.forEach((shot, index) => {
    const at = starts[index];
    const layout = shot.scene.layout;
    const first = index === 0;
    // The opener of a punchy film is the one place a hard, bright sound belongs.
    if (first && layout === 'hook' && pace === 'punchy') cues.push({ sound: 'hard', at });
    else if (MOVING.has(layout) || layout === 'device') cues.push({ sound: 'cut-wood', at });
    else if (first && pace === 'calm') cues.push({ sound: 'soft', at });
    else cues.push({ sound: CUT[pace], at });
    const lines = (shot.scene.bullets ?? []).length;
    if (layout === 'bullets' || layout === 'steps') for (let one = 0; one < lines; one += 1) cues.push({ sound: 'tick', at: at + 0.22 + one * beat.stagger });
    if (layout === 'checklist') for (let one = 0; one < lines; one += 1) cues.push({ sound: 'mark', at: at + 0.2 + one * beat.stagger });
    if (layout === 'compare') cues.push({ sound: 'turn', at: at + Math.min(1.5, shot.seconds * 0.42) });
    if (layout === 'stat') cues.push({ sound: 'accent', at: at + 0.22 });
    if (layout === 'logo') cues.push({ sound: 'sting', at: at + 0.1 });
    if (layout === 'cta') cues.push({ sound: 'accent', at: at + 0.3 });
  });
  // Enough is enough: a film that ticks forty times is a film nobody finishes.
  return cues.slice(0, 64);
}

// The hand-drawn look, done in the page itself: every element that carries a mark is measured once the type has settled
// and a rough shape is drawn where it sits, with a fixed seed so two renders of the same film draw the same lines.
const MARKS = `
function marksOf(sceneAt) {
  const root = document.getElementById("root").getBoundingClientRect();
  const paint = getComputedStyle(document.documentElement);
  const signal = paint.getPropertyValue("--signal").trim();
  const ink = paint.getPropertyValue("--ink").trim();
  const mark = paint.getPropertyValue("--mark").trim();
  const drawn = [];
  document.querySelectorAll("section.clip").forEach((clip, index) => {
    const pad = document.getElementById("m" + index);
    if (!pad) return;
    const pen = rough.svg(pad);
    clip.querySelectorAll("[data-mark]").forEach((element, order) => {
      const box = element.getBoundingClientRect();
      if (!box.width && !box.height) return;
      const x = box.left - root.left, y = box.top - root.top, w = box.width, h = box.height;
      const seed = index * 97 + order * 13 + 7;
      const kind = element.dataset.mark;
      let shape = null;
      if (kind === "highlight") shape = pen.rectangle(x - h * 0.08, y + h * 0.28, w + h * 0.16, h * 0.62, { seed, roughness: 1.4, bowing: 1.1, stroke: "none", fill: mark, fillStyle: "hachure", hachureAngle: -4, hachureGap: h * 0.15, fillWeight: h * 0.17 });
      else if (kind === "dash") shape = pen.line(x, y + h / 2, x + w, y + h / 2, { seed, roughness: 2.1, bowing: 2.4, stroke: signal, strokeWidth: 3.4 });
      else if (kind === "frame") shape = pen.rectangle(x - 10, y - 10, w + 20, h + 20, { seed, roughness: 2.2, bowing: 1.4, stroke: ink, strokeWidth: 3.6 });
      else if (kind === "ring") shape = pen.ellipse(x + w / 2, y + h / 2, Math.max(w * 1.22, h * 0.95), h * 1.28, { seed, roughness: 2.5, bowing: 1.3, stroke: signal, strokeWidth: 4.4 });
      else if (kind === "bar") shape = pen.line(x - 26, y + h * 0.04, x - 26, y + h * 0.96, { seed, roughness: 2.2, bowing: 2.8, stroke: signal, strokeWidth: 4.4 });
      if (!shape) return;
      pad.appendChild(shape);
      drawn.push({ at: sceneAt[index], kind, shape, paths: [...shape.querySelectorAll("path")] });
    });
  });
  return drawn;
}
function markSteps(tl, drawn) {
  for (const one of drawn) {
    if (one.kind === "highlight") { tl.fromTo(one.shape, { scaleX: 0 }, { scaleX: 1, transformOrigin: "0% 50%", duration: 0.5, ease: "power2.out" }, one.at + 0.12); continue; }
    for (const path of one.paths) { const length = path.getTotalLength(); path.style.strokeDasharray = length; path.style.strokeDashoffset = length; }
    tl.fromTo(one.paths, { strokeDashoffset: (i, target) => target.getTotalLength() }, { strokeDashoffset: 0, duration: 0.6, ease: "power2.out", stagger: 0.05 }, one.at + 0.2);
  }
}
`.trim();

// The push the editor asked for, written as a move on the film's own clock. It is on the picture, never on the
// type: a headline that grows while it is being read is a headline nobody finishes. `1.0` to somewhere between
// 1.08 and 1.15 over three hundred milliseconds is a punch-in; the same move over four seconds is a camera.
function punchSteps(shot: Shot, index: number): string[] {
  if (!shot.punch) return [];
  const { to, at, seconds } = shot.punch;
  // A quick push is an emphasis and overshoots a little; a slow one is a camera and must not.
  const ease = seconds < 0.6 ? 'back.out(1.6)' : 'power1.inOut';
  return [`tl.fromTo("#g${index} .bg img, #g${index} .shot img, #g${index} .shot video, #g${index} .mesh",`
    + ` { scale: 1 }, { scale: ${to.toFixed(3)}, duration: ${seconds.toFixed(2)}, ease: "${ease}" }, ${at.toFixed(3)});`];
}

// What a film is, once everything it is made of has been made: the scenes in order, how fast it moves, the look it
// wears, the bed under it and the sounds cut into it.
export type Film = {
  title: string; shape: Shape; look: Pack; shots: Shot[];
  pace?: Pace; captions?: boolean; brand?: Brand;
  bed?: { file: string; seconds: number }; cues?: Cue[];
  // Where the bed's beats fall, when the bed knew: the cuts are pulled onto them.
  beats?: number[];
  // The film's narration: **one** recording for the whole piece, not one a scene glued to the next. A voice read
  // in pieces and stitched back together has a new breath at every join and a flat, even stress across the whole
  // thing; read in one go it rises and falls the way somebody talking does, and every cut in the film is then
  // placed against that one clock rather than against a dozen.
  voice?: { file: string; seconds: number };
  // Every word of it, and when it is said — measured, where anything could measure it. This is what the captions
  // are built from now, so a caption lands on its word rather than near it.
  words?: Word[];
  // The words the film turns on, which take the accent colour in the caption track.
  keywords?: string[];
  // Where the captions must not be shown, in film time: the scenes that already write out what is being said, so
  // the frame is not the same sentence twice.
  quiet?: { at: number; seconds: number }[];
};

// The whole video as one HTML file: the scenes in order with their timing on them, the narration and the music beside
// them, and one paused timeline the renderer steps through frame by frame.
export function composition(film: Film): string {
  const { width, height, scale, capChars, margin, safeRight } = FORMATS[film.shape];
  const pack: Pack = film.look;
  const style = PACK[pack];
  const sketch = pack === 'sketch';
  const pace: Pace = film.pace ?? 'calm';
  const starts: number[] = [];
  let at = 0;
  for (const shot of film.shots) { starts.push(Math.round(at * 100) / 100); at = Math.round((at + shot.seconds) * 100) / 100; }
  const total = at;
  const last = film.shots.length - 1;
  // A scene is given its own length plus the time the next one needs to arrive over it, so the two really overlap.
  const held = (index: number) => Math.round((film.shots[index].seconds + (index === last ? 0 : style.overlap)) * 100) / 100;

  // The captions belong to the frame, not to any one scene's block: one track for the whole film, outside every
  // section, so a whip pan carries the picture away and leaves the words being said where they are.
  //
  // A stretch of narration whose scene already writes out what is being said gets none of it: a hook is the spoken
  // line set large, and a word-by-word caption under it is the same sentence twice on one frame, which is exactly
  // what a founder was handed.
  const quiet = film.quiet ?? film.shots.map((shot, index) => (saysWhatItShows(shot.scene)
    ? { at: starts[index], seconds: shot.seconds } : null)).filter(Boolean) as { at: number; seconds: number }[];
  const spoken = (film.words ?? []).filter((word) => !quiet.some((gap) => word.at >= gap.at - 0.01 && word.at < gap.at + gap.seconds));
  // One to three words at a time for a reel, two to four for a quieter film, and never more than four: past that
  // a caption is a subtitle, read instead of watched. The pack's own caption measure decides which end it sits at.
  const capWords = Math.min(4, Math.max(1, Math.round(style.capScale * 3.4)));
  const lines = film.captions && spoken.length
    ? capLines(spoken, Math.round(capChars * style.capScale), capWords, film.keywords ?? [])
    : [];
  // The band's real measure, so a long word is set smaller rather than having both ends cut off by the frame.
  const capSize = Math.round(height * 0.108) * scale;
  const capRoom = width - margin - (margin + safeRight);
  const captionHtml = capHtml(lines, { size: capSize, room: capRoom });
  const captionSteps = capSteps(lines, total);

  // The moving pictures are elements of the film in their own right, before the scenes and behind them: the renderer
  // owns their playback, and a <video> that carried its own start inside a section that carried one too would be
  // resolved against two different clocks and show the wrong frames.
  const reels = film.shots.flatMap((shot, index) => {
    if (!shot.video) return [];
    const scene = shot.scene;
    const loud = scene.layout === 'footage' && scene.mute === false;
    const from = typeof scene.start === 'number' && scene.start > 0 ? ` data-media-start="${scene.start.toFixed(2)}"` : '';
    return [`      <video id="v${index}" class="reel${scene.layout === 'presenter' ? ' reel--face' : ''}" src="assets/${shot.video}" playsinline${loud ? ' data-has-audio="true" data-volume="0.85"' : ' muted'}`
      + ` data-start="${starts[index]}" data-duration="${shot.seconds.toFixed(2)}"${from}></video>`];
  });

  // Every scene is one box that moves as one thing, because the cut between two scenes is a move of the whole box.
  const captioned = !!captionHtml;
  const bodies = film.shots.map((shot, index) => sceneHtml(shot, index, film.shape, captioned, pack));
  const sections = film.shots.map((shot, index) => `      <section class="clip" id="s${index}" data-start="${starts[index]}" data-duration="${held(index)}">`
    + `<div class="stage" id="g${index}">${groundHtml(shot, index, pack)}`
    + `${sketch ? `<svg class="marks" id="m${index}" viewBox="0 0 ${width} ${height}"></svg>` : ''}`
    + `${bodies[index]}</div></section>`);
  // Every sound needs an id of its own or the mixer never finds it and the film comes out silent. The narration is
  // one element for the whole film; a scene that also carries its own recording still gets one, which is how a
  // film made without measured timings still speaks.
  const sounds = film.voice
    ? [`      <audio id="say" src="assets/${film.voice.file}" data-start="0" data-duration="${film.voice.seconds.toFixed(2)}" data-volume="1"></audio>`]
    : film.shots.flatMap((shot, index) => (shot.voice
      ? [`      <audio id="say${index}" src="assets/${shot.voice.file}" data-start="${(starts[index] + PACE[pace].lead).toFixed(2)}" data-duration="${shot.voice.seconds.toFixed(2)}" data-volume="1"></audio>`]
      : []));
  if (film.bed) sounds.unshift(`      <audio id="bed" src="assets/${film.bed.file}" data-start="0" data-duration="${film.bed.seconds.toFixed(2)}" data-volume="1"></audio>`);
  for (const [index, cue] of (film.cues ?? []).entries()) {
    const sound = SFX[cue.sound];
    sounds.push(`      <audio id="fx${index}" src="assets/${sound.file}" data-start="${Math.max(0, cue.at).toFixed(2)}" data-duration="1" data-volume="${(cue.gain ?? sound.gain).toFixed(2)}"></audio>`);
  }
  // How far through the film a viewer is, on the packs that are made for a feed. It sits outside every scene, so it
  // runs across the cuts rather than restarting at each one.
  const bar = (pack === 'creator' || pack === 'neon') && film.shots.length > 1;
  // A pack that wears letterbox wears it for the whole render: a declared format, painted once, never animated.
  const letterbox = (style.format?.letterbox ?? 0) > 0;

  const steps = film.shots.flatMap((shot, index) => {
    // A picture change inside one scene is a cut, not a transition: the same words stay on screen and the shot
    // behind them changes. Anything else reads as the film starting the scene again.
    const cut = shot.take ? 'cut' : cutAt(pack, index);
    const move = cutSteps(cut, `#g${index}`, starts[index], starts[index] + shot.seconds, style.overlap, index);
    return [
      ...move.into,
      ...(index === last ? [] : move.outOf),
      ...sceneSteps(shot, index, starts[index], scale, pack, index === last, pace, onscreen(bodies[index])),
      ...punchSteps(shot, index),
    ];
  }).concat(captionSteps);
  if (bar) steps.push(`tl.fromTo("#bar", { scaleX: 0 }, { scaleX: 1, duration: ${total.toFixed(2)}, ease: "none" }, 0);`);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${width}, height=${height}" />
    <title>${film.title.replace(/[<>&]/g, ' ')}</title>
    <script src="vendor/gsap.min.js"></script>
${sketch ? '    <script src="vendor/rough.js"></script>\n' : ''}    <style>
${styleSheet(film.shape, pack, film.brand)}
    </style>
  </head>
  <body>
    <div id="root"${captioned ? ' class="has-captions"' : ''} data-composition-id="main" data-start="0" data-width="${width}" data-height="${height}" data-duration="${total}">
${reels.length ? `${reels.join('\n')}\n` : ''}${sections.join('\n')}
${captionHtml ? `      ${captionHtml}\n` : ''}${letterbox ? '      <div class="bar bar--top"></div>\n      <div class="bar bar--foot"></div>\n' : ''}${bar ? '      <div class="progress" id="bar"></div>\n' : ''}${sounds.join('\n')}
    </div>
    <script>
${sketch ? `${MARKS}\n` : ''}      const SCENE_AT = ${JSON.stringify(starts)};
      function build(tl) {
${steps.map((step) => `        ${step}`).join('\n')}
      }
      // The type has to have settled before anything is measured or drawn; the timeline is handed over only once it has.
      // The marks are measured before the timeline is built, while every word still sits where it will come to rest:
      // building it puts each scene into its opening state, and a line drawn around that lands off the words.
      document.fonts.ready.then(() => {
        const tl = gsap.timeline({ paused: true });
${sketch ? '        const drawn = marksOf(SCENE_AT);\n' : ''}        build(tl);
${sketch ? '        markSteps(tl, drawn);\n' : ''}        window.__timelines["main"] = tl;
      });
    </script>
  </body>
</html>
`;
}

export const projectFile = JSON.stringify({ $schema: 'https://hyperframes.heygen.com/schema/hyperframes.json', paths: { assets: 'assets' }, media: { autoProxy: true } }, null, 2);
