import type { Shape } from '../../../shared/model.ts';
import type { Scene } from '../spec.ts';
import type { Part } from './captions.ts';
import { FORMATS, PACE, PACK, type Pace, type Pack } from './looks.ts';

// One scene, ready to be written out: what was asked for, how long it is on screen, the still drawn for it, the moving
// picture cut into it, the picture drawn behind it and the narration recorded over it. `image`, `video` and `bg` are
// file names inside the project's own assets folder; `parts` is the narration sentence by sentence, which is what the
// captions are timed from.
export type Shot = {
  scene: Scene; seconds: number; image?: string; video?: string; bg?: string;
  // Whether `bg` is a picture this scene shares with others. A shared one is shown at its own crop and its own
  // tint, so the film hangs together without three scenes looking like the same frame held too long.
  bgShared?: boolean;
  // How hard this shot's own picture has to be held down for the words on it to be read, measured off the picture
  // itself rather than taken from the pack. A dark doorway needs almost nothing; a white wall needs most of a
  // wash. Unset, the pack's own number stands, which is what every film had until this was measured.
  scrim?: number;
  // How much this shot's picture is lifted before the pack's grade goes over it. A declared grade over an already
  // dark photograph is how "dim and murky, subjects unreadable" happens, and the fix is the picture, not the look.
  lift?: number;
  voice?: { file: string; seconds: number; parts?: Part[] };
  // Which take of its scene this is. A scene long enough to want a picture change is several shots, and each of
  // them shows something different — otherwise the change is the same frame twice, which is worse than a hold.
  take?: number;
  // The push the editor asked for, because a word under it earned one or because the frame would otherwise sit
  // still past three seconds. Written on the film's own clock, so it lands on the word rather than near it.
  punch?: { to: number; at: number; seconds: number };
};

const html = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const quoted = (text: string) => `“${text.replace(/^["“]|["”]$/g, '')}”`;

// A figure worth counting up to: a plain whole number, with whatever sits in front of it or after it left alone.
const FIGURE = /^(\D{0,3})(\d{1,4})(\D{0,14})$/;
// The one number on a stat scene is as big as the frame can hold it on one line: full height for a short figure, and
// stepped down for a longer one, down to the size of a heading — past that it is a sentence, and it wraps like one.
function statStyle(heading: string, shape: Shape, pack: Pack): string {
  const { width, margin, scale } = FORMATS[shape];
  // How wide a character really is at that size. A display face set for a figure is narrow — Anton is very narrow —
  // and the old 0.78 was the width of a body face, which is why a seven-character figure came out at a third of the
  // size it could have been and read as a caption rather than as the scene.
  const wide = PACK[pack].shout ? 0.50 : 0.62;
  const room = Math.round((width - margin * 2) / Math.max(heading.length * wide, 1));
  const floor = Math.round(88 * scale);
  return `font-size: ${Math.max(Math.min(300 * scale, room), floor)}px${room < floor ? '; white-space: normal' : ''}`;
}
const figure = (heading: string, shape: Shape, pack: Pack): string => {
  const bits = FIGURE.exec(heading);
  const open = `<p class="stat rise" data-mark="ring" style="${statStyle(heading, shape, pack)}">`;
  if (!bits) return `${open}${html(heading)}</p>`;
  return `${open}${html(bits[1])}<span class="count" style="min-width: ${bits[2].length}ch">${bits[2]}</span>${html(bits[3])}</p>`;
};

// --- kinetic type -------------------------------------------------------------------------------------------------

const barest = (word: string) => word.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

// A line set one word at a time, so it can arrive one word at a time. The word the scene turns on takes the accent
// colour, and in the packs that shout it takes a sweep of that colour drawn behind it as well.
export function kinetic(text: string, emphasis: string | undefined, pack: Pack, word = true): string {
  const style = PACK[pack];
  const mark = emphasis ? barest(emphasis) : '';
  const parts = text.split(/\s+/).filter(Boolean);
  if (!word) {
    // Not kinetic: the block moves as a block, and only the accent word is painted.
    if (!mark) return html(text);
    return parts.map((one) => (barest(one) === mark ? `<span class="pop">${html(one)}</span>` : html(one))).join(' ');
  }
  return parts.map((one) => {
    const hit = mark && barest(one) === mark;
    if (hit && style.sweep) return `<span class="w swept"><span class="sweep"></span><span class="on-sweep">${html(one)}</span></span>`;
    return `<span class="w${hit ? ' pop' : ''}">${html(one)}</span>`;
  }).join(' ');
}

// A line short enough to be said in one breath is set as large as a title; a paragraph is set as a heading, or it would
// not fit the frame. Nothing else in the film changes size with what is written on it.
const weight = (text: string, shape: Shape) => (text.length <= (shape === 'tall' ? 28 : shape === 'square' ? 36 : 44) ? 'display' : 'heading');

// A hook is one line at the size of a poster; a long one is stepped down rather than run off the frame.
const hookWeight = (text: string, shape: Shape) => {
  const room = shape === 'tall' ? 26 : shape === 'square' ? 32 : 38;
  return text.length <= room ? 'hook' : text.length <= room * 1.9 ? 'display' : 'heading';
};

// A scene that is a moving picture rather than a still: the frame under the words is a video file, and that video is
// written as an element of the film in its own right rather than inside the scene.
export const MOVING = new Set(['footage', 'clip', 'presenter']);

// A tall frame has a phone in it and a wide one a browser, unless the storyboard said which.
export const FRAMES = ['phone', 'laptop', 'browser'] as const;
export type DeviceFrame = (typeof FRAMES)[number];
const frameOf = (scene: Scene, shape: Shape): DeviceFrame =>
  ((FRAMES as readonly string[]).includes(scene.frame ?? '') ? scene.frame : shape === 'tall' ? 'phone' : 'browser') as DeviceFrame;

const CHECK = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 12.6 L9.4 18 L20 6.4" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" /></svg>';

// A screenshot inside the thing it was taken on, drawn in the page rather than fetched as a picture of a phone.
function device(shot: Shot, shape: Shape): string {
  const kind = frameOf(shot.scene, shape);
  const glass = `<div class="device__glass">${shot.image ? `<img src="assets/${shot.image}" alt="" data-layout-allow-overflow>` : ''}</div>`;
  if (kind === 'phone') return `<div class="device device--phone" data-mark="frame">${glass}<div class="device__notch"></div></div>`;
  if (kind === 'laptop') return `<div class="device device--laptop" data-mark="frame">${glass}<div class="device__foot"></div></div>`;
  const where = html((shot.scene.text ?? shot.scene.heading ?? '').slice(0, 60));
  return `<div class="device device--browser" data-mark="frame"><div class="device__chrome">`
    + `<div class="device__bar"><div class="device__dot"></div><div class="device__dot"></div><div class="device__dot"></div><div class="device__pill">${where}</div></div>${glass}</div></div>`;
}

// --- what a scene sits on -------------------------------------------------------------------------------------------

// Four soft lamps drifting behind the words, placed from the scene's own number so two renders of the same film put
// them in the same place. This is what a scene with no picture gets, and it is the reason no film is a flat rectangle
// any more.
export function meshHtml(index: number, pack: Pack): string {
  const paint = PACK[pack].paint;
  // Three to five lamps, a different number and a different order of the film's colours each scene, with a band of
  // light lying across them. Four of the same lamps in the same four colours made every scene of a film with no
  // pictures the same green cloud, which is what a founder saw when the day's free pictures ran out.
  const seed = (step: number) => ((index * 37 + step * 61) % 100) / 100;
  const wheel = [paint.signal, paint.mark, paint.quiet, paint.mark, paint.signal, paint.quiet];
  const many = 3 + (index % 3);
  const colours = Array.from({ length: many }, (_one, step) => wheel[(index * 2 + step) % wheel.length]);
  const blobs = colours.map((colour, step) => {
    const x = Math.round(-8 + seed(step) * 96);
    const y = Math.round(-6 + seed(step + 4) * 92);
    const wide = Math.round(38 + seed(step + 8) * 62);
    const tall = Math.round(34 + seed(step + 16) * 66);
    const round = Math.round(34 + seed(step + 20) * 32);
    return `<div class="blob" id="b${index}-${step}" data-layout-allow-overflow style="left:${x}%; top:${y}%; width:${wide}%; height:${tall}%;`
      + ` border-radius:${round}% ${100 - round}% ${round + 12}% ${88 - round}%; background:${colour};`
      + ` opacity:${(0.16 + seed(step + 12) * 0.38).toFixed(2)}"></div>`;
  }).join('');
  // One sweep of light across the frame, at its own angle, so the eye has somewhere to go.
  const angle = Math.round(seed(29) * 180);
  const sweep = `<div class="glint" id="w${index}" data-layout-allow-overflow style="background:linear-gradient(${angle}deg,`
    + ` rgba(255,255,255,0) 28%, rgba(255,255,255,${(0.05 + seed(31) * 0.09).toFixed(3)}) 50%, rgba(255,255,255,0) 72%)"></div>`;
  return `<div class="mesh" id="mesh${index}">${blobs}${sweep}</div>`;
}

// The picture behind a scene, or the lamps when there is no picture. Either way the scene has somewhere to be.
// One picture behind several scenes, each seeing a different part of it in a slightly different light. The numbers
// come from the scene's own place in the film, so two renders of the same storyboard look the same.
function share(index: number): string {
  const turn = (step: number) => ((index * 41 + step * 67) % 100) / 100;
  // The crop, which is what makes two scenes of one picture two pictures. The transform is not touched: the slow
  // push across every background belongs to the timeline, and a transform set here is the first thing it overwrites.
  const x = Math.round(8 + turn(1) * 84);
  const y = Math.round(20 + turn(2) * 60);
  const hue = Math.round(-16 + turn(4) * 32);
  const warm = (0.88 + turn(5) * 0.34).toFixed(2);
  const soft = (turn(6) * 4).toFixed(1);
  const light = (0.86 + turn(3) * 0.3).toFixed(2);
  return `object-position:${x}% ${y}%; filter:hue-rotate(${hue}deg) saturate(${warm}) brightness(${light}) blur(${soft}px);`;
}

// What this shot measured about its own picture, written as two variables the stylesheet reads: how hard the
// scrim holds it down and how much the picture is lifted before the pack's grade. Both are left out where nothing
// could look at the picture, and then the pack's own numbers stand.
export const measured = (shot: Shot): string =>
  [shot.scrim === undefined ? '' : `--hold: ${shot.scrim.toFixed(2)};`, shot.lift === undefined || shot.lift === 1 ? '' : `--raise: ${shot.lift.toFixed(2)};`]
    .filter(Boolean).join(' ');

export const groundHtml = (shot: Shot, index: number, pack: Pack): string => {
  // A scene playing a moving shot has its ground already: the shot. Lamps drawn over it are a green wash across
  // somebody's face, which is what the founder was shown when a clip finally arrived.
  if (shot.video) return '';
  if (!shot.bg) return meshHtml(index, pack);
  const held = measured(shot);
  return `<div class="bg" id="bg${index}"${held ? ` style="${held}"` : ''}>`
    + `<img src="assets/${shot.bg}" alt="" data-layout-allow-overflow${shot.bgShared ? ` style="${share(index)}"` : ''}></div>`;
};

// --- the seventeen shapes ---------------------------------------------------------------------------------------------

// Most are the same left-aligned block with different weights in it; the one line that says "this block ends here"
// recurs through them, drawn straight in the clean look and by hand in the notebook. The rest — a device, a comparison,
// a piece of the founder's own footage — fill the frame instead.
export function sceneHtml(shot: Shot, index: number, shape: Shape, captioned = false, pack: Pack = 'clean'): string {
  const { scene } = shot;
  const style = PACK[pack];
  // A block of type centred on a photograph lands on whatever the photograph's subject is — which, on the portrait a
  // reel opens with, is somebody's face. Over a picture the words go to the foot of the frame, where the scrim is.
  const onbg = shot.bg ? ' frame--onbg' : '';
  const moving = style.motion === 'kinetic' || style.motion === 'snap';
  const heading = scene.heading?.trim() ?? '';
  const text = scene.text?.trim() ?? '';
  const icon = scene.icon?.trim() ? `<p class="icon rise">${html(scene.icon.trim())}</p>` : '';
  const say = (words: string, cls: string) => `<p class="${cls} rise">${kinetic(words, scene.emphasis, pack, moving)}</p>`;
  const parts: string[] = [];
  if (scene.layout === 'title') {
    parts.push(`<h1 class="display rise" data-mark="highlight">${kinetic(heading, scene.emphasis, pack, moving)}</h1>`, '<div class="rule" data-mark="dash"></div>');
    if (text) parts.push(`<p class="lead quiet rise">${html(text)}</p>`);
    return `<div class="frame frame--title${onbg}" id="f${index}">${parts.join('')}</div>`;
  } else if (scene.layout === 'hook') {
    if (icon) parts.push(icon);
    if (heading) parts.push(`<p class="label rise">${html(heading)}</p>`);
    parts.push(`<p class="${hookWeight(text, shape)} rise" data-mark="highlight">${kinetic(text, scene.emphasis, pack, moving)}</p>`);
    return `<div class="frame frame--hook${onbg}" id="f${index}">${parts.join('')}</div>`;
  } else if (scene.layout === 'statement') {
    if (icon) parts.push(icon);
    if (heading) parts.push(`<p class="label quiet rise">${html(heading)}</p>`);
    parts.push(say(text, weight(text, shape)), '<div class="rule" data-mark="dash"></div>');
  } else if (scene.layout === 'bullets') {
    if (heading) parts.push(`<h2 class="heading rise">${kinetic(heading, scene.emphasis, pack, false)}</h2>`, '<div class="rule" data-mark="dash"></div>');
    parts.push(`<ul class="list">${(scene.bullets ?? []).map((one) => `<li class="rise"><span class="tick" data-mark="dash"></span><span class="body">${html(one)}</span></li>`).join('')}</ul>`);
  } else if (scene.layout === 'checklist') {
    if (heading) parts.push(`<h2 class="heading rise">${kinetic(heading, scene.emphasis, pack, false)}</h2>`, '<div class="rule" data-mark="dash"></div>');
    parts.push(`<ul class="list list--check">${(scene.bullets ?? []).map((one) => `<li class="rise"><span class="mark">${CHECK}</span><span class="body">${html(one)}</span></li>`).join('')}</ul>`);
  } else if (scene.layout === 'steps') {
    if (heading) parts.push(`<h2 class="heading rise">${kinetic(heading, scene.emphasis, pack, false)}</h2>`, '<div class="rule" data-mark="dash"></div>');
    parts.push(`<ul class="list list--steps">${(scene.bullets ?? []).map((one, at) => `<li class="rise"><span class="step">${at + 1}</span><span class="body">${html(one)}</span></li>`).join('')}</ul>`);
  } else if (scene.layout === 'compare') {
    const labels = scene.labels ?? [];
    const sides = (scene.bullets ?? []).slice(0, 2).map((one, at) => `<div class="side${at === 1 ? ' side--after' : ''}" id="p${index}-${at}">`
      + `<p class="label">${html(labels[at] ?? (at === 0 ? 'Before' : 'After'))}</p><p class="body">${html(one)}</p></div>`).join('');
    if (heading) parts.push(`<h2 class="heading rise">${kinetic(heading, scene.emphasis, pack, false)}</h2>`);
    parts.push(`<div class="compare">${sides}</div>`);
  } else if (scene.layout === 'picture') {
    parts.push(`<div class="shot" data-mark="frame"${measured(shot) ? ` style="${measured(shot)}"` : ''}><img src="assets/${shot.image}" alt="" data-layout-allow-overflow></div>`);
    if (text) parts.push(`<div class="plate"><p class="lead rise">${kinetic(text, scene.emphasis, pack, false)}</p></div>`);
    return `<div class="frame frame--picture${text ? ' frame--captioned' : ''}${captioned ? ' has-caps' : ''}" id="f${index}">${parts.join('')}</div>`;
  } else if (MOVING.has(scene.layout)) {
    // The moving picture itself is not written here. A <video> carrying its own start may not sit inside a section
    // that carries one too — the renderer resolves the two against different clocks and shows the wrong frames — so
    // it is written as an element of the film in its own right and this is only what goes over it.
    if (!shot.video && shot.image) {
      parts.push(`<div class="${scene.layout === 'presenter' ? 'presenter' : 'shot'}" data-mark="frame"><img src="assets/${shot.image}" alt="" data-layout-allow-overflow></div>`);
    }
    if (text) parts.push(`<div class="plate"><p class="lead rise">${kinetic(text, scene.emphasis, pack, false)}</p></div>`);
    return `<div class="frame frame--picture${text ? ' frame--captioned' : ''}${captioned ? ' has-caps' : ''}" id="f${index}">${parts.join('')}</div>`;
  } else if (scene.layout === 'device') {
    // The device is the scene. Its words go on a chip in the corner rather than under it, so the mockup can have the
    // frame's whole width and the screenshot can be read.
    const said = heading || (frameOf(scene, shape) === 'browser' ? '' : text);
    if (said) parts.push(`<p class="chip rise">${html(said)}</p>`);
    parts.push(device(shot, shape));
    return `<div class="frame frame--device" id="f${index}">${parts.join('')}</div>`;
  } else if (scene.layout === 'stat') {
    // The ring around the figure is mark enough in the notebook: the line under it stays a straight one, or nothing.
    parts.push(figure(heading, shape, pack), '<div class="rule"></div>');
    if (text) parts.push(`<p class="lead quiet rise">${html(text)}</p>`);
    return `<div class="frame frame--stat${onbg}" id="f${index}">${parts.join('')}</div>`;
  } else if (scene.layout === 'quote') {
    parts.push(`<blockquote class="quote rise" data-mark="bar">${kinetic(quoted(text), scene.emphasis, pack, false)}</blockquote>`);
    if (heading) parts.push(`<p class="label quiet rise">— ${html(heading)}</p>`);
  } else if (scene.layout === 'logo') {
    parts.push(shot.image ? `<div class="logo rise" data-mark="ring"><img src="assets/${shot.image}" alt=""></div>` : `<p class="logo rise" data-mark="ring">${html(heading)}</p>`, '<div class="rule" data-mark="dash"></div>');
    if (text) parts.push(`<p class="lead quiet rise">${html(text)}</p>`);
    return `<div class="frame frame--logo${onbg}" id="f${index}">${parts.join('')}</div>`;
  } else if (scene.layout === 'cta') {
    if (icon) parts.push(icon);
    parts.push(say(text || heading, weight(text || heading, shape)));
    if (text && heading) parts.push(`<p class="cta rise" data-mark="highlight">${html(heading)}</p>`);
    return `<div class="frame frame--cta${onbg}" id="f${index}">${parts.join('')}</div>`;
  } else {
    parts.push('<div class="rule" data-mark="dash"></div>', say(text || heading, weight(text || heading, shape)));
    if (text && heading) parts.push(`<p class="label quiet rise">${html(heading)}</p>`);
  }
  return `<div class="frame${onbg}" id="f${index}">${parts.join('')}</div>`;
}

// Which scenes carry the recurring line, and which carry the little marks beside a list.
const hasRule = (scene: Scene) => scene.layout === 'title' || scene.layout === 'statement' || scene.layout === 'stat'
  || scene.layout === 'outro' || scene.layout === 'logo' || ((scene.layout === 'bullets' || scene.layout === 'checklist' || scene.layout === 'steps') && !!scene.heading?.trim());
const hasTicks = (scene: Scene) => scene.layout === 'bullets' && !!scene.bullets?.length;

// A scene that fills the frame with a picture, moving or not, and so takes the slow push rather than the rise.
const FILLS = new Set(['picture', 'footage', 'clip', 'presenter']);

// One orchestrated entrance a scene, and one fade out of it. Nothing moves that is not saying something arrived, and
// what moves arrives fast and settles: a long ease out, a little further travelled than looks safe, no bounce. A
// punchy film does the same thing in half the time, which is the whole difference between an explainer and a reel.
// What this scene actually put on the page. GSAP complains, loudly and once per frame, about a tween whose target is
// not there, so nothing is animated that was not written: the html is the one thing that knows.
export type Onscreen = { words: boolean; sweep: boolean; rise: boolean; rule: boolean; tick: boolean; mark: boolean; count: boolean };
export const onscreen = (html: string): Onscreen => ({
  words: html.includes('class="w'), sweep: html.includes('class="sweep"'), rise: html.includes(' rise"') || html.includes('rise ') || html.includes('"rise'),
  rule: html.includes('class="rule"'), tick: html.includes('class="tick"'), mark: html.includes('class="mark"'), count: html.includes('class="count"'),
});

export function sceneSteps(shot: Shot, index: number, at: number, scale: number, pack: Pack, last: boolean, pace: Pace = 'calm', has: Onscreen = { words: true, sweep: true, rise: true, rule: true, tick: true, mark: true, count: true }): string[] {
  const steps: string[] = [];
  const beat = PACE[pace];
  const style = PACK[pack];
  const time = (offset: number) => (at + offset).toFixed(3);
  const layout = shot.scene.layout;
  const lead = style.overlap * 0.6;

  // The ground. A drawn picture pushes slowly in behind the words the way a camera would; the lamps drift instead.
  if (shot.bg) {
    const to = 1.0 + (index % 2 ? 0.10 : 0.14);
    const pan = index % 2 ? 1.6 : -1.8;
    steps.push(`tl.fromTo("#bg${index} img", { scale: 1.02, xPercent: 0 }, { scale: ${to.toFixed(2)}, xPercent: ${pan}, duration: ${(shot.seconds + style.overlap).toFixed(3)}, ease: "none" }, ${time(0)});`);
  } else {
    for (let blob = 0; blob < 4; blob += 1) {
      const drift = ((index * 31 + blob * 17) % 9) - 4;
      steps.push(`tl.fromTo("#b${index}-${blob}", { xPercent: 0, yPercent: 0, scale: 1 }, { xPercent: ${drift * 1.6}, yPercent: ${drift * -1.1}, scale: ${(1 + blob * 0.03).toFixed(2)}, duration: ${(shot.seconds + style.overlap).toFixed(3)}, ease: "none" }, ${time(0)});`);
    }
  }

  if (FILLS.has(layout)) {
    const box = shot.video ? `#v${index}` : `#s${index} ${layout === 'presenter' ? '.presenter' : '.shot'}`;
    steps.push(`tl.fromTo("${box}", { opacity: 0 }, { opacity: 1, duration: ${(beat.rise * 0.9).toFixed(2)}, ease: "power2.out" }, ${time(0)});`);
    // The only motion that runs the whole scene: a slow push in, so a still does not sit dead on the screen. Footage
    // moves by itself and is left alone; a talking head is a locked-off shot, so it takes the push too.
    if (!shot.video || layout === 'presenter') {
      steps.push(`tl.fromTo("${shot.video ? box : `${box} img`}", { scale: 1 }, { scale: ${layout === 'presenter' ? 1.06 : 1.09}, duration: ${shot.seconds.toFixed(3)}, ease: "none" }, ${time(0)});`);
    }
  }
  if (layout === 'device') {
    steps.push(`tl.fromTo("#s${index} .device", { opacity: 0, y: ${Math.round(beat.travel * 1.4)}, scale: 0.965 }, { opacity: 1, y: 0, scale: 1, duration: ${(beat.rise * 1.1).toFixed(2)}, ease: "${beat.ease}" }, ${time(0)});`);
    // The whole screen first, then a slow push into the part of it that is doing the work. The origin sits above the
    // middle, where a page keeps its nav, its heading and its first real content.
    steps.push(`tl.fromTo("#s${index} .device__glass img", { scale: 1 }, { scale: 1.35, duration: ${shot.seconds.toFixed(3)}, ease: "power1.in" }, ${time(0)});`);
  }
  // The words. In a kinetic pack they arrive one at a time and a little oversized, which is what makes a reel read as
  // a reel; everywhere else the block moves as a block.
  const rise = `#s${index} .rise`;
  if (!has.rise) { /* nothing rose: a device scene or a bare picture */ }
  else if (style.motion === 'kinetic') {
    steps.push(`tl.fromTo("${rise}", { y: ${Math.round(beat.travel * scale * 0.6)}, opacity: 0 }, { y: 0, opacity: 1, duration: ${(beat.rise * 0.7).toFixed(2)}, ease: "${beat.ease}", stagger: ${(beat.stagger * 0.8).toFixed(3)} }, ${time(lead)});`);
    if (has.words) steps.push(`tl.fromTo("#s${index} .w", { yPercent: 62, opacity: 0, scale: 0.86 }, { yPercent: 0, opacity: 1, scale: 1, duration: 0.34, ease: "back.out(1.7)", stagger: 0.048 }, ${time(lead + 0.04)});`);
  } else if (style.motion === 'snap') {
    steps.push(`tl.fromTo("${rise}", { y: ${Math.round(beat.travel * scale * 0.5)}, opacity: 0 }, { y: 0, opacity: 1, duration: ${(beat.rise * 0.55).toFixed(2)}, ease: "power4.out", stagger: ${(beat.stagger * 0.7).toFixed(3)} }, ${time(lead)});`);
    if (has.words) steps.push(`tl.fromTo("#s${index} .w", { opacity: 0, xPercent: -14 }, { opacity: 1, xPercent: 0, duration: 0.22, ease: "power3.out", stagger: 0.034 }, ${time(lead + 0.03)});`);
  } else if (style.motion === 'glide') {
    steps.push(`tl.fromTo("${rise}", { y: ${Math.round(beat.travel * scale * 1.3)}, opacity: 0, filter: "blur(9px)" }, { y: 0, opacity: 1, filter: "blur(0px)", duration: ${(beat.rise * 1.25).toFixed(2)}, ease: "${beat.ease}", stagger: ${(beat.stagger * 1.4).toFixed(3)} }, ${time(lead)});`);
  } else {
    steps.push(`tl.fromTo("${rise}", { y: ${Math.round(beat.travel * scale)}, opacity: 0 }, { y: 0, opacity: 1, duration: ${beat.rise.toFixed(2)}, ease: "${beat.ease}", stagger: ${beat.stagger} }, ${time(lead)});`);
  }
  // The sweep of colour behind the one word the line turns on, drawn after the word has landed.
  if (style.sweep && has.sweep) steps.push(`tl.fromTo("#s${index} .sweep", { scaleX: 0 }, { scaleX: 1, duration: 0.30, ease: "power3.out" }, ${time(lead + 0.34)});`);
  // The two halves of a comparison are not one thing: the second arrives after the first has been read.
  if (layout === 'compare') {
    steps.push(`tl.fromTo("#p${index}-0", { x: ${-Math.round(beat.travel * 0.8)}, opacity: 0 }, { x: 0, opacity: 1, duration: ${beat.rise.toFixed(2)}, ease: "${beat.ease}" }, ${time(0.1)});`);
    steps.push(`tl.fromTo("#p${index}-1", { x: ${Math.round(beat.travel * 0.8)}, opacity: 0 }, { x: 0, opacity: 1, duration: ${beat.rise.toFixed(2)}, ease: "${beat.ease}" }, ${time(Math.min(1.5, shot.seconds * 0.42))});`);
  }
  // The figure on a stat scene runs up to itself, the way a counter settles on a number.
  const counted = layout === 'stat' && has.count && FIGURE.exec(shot.scene.heading?.trim() ?? '');
  if (counted) steps.push(`tl.fromTo("#s${index} .count", { textContent: 0 }, { textContent: ${counted[2]}, duration: ${Math.min(1.5, shot.seconds * 0.45).toFixed(2)}, ease: "power2.out", snap: { textContent: 1 } }, ${time(0.22)});`);
  // In the notebook the same lines are drawn by hand instead, which the marks script animates.
  const straight = pack === 'sketch' ? [] : [has.rule && hasRule(shot.scene) && `#s${index} .rule`, has.tick && hasTicks(shot.scene) && `#s${index} .tick`].filter(Boolean);
  if (straight.length) steps.push(`tl.fromTo("${straight.join(', ')}", { scaleX: 0 }, { scaleX: 1, duration: ${(beat.rise * 0.94).toFixed(2)}, ease: "${beat.ease}", stagger: 0.07 }, ${time(0.22)});`);
  if (layout === 'checklist' && has.mark) steps.push(`tl.fromTo("#s${index} .mark", { scale: 0, opacity: 0 }, { scale: 1, opacity: 1, duration: ${(beat.rise * 0.6).toFixed(2)}, ease: "back.out(2)", stagger: ${beat.stagger} }, ${time(0.2)});`);
  // The words leave before the frame does, so the picture is what the next scene is cut against.
  if (!last) {
    const targets = pack === 'sketch' ? `["#f${index}", "#m${index}"]` : `"#f${index}"`;
    steps.push(`tl.to(${targets}, { opacity: 0, duration: ${beat.out.toFixed(2)}, ease: "power2.in" }, ${time(shot.seconds - beat.out)});`);
  }
  return steps;
}
