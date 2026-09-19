import type { Shape } from '../../../shared/model.ts';
import { sceneHtml, sceneSteps, type Shot } from './layouts.ts';
import { FORMATS, styleSheet, type Look } from './looks.ts';

export { FORMATS, LOOKS, PAINT, type Look } from './looks.ts';
export type { Shot } from './layouts.ts';

// A scene lasts as long as the line said over it, and never less than the time it takes to read what is on it.
const LEAD = 0.35;
const TAIL = 0.65;
const READ = 2.9;
export function sceneSeconds(words: string, spoken: number): number {
  const count = words.trim().split(/\s+/).filter(Boolean).length;
  const readable = Math.min(11, Math.max(2.8, count / READ + 1.6));
  return Math.round(Math.max(readable, spoken ? spoken + LEAD + TAIL : 0) * 100) / 100;
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

// The whole video as one HTML file: the scenes in order with their timing on them, the narration beside them, and one
// paused timeline the renderer steps through frame by frame.
export function composition(film: { title: string; shape: Shape; look: Look; shots: Shot[] }): string {
  const { width, height, scale } = FORMATS[film.shape];
  const sketch = film.look === 'sketch';
  const starts: number[] = [];
  let at = 0;
  for (const shot of film.shots) { starts.push(Math.round(at * 100) / 100); at = Math.round((at + shot.seconds) * 100) / 100; }
  const total = at;

  const sections = film.shots.map((shot, index) => `      <section class="clip" id="s${index}" data-start="${starts[index]}" data-duration="${shot.seconds}">`
    + `${sketch ? `<svg class="marks" id="m${index}" viewBox="0 0 ${width} ${height}"></svg>` : ''}${sceneHtml(shot, index, film.shape)}</section>`);
  // Every sound needs an id of its own or the mixer never finds it and the film comes out silent.
  const sounds = film.shots.flatMap((shot, index) => (shot.voice
    ? [`      <audio id="say${index}" src="assets/${shot.voice.file}" data-start="${(starts[index] + 0.35).toFixed(2)}" data-duration="${shot.voice.seconds.toFixed(2)}" data-volume="1"></audio>`]
    : []));
  const steps = film.shots.flatMap((shot, index) => sceneSteps(shot, index, starts[index], scale, film.look, index === film.shots.length - 1));

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${width}, height=${height}" />
    <title>${film.title.replace(/[<>&]/g, ' ')}</title>
    <script src="vendor/gsap.min.js"></script>
${sketch ? '    <script src="vendor/rough.js"></script>\n' : ''}    <style>
${styleSheet(film.shape, film.look)}
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-width="${width}" data-height="${height}" data-duration="${total}">
${sections.join('\n')}
${sounds.join('\n')}
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
