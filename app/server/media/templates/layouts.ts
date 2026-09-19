import type { Scene } from '../video.ts';
import type { Look } from './looks.ts';

// One scene, ready to be written out: what was asked for, how long it is on screen, the still drawn for it and the
// narration recorded over it. `image` and `voice` are file names inside the project's own assets folder.
export type Shot = { scene: Scene; seconds: number; image?: string; voice?: { file: string; seconds: number } };

const html = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const quoted = (text: string) => `“${text.replace(/^["“]|["”]$/g, '')}”`;

// The seven shapes a scene can take. Each is the same left-aligned block with different weights in it; the one line that
// says "this block ends here" recurs through all of them, drawn straight in the clean look and by hand in the notebook.
export function sceneHtml(shot: Shot, index: number): string {
  const { scene } = shot;
  const heading = scene.heading?.trim() ?? '';
  const text = scene.text?.trim() ?? '';
  const parts: string[] = [];
  if (scene.layout === 'title') {
    parts.push(`<h1 class="display rise" data-mark="highlight">${html(heading)}</h1>`, '<div class="rule" data-mark="dash"></div>');
    if (text) parts.push(`<p class="lead quiet rise">${html(text)}</p>`);
  } else if (scene.layout === 'statement') {
    if (heading) parts.push(`<p class="label quiet rise">${html(heading)}</p>`);
    parts.push(`<p class="heading rise">${html(text)}</p>`, '<div class="rule" data-mark="dash"></div>');
  } else if (scene.layout === 'bullets') {
    if (heading) parts.push(`<h2 class="heading rise">${html(heading)}</h2>`, '<div class="rule" data-mark="dash"></div>');
    parts.push(`<ul class="list">${(scene.bullets ?? []).map((one) => `<li class="rise"><span class="tick" data-mark="dash"></span><span class="body">${html(one)}</span></li>`).join('')}</ul>`);
  } else if (scene.layout === 'picture') {
    parts.push(`<div class="shot" data-mark="frame"><img src="assets/${shot.image}" alt="" data-layout-allow-overflow></div>`);
    if (text) parts.push(`<div class="plate"><p class="lead rise">${html(text)}</p></div>`);
    return `<div class="frame frame--picture${text ? ' frame--captioned' : ''}" id="f${index}">${parts.join('')}</div>`;
  } else if (scene.layout === 'stat') {
    // The ring around the figure is mark enough in the notebook: the line under it stays a straight one, or nothing.
    parts.push(`<p class="stat rise" data-mark="ring">${html(heading)}</p>`, '<div class="rule"></div>');
    if (text) parts.push(`<p class="lead quiet rise">${html(text)}</p>`);
  } else if (scene.layout === 'quote') {
    parts.push(`<blockquote class="quote rise" data-mark="bar">${html(quoted(text))}</blockquote>`);
    if (heading) parts.push(`<p class="label quiet rise">— ${html(heading)}</p>`);
  } else {
    parts.push('<div class="rule" data-mark="dash"></div>', `<h2 class="heading rise">${html(text || heading)}</h2>`);
    if (text && heading) parts.push(`<p class="label quiet rise">${html(heading)}</p>`);
  }
  return `<div class="frame" id="f${index}">${parts.join('')}</div>`;
}

// Which scenes carry the recurring line, and which carry the little marks beside a list.
const hasRule = (scene: Scene) => scene.layout === 'title' || scene.layout === 'statement' || scene.layout === 'stat'
  || scene.layout === 'outro' || (scene.layout === 'bullets' && !!scene.heading?.trim());
const hasTicks = (scene: Scene) => scene.layout === 'bullets' && !!scene.bullets?.length;

// One orchestrated entrance a scene, and one fade out of it. Nothing moves that is not saying something arrived.
export function sceneSteps(shot: Shot, index: number, at: number, scale: number, look: Look, last: boolean): string[] {
  const steps: string[] = [];
  const time = (offset: number) => (at + offset).toFixed(3);
  if (shot.scene.layout === 'picture') {
    steps.push(`tl.fromTo("#s${index} .shot", { opacity: 0 }, { opacity: 1, duration: 0.7, ease: "power2.out" }, ${time(0)});`);
    // The only motion that runs the whole scene: a slow push into the picture, so a still does not sit dead on screen.
    steps.push(`tl.fromTo("#s${index} .shot img", { scale: 1 }, { scale: 1.1, duration: ${shot.seconds.toFixed(3)}, ease: "none" }, ${time(0)});`);
  }
  steps.push(`tl.fromTo("#s${index} .rise", { y: ${Math.round(34 * scale)}, opacity: 0 }, { y: 0, opacity: 1, duration: 0.58, ease: "power3.out", stagger: 0.08 }, ${time(0)});`);
  // In the notebook the same lines are drawn by hand instead, which the marks script animates.
  const straight = look === 'clean' ? [hasRule(shot.scene) && `#s${index} .rule`, hasTicks(shot.scene) && `#s${index} .tick`].filter(Boolean) : [];
  if (straight.length) steps.push(`tl.fromTo("${straight.join(', ')}", { scaleX: 0 }, { scaleX: 1, duration: 0.72, ease: "power2.inOut", stagger: 0.06 }, ${time(0.18)});`);
  if (!last) {
    const targets = look === 'sketch' ? `["#f${index}", "#m${index}"]` : `"#f${index}"`;
    steps.push(`tl.to(${targets}, { opacity: 0, duration: 0.3, ease: "power1.in" }, ${time(shot.seconds - 0.3)});`);
  }
  return steps;
}
