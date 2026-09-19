import type { Shape } from '../../../shared/model.ts';
import type { Scene } from '../video.ts';
import type { Part } from './captions.ts';
import { FORMATS, PACE, type Look, type Pace } from './looks.ts';

// One scene, ready to be written out: what was asked for, how long it is on screen, the still drawn for it, the moving
// picture cut into it and the narration recorded over it. `image` and `video` are file names inside the project's own
// assets folder; `parts` is the narration sentence by sentence, which is what the captions are timed from.
export type Shot = {
  scene: Scene; seconds: number; image?: string; video?: string;
  voice?: { file: string; seconds: number; parts?: Part[] };
};

const html = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const quoted = (text: string) => `“${text.replace(/^["“]|["”]$/g, '')}”`;

// A figure worth counting up to: a plain whole number, with whatever sits in front of it or after it left alone.
const FIGURE = /^(\D{0,3})(\d{1,4})(\D{0,14})$/;
// The one number on a stat scene is as big as the frame can hold it on one line: full height for a short figure, and
// stepped down for a longer one, down to the size of a heading — past that it is a sentence, and it wraps like one.
function statStyle(heading: string, shape: Shape): string {
  const { width, margin, scale } = FORMATS[shape];
  const room = Math.round((width - margin * 2) / Math.max(heading.length * 0.78, 1));
  const floor = Math.round(68 * scale);
  return `font-size: ${Math.max(Math.min(300 * scale, room), floor)}px${room < floor ? '; white-space: normal' : ''}`;
}
const figure = (heading: string, shape: Shape): string => {
  const bits = FIGURE.exec(heading);
  const open = `<p class="stat rise" data-mark="ring" style="${statStyle(heading, shape)}">`;
  if (!bits) return `${open}${html(heading)}</p>`;
  return `${open}${html(bits[1])}<span class="count" style="min-width: ${bits[2].length}ch">${bits[2]}</span>${html(bits[3])}</p>`;
};

// A line short enough to be said in one breath is set as large as a title; a paragraph is set as a heading, or it would
// not fit the frame. Nothing else in the film changes size with what is written on it.
const weight = (text: string) => (text.length <= 44 ? 'display' : 'heading');

// A hook is one line at the size of a poster; a long one is stepped down rather than run off the frame.
const hookWeight = (text: string) => (text.length <= 38 ? 'hook' : text.length <= 72 ? 'display' : 'heading');

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

// The seventeen shapes a scene can take. Most are the same left-aligned block with different weights in it; the one
// line that says "this block ends here" recurs through them, drawn straight in the clean look and by hand in the
// notebook. The rest — a device, a comparison, a piece of the founder's own footage — fill the frame instead.
export function sceneHtml(shot: Shot, index: number, shape: Shape, captioned = false): string {
  const { scene } = shot;
  const heading = scene.heading?.trim() ?? '';
  const text = scene.text?.trim() ?? '';
  const parts: string[] = [];
  if (scene.layout === 'title') {
    parts.push(`<h1 class="display rise" data-mark="highlight">${html(heading)}</h1>`, '<div class="rule" data-mark="dash"></div>');
    if (text) parts.push(`<p class="lead quiet rise">${html(text)}</p>`);
    return `<div class="frame frame--title" id="f${index}">${parts.join('')}</div>`;
  } else if (scene.layout === 'hook') {
    if (heading) parts.push(`<p class="label rise">${html(heading)}</p>`);
    parts.push(`<p class="${hookWeight(text)} rise" data-mark="highlight">${html(text)}</p>`);
    return `<div class="frame frame--hook" id="f${index}">${parts.join('')}</div>`;
  } else if (scene.layout === 'statement') {
    if (heading) parts.push(`<p class="label quiet rise">${html(heading)}</p>`);
    parts.push(`<p class="${weight(text)} rise">${html(text)}</p>`, '<div class="rule" data-mark="dash"></div>');
  } else if (scene.layout === 'bullets') {
    if (heading) parts.push(`<h2 class="heading rise">${html(heading)}</h2>`, '<div class="rule" data-mark="dash"></div>');
    parts.push(`<ul class="list">${(scene.bullets ?? []).map((one) => `<li class="rise"><span class="tick" data-mark="dash"></span><span class="body">${html(one)}</span></li>`).join('')}</ul>`);
  } else if (scene.layout === 'checklist') {
    if (heading) parts.push(`<h2 class="heading rise">${html(heading)}</h2>`, '<div class="rule" data-mark="dash"></div>');
    parts.push(`<ul class="list list--check">${(scene.bullets ?? []).map((one) => `<li class="rise"><span class="mark">${CHECK}</span><span class="body">${html(one)}</span></li>`).join('')}</ul>`);
  } else if (scene.layout === 'steps') {
    if (heading) parts.push(`<h2 class="heading rise">${html(heading)}</h2>`, '<div class="rule" data-mark="dash"></div>');
    parts.push(`<ul class="list list--steps">${(scene.bullets ?? []).map((one, at) => `<li class="rise"><span class="step">${at + 1}</span><span class="body">${html(one)}</span></li>`).join('')}</ul>`);
  } else if (scene.layout === 'compare') {
    const labels = scene.labels ?? [];
    const sides = (scene.bullets ?? []).slice(0, 2).map((one, at) => `<div class="side${at === 1 ? ' side--after' : ''}" id="p${index}-${at}">`
      + `<p class="label">${html(labels[at] ?? (at === 0 ? 'Before' : 'After'))}</p><p class="body">${html(one)}</p></div>`).join('');
    if (heading) parts.push(`<h2 class="heading rise">${html(heading)}</h2>`);
    parts.push(`<div class="compare">${sides}</div>`);
  } else if (scene.layout === 'picture') {
    parts.push(`<div class="shot" data-mark="frame"><img src="assets/${shot.image}" alt="" data-layout-allow-overflow></div>`);
    if (text) parts.push(`<div class="plate"><p class="lead rise">${html(text)}</p></div>`);
    return `<div class="frame frame--picture${text ? ' frame--captioned' : ''}${captioned ? ' has-caps' : ''}" id="f${index}">${parts.join('')}</div>`;
  } else if (MOVING.has(scene.layout)) {
    // The moving picture itself is not written here. A <video> carrying its own start may not sit inside a section
    // that carries one too — the renderer resolves the two against different clocks and shows the wrong frames — so
    // it is written as an element of the film in its own right and this is only what goes over it.
    if (!shot.video && shot.image) {
      parts.push(`<div class="${scene.layout === 'presenter' ? 'presenter' : 'shot'}" data-mark="frame"><img src="assets/${shot.image}" alt="" data-layout-allow-overflow></div>`);
    }
    if (text) parts.push(`<div class="plate"><p class="lead rise">${html(text)}</p></div>`);
    return `<div class="frame frame--picture${text ? ' frame--captioned' : ''}${captioned ? ' has-caps' : ''}" id="f${index}">${parts.join('')}</div>`;
  } else if (scene.layout === 'device') {
    parts.push(device(shot, shape));
    if (heading) parts.push(`<h2 class="heading rise">${html(heading)}</h2>`);
    else if (text && frameOf(scene, shape) !== 'browser') parts.push(`<p class="lead quiet rise">${html(text)}</p>`);
    return `<div class="frame frame--device" id="f${index}">${parts.join('')}</div>`;
  } else if (scene.layout === 'stat') {
    // The ring around the figure is mark enough in the notebook: the line under it stays a straight one, or nothing.
    parts.push(figure(heading, shape), '<div class="rule"></div>');
    if (text) parts.push(`<p class="lead quiet rise">${html(text)}</p>`);
    return `<div class="frame frame--stat" id="f${index}">${parts.join('')}</div>`;
  } else if (scene.layout === 'quote') {
    parts.push(`<blockquote class="quote rise" data-mark="bar">${html(quoted(text))}</blockquote>`);
    if (heading) parts.push(`<p class="label quiet rise">— ${html(heading)}</p>`);
  } else if (scene.layout === 'logo') {
    parts.push(shot.image ? `<div class="logo rise" data-mark="ring"><img src="assets/${shot.image}" alt=""></div>` : `<p class="logo rise" data-mark="ring">${html(heading)}</p>`, '<div class="rule" data-mark="dash"></div>');
    if (text) parts.push(`<p class="lead quiet rise">${html(text)}</p>`);
    return `<div class="frame frame--logo" id="f${index}">${parts.join('')}</div>`;
  } else if (scene.layout === 'cta') {
    parts.push(`<p class="${weight(text || heading)} rise">${html(text || heading)}</p>`);
    if (text && heading) parts.push(`<p class="cta rise" data-mark="highlight">${html(heading)}</p>`);
    return `<div class="frame frame--cta" id="f${index}">${parts.join('')}</div>`;
  } else {
    parts.push('<div class="rule" data-mark="dash"></div>', `<h2 class="${weight(text || heading)} rise">${html(text || heading)}</h2>`);
    if (text && heading) parts.push(`<p class="label quiet rise">${html(heading)}</p>`);
  }
  return `<div class="frame" id="f${index}">${parts.join('')}</div>`;
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
export function sceneSteps(shot: Shot, index: number, at: number, scale: number, look: Look, last: boolean, pace: Pace = 'calm'): string[] {
  const steps: string[] = [];
  const beat = PACE[pace];
  const time = (offset: number) => (at + offset).toFixed(3);
  const layout = shot.scene.layout;
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
    // A screenshot is taller than its glass, so the scene slowly reads down the page it was taken of.
    steps.push(`tl.fromTo("#s${index} .device__glass img", { yPercent: 0, scale: 1 }, { yPercent: -8, scale: 1.05, duration: ${shot.seconds.toFixed(3)}, ease: "none" }, ${time(0)});`);
  }
  steps.push(`tl.fromTo("#s${index} .rise", { y: ${Math.round(beat.travel * scale)}, opacity: 0 }, { y: 0, opacity: 1, duration: ${beat.rise.toFixed(2)}, ease: "${beat.ease}", stagger: ${beat.stagger} }, ${time(0)});`);
  // The two halves of a comparison are not one thing: the second arrives after the first has been read.
  if (layout === 'compare') {
    steps.push(`tl.fromTo("#p${index}-0", { x: ${-Math.round(beat.travel * 0.8)}, opacity: 0 }, { x: 0, opacity: 1, duration: ${beat.rise.toFixed(2)}, ease: "${beat.ease}" }, ${time(0.1)});`);
    steps.push(`tl.fromTo("#p${index}-1", { x: ${Math.round(beat.travel * 0.8)}, opacity: 0 }, { x: 0, opacity: 1, duration: ${beat.rise.toFixed(2)}, ease: "${beat.ease}" }, ${time(Math.min(1.5, shot.seconds * 0.42))});`);
  }
  // The figure on a stat scene runs up to itself, the way a counter settles on a number.
  const counted = layout === 'stat' && FIGURE.exec(shot.scene.heading?.trim() ?? '');
  if (counted) steps.push(`tl.fromTo("#s${index} .count", { textContent: 0 }, { textContent: ${counted[2]}, duration: ${Math.min(1.5, shot.seconds * 0.45).toFixed(2)}, ease: "power2.out", snap: { textContent: 1 } }, ${time(0.22)});`);
  // In the notebook the same lines are drawn by hand instead, which the marks script animates.
  const straight = look === 'sketch' ? [] : [hasRule(shot.scene) && `#s${index} .rule`, hasTicks(shot.scene) && `#s${index} .tick`].filter(Boolean);
  if (straight.length) steps.push(`tl.fromTo("${straight.join(', ')}", { scaleX: 0 }, { scaleX: 1, duration: ${(beat.rise * 0.94).toFixed(2)}, ease: "${beat.ease}", stagger: 0.07 }, ${time(0.22)});`);
  if (layout === 'checklist') steps.push(`tl.fromTo("#s${index} .mark", { scale: 0, opacity: 0 }, { scale: 1, opacity: 1, duration: ${(beat.rise * 0.6).toFixed(2)}, ease: "back.out(2)", stagger: ${beat.stagger} }, ${time(0.2)});`);
  if (!last) {
    const targets = look === 'sketch' ? `["#f${index}", "#m${index}"]` : `"#f${index}"`;
    steps.push(`tl.to(${targets}, { opacity: 0, duration: ${beat.out.toFixed(2)}, ease: "power2.in" }, ${time(shot.seconds - beat.out)});`);
  }
  return steps;
}
