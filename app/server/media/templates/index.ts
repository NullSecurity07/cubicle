import type { Shape } from '../../../shared/model.ts';
import { SFX, type Cue } from '../audio.ts';
import { countWords, crowdsCaptions, saysWhatItShows } from '../spec.ts';
import { capHtml, capLines, capSteps, type CapLine, type Word } from './captions.ts';
import { breakMove, captionPiece, PILL_TYPE, type BreakMove } from '../registry/index.ts';
import { actBreaks, cutSteps } from './cuts.ts';
import { dataGraphic, groundHtml, onscreen, sceneHtml, sceneSteps, type Shot } from './layouts.ts';
import { cutAt, FORMATS, PACE, PACK, paintOf, styleSheet, type Brand, type Pace, type Pack } from './looks.ts';

export { FORMATS, SAFE_1080, safeArea, LOOKS, PACKS, PACES, PACK, PACE, paintOf, lightOf, cutAt, isPack, type Brand, type Look, type Pack, type Pace, type Paint } from './looks.ts';
export type { Shot } from './layouts.ts';
export { FRAMES } from './layouts.ts';
export { wordTimes, capLines, type Part, type Word } from './captions.ts';
export { actBreaks, snapToBeats } from './cuts.ts';

// A scene lasts as long as the line said over it, and never less than the time it takes to read what is on it. A
// punchy film reads faster and holds less: the floor, the ceiling and the reading speed all move with the pace.
export function sceneSeconds(words: string, spoken: number, pace: Pace = 'calm'): number {
  const beat = PACE[pace];
  const count = countWords(words);
  const readable = Math.min(beat.ceiling, Math.max(beat.floor, count / beat.read + (pace === 'punchy' ? 0.9 : 1.6)));
  return Math.round(Math.max(readable, spoken ? spoken + beat.lead + beat.tail : 0) * 100) / 100;
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
  // A still in planes is punched as one stack: a punch on each plane would overwrite the move that makes them planes.
  return [`tl.fromTo("#g${index} .bg > img, #g${index} .shot > img, #g${index} .cam > img, #g${index} .deep, #g${index} .shot video, #g${index} .mesh",`
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

// One to three words at a time for a reel, two to four for a quieter film, and never more than four: past that
// a caption is a subtitle, read instead of watched. The pack's own caption measure decides which end it sits at.
const capWordsOf = (pack: Pack): number => Math.min(4, Math.max(1, Math.round(PACK[pack].capScale * 3.4)));

// The caption lines a film shows, and when. The composition sets them in the frame, and the hand-editable export
// writes the same lines out as text, so the two can never disagree.
//
// A stretch of narration whose scene already writes out what is being said gets none of it: a hook is the spoken
// line set large, and a word-by-word caption under it is the same sentence twice on one frame, which is exactly
// what a founder was handed.
// Where each shot starts on the film's clock, to the hundredth of a second, and where the last one ends. The film,
// its captions, its remake and its hand-editable export all count the same way, so they can never disagree.
export function startsOf(shots: { seconds: number }[]): { starts: number[]; total: number } {
  const starts: number[] = [];
  let at = 0;
  for (const shot of shots) { starts.push(at); at = Math.round((at + shot.seconds) * 100) / 100; }
  return { starts, total: at };
}

// Where the caption track must stay quiet: a shot whose scene already writes out what is being said, and one whose
// own type grows down into the band the captions live in.
export function quietOf(shots: Shot[], starts: number[]): { at: number; seconds: number }[] {
  return shots.flatMap((shot, index) => (saysWhatItShows(shot.scene) || crowdsCaptions(shot.scene) ? [{ at: starts[index], seconds: shot.seconds }] : []));
}

export function captionLines(film: Film): CapLine[] {
  if (!film.captions || !film.words?.length) return [];
  const quiet = film.quiet ?? quietOf(film.shots, startsOf(film.shots).starts);
  const hushed = film.words.map((word) => quiet.some((gap) => word.at >= gap.at - 0.01 && word.at < gap.at + gap.seconds));
  // A phrase that runs into a hushed stretch takes its first word or two with it. Left on their own they are a
  // fragment in the band — the site's hero film showed "You" by itself, the rest of "You decide," being hushed
  // under a scene that wrote the line out. A clause that ended before the hush is whole and stays.
  for (let at = 1; at < film.words.length; at += 1) {
    if (!hushed[at] || hushed[at - 1]) continue;
    let from = at;
    while (from > 0 && !hushed[from - 1] && !/[.!?,;:\u2014]$/.test(film.words[from - 1].word)) from -= 1;
    if (at - from > 0 && at - from <= 2) for (let one = from; one < at; one += 1) hushed[one] = true;
  }
  const spoken = film.words.filter((_word, at) => !hushed[at]);
  if (!spoken.length) return [];
  const { capChars } = FORMATS[film.shape];
  // The pill sets its type smaller and holds up to two lines, so it takes one more word and a longer measure; its
  // own item is already told the same (`captionPiece`), and the two now agree on what a line is.
  const pill = PACK[film.look].captions === 'pill';
  const most = pill ? Math.min(4, capWordsOf(film.look) + 1) : capWordsOf(film.look);
  return capLines(spoken, Math.round((capChars * PACK[film.look].capScale) / (pill ? PILL_TYPE : 1)), most, film.keywords ?? []);
}

// The whole video as one HTML file: the scenes in order with their timing on them, the narration and the music beside
// them, and one paused timeline the renderer steps through frame by frame.
export function composition(film: Film): string {
  const { width, height, scale, margin, safeRight, caps } = FORMATS[film.shape];
  const pack: Pack = film.look;
  const style = PACK[pack];
  const sketch = pack === 'sketch';
  const pace: Pace = film.pace ?? 'calm';
  const { starts, total } = startsOf(film.shots);
  const last = film.shots.length - 1;
  const paint = paintOf(pack, film.brand);
  const fonts = film.brand?.fontFile && paint.font
    ? { display: `'${paint.font}', ${style.display}`, body: `'${paint.font}', ${style.body}` }
    : { display: style.display, body: style.body };
  // What the registry graphics bring with them, once each: rules, boxes that sit over every scene, and functions.
  const extra = { css: new Set<string>(), html: new Set<string>(), script: new Set<string>() };

  // The act breaks, and the move each one is made with. A pack that has a break transition cuts hard everywhere
  // else. A whip or a push moves a scene's box, and a moving picture is not in the box — the renderer owns it, at
  // the root, behind every scene — so a break with a moving picture on either side of it is a hard cut too. The
  // sheet of white goes over everything and has no such trouble.
  const breaks = style.breaks ? actBreaks(film.shots) : new Set<number>();
  const moves: (BreakMove | null)[] = film.shots.map((shot, index) => {
    if (!style.breaks || !index || !breaks.has(index)) return null;
    if (style.breaks !== 'flash-white' && (shot.video || film.shots[index - 1].video)) return null;
    // A calm film dips through its own ground rather than flashing white. Over a dark look at a calm pace, a third of
    // a second of full white is not read as energy but as a blank frame — the site's own hero film showed one.
    const sheet = style.breaks === 'flash-white' && pace === 'calm' ? paint.ground : undefined;
    try { return breakMove(style.breaks, `#g${index - 1}`, `#g${index}`, starts[index], index, width, sheet); } catch { return null; }
  });
  for (const move of moves) if (move) { extra.css.add(move.css); extra.html.add(move.html); }
  // A scene is given its own length plus the time the next one needs to arrive over it, so the two really overlap.
  // The last one has nothing to hand over to, and used to end exactly on the film's own last frame — which the
  // renderer captured a hair after the section had gone, so every film finished on a frame of black. It is held
  // past the end instead. Nothing is on screen to see it, and the last picture is the last thing anybody sees.
  // A scene that leaves on a break is held for as long as that break's move takes, not for the pack's overlap.
  const held = (index: number) => Math.round((film.shots[index].seconds + (moves[index + 1]?.span ?? style.overlap)) * 100) / 100;

  // The captions belong to the frame, not to any one scene's block: one track for the whole film, outside every
  // section, so a whip pan carries the picture away and leaves the words being said where they are.
  //
  // A stretch of narration whose scene already writes out what is being said gets none of it: a hook is the spoken
  // line set large, and a word-by-word caption under it is the same sentence twice on one frame, which is exactly
  // what a founder was handed.
  const lines = captionLines(film);
  // The band's real measure, so a long word is set smaller rather than having both ends cut off by the frame.
  const capSize = Math.round(height * 0.108) * scale;
  const capRoom = width - margin - (margin + safeRight);
  // How they are drawn is the pack's: the studio's own track, or a caption component from the registry set in the
  // same band at the same size. An item that will not build is a test's business; the film gets the studio's track.
  let captionHtml = '';
  let captionSteps: string[] = [];
  if (lines.length && style.captions !== 'studio') {
    try {
      const piece = captionPiece(style.captions, lines, total, { left: margin, bottom: caps, width: capRoom, size: capSize },
        { ink: paint.ink, signal: paint.signal, ground: paint.ground, ...fonts }, capWordsOf(pack));
      captionHtml = piece.html;
      captionSteps = piece.steps;
      extra.css.add(piece.css);
      extra.script.add(piece.script);
    } catch { captionHtml = ''; }
  }
  if (!captionHtml) {
    captionHtml = capHtml(lines, { size: capSize, room: capRoom });
    captionSteps = capSteps(lines, total);
  }

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
  // The one data graphic a scene may take from the registry: a figure that counts up, columns that grow.
  const graphics = film.shots.map((shot, index) => dataGraphic(shot, index, film.shape, pack, paint, fonts, captioned, starts[index], pace));
  for (const one of graphics) if (one) { extra.css.add(one.css); if (one.script) extra.script.add(one.script); }
  const bodies = film.shots.map((shot, index) => sceneHtml(shot, index, film.shape, captioned, pack, graphics[index]?.html));
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
    // A break is one move made by two scenes, so the scene arriving on it writes both halves and the scene
    // leaving on it writes nothing of its own.
    const arrives = moves[index];
    return [
      ...(arrives ? [...arrives.into, ...arrives.outOf] : move.into),
      ...(index === last || moves[index + 1] ? [] : move.outOf),
      ...(graphics[index]?.steps ?? []),
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
${[...extra.css].join('\n')}
    </style>
  </head>
  <body>
    <div id="root"${captioned ? ' class="has-captions"' : ''} data-composition-id="main" data-start="0" data-width="${width}" data-height="${height}" data-duration="${total}">
${reels.length ? `${reels.join('\n')}\n` : ''}${sections.join('\n')}
${[...extra.html].map((one) => `      ${one}\n`).join('')}${captionHtml ? `      ${captionHtml}\n` : ''}${letterbox ? '      <div class="bar bar--top"></div>\n      <div class="bar bar--foot"></div>\n' : ''}${bar ? '      <div class="progress" id="bar"></div>\n' : ''}${sounds.join('\n')}
    </div>
    <script>
${sketch ? `${MARKS}\n` : ''}${[...extra.script].map((one) => `${one}\n`).join('')}      const SCENE_AT = ${JSON.stringify(starts)};
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
