import type { Shape } from '../../../shared/model.ts';

// The three shapes a video can be, and how big everything in it is drawn. `scale` multiplies the whole type scale so a
// tall phone video is not the wide one with the words falling off the sides.
export const FORMATS: Record<Shape, { width: number; height: number; scale: number; margin: number }> = {
  wide: { width: 1280, height: 720, scale: 1, margin: 88 },
  tall: { width: 720, height: 1280, scale: 0.72, margin: 56 },
  square: { width: 1080, height: 1080, scale: 0.98, margin: 84 },
};

export const LOOKS = ['clean', 'sketch'] as const;
export type Look = (typeof LOOKS)[number];

// Two ways a video can look, and only two. `clean` is the instrument panel: cold slate, brass, air, the type doing all
// the work. `sketch` is the notebook: paper, a blue pen, a yellow highlighter, every line drawn by hand.
export const PAINT: Record<Look, { ground: string; ink: string; quiet: string; signal: string; mark: string; scrim: string }> = {
  clean: { ground: '#1C2530', ink: '#F2F5F8', quiet: '#93A3B4', signal: '#E8B04B', mark: '#E8B04B', scrim: '28, 37, 48' },
  sketch: { ground: '#F4F0E6', ink: '#1F1D1A', quiet: '#6B6660', signal: '#2B54C8', mark: '#FFD24A', scrim: '244, 240, 230' },
};

// One type scale, set once, used everywhere: display, heading, lead, body, label, and the one big number.
export function styleSheet(shape: Shape, look: Look): string {
  const { scale, margin } = FORMATS[shape];
  const paint = PAINT[look];
  const sketch = look === 'sketch';
  return `
@font-face { font-family: 'Studio Sans'; src: url('vendor/inter.woff2') format('woff2-variations'); font-weight: 100 900; font-style: normal; font-display: block; }
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: 100%; height: 100%; overflow: hidden; background: ${paint.ground}; }
:root { --s: ${scale}; --margin: ${margin}px; --ground: ${paint.ground}; --ink: ${paint.ink}; --quiet: ${paint.quiet}; --signal: ${paint.signal}; --mark: ${paint.mark}; }
#root { position: relative; width: 100%; height: 100%; overflow: hidden; background: ${paint.ground}; color: ${paint.ink};
  font-family: 'Studio Sans', sans-serif; font-synthesis: none; -webkit-font-smoothing: antialiased; }
.clip { position: absolute; inset: 0; }
.marks { position: absolute; inset: 0; width: 100%; height: 100%; }
/* Every scene is the same asymmetric block: one left margin, the words stacked down it, nothing centred for its own sake. */
.frame { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: flex-start; justify-content: center;
  padding: var(--margin); gap: calc(var(--margin) * 0.3); }
.frame > * { position: relative; }
.display { font-size: calc(84px * var(--s)); line-height: 1.04; letter-spacing: -0.034em; font-weight: 650; max-width: 15em; overflow-wrap: break-word; }
.heading { font-size: calc(52px * var(--s)); line-height: 1.1; letter-spacing: -0.026em; font-weight: 620; max-width: 16em; overflow-wrap: break-word; }
.lead { font-size: calc(32px * var(--s)); line-height: 1.34; letter-spacing: -0.012em; font-weight: 450; max-width: 21em; overflow-wrap: break-word; }
.body { font-size: calc(24px * var(--s)); line-height: 1.5; letter-spacing: -0.004em; font-weight: 420; max-width: 19em; overflow-wrap: break-word; }
.label { font-size: calc(18px * var(--s)); line-height: 1.35; font-weight: 540; }
.stat { font-size: calc(168px * var(--s)); line-height: 0.9; letter-spacing: -0.042em; font-weight: 660; color: ${sketch ? paint.ink : paint.signal}; }
.quote { font-size: calc(44px * var(--s)); line-height: 1.26; letter-spacing: -0.018em; font-weight: 500; max-width: 15em;
  border-left: 2px solid ${sketch ? 'transparent' : paint.signal}; padding-left: calc(var(--margin) * 0.42); overflow-wrap: break-word; }
.quiet { color: ${paint.quiet}; }
/* The one piece of structure that recurs: a line that says the block ends here. In the notebook it is drawn by hand instead. */
.rule { flex: none; width: 100%; height: 2px; transform-origin: 0 50%; background: ${sketch ? 'transparent' : paint.signal}; }
.list { list-style: none; display: flex; flex-direction: column; gap: calc(var(--margin) * 0.26); }
.list li { display: flex; align-items: baseline; gap: calc(26px * var(--s)); }
.tick { flex: none; position: relative; top: -0.34em; width: calc(22px * var(--s)); height: 2px; transform-origin: 0 50%; background: ${sketch ? 'transparent' : paint.signal}; }
/* A picture fills the frame in the clean look and is taped onto the page, with a margin, in the notebook. */
.shot { position: absolute; inset: ${sketch ? 'calc(var(--margin) * 0.9)' : '0'}; overflow: hidden; }
${sketch ? '.frame--captioned .shot { bottom: calc(var(--margin) * 3.6); }' : ''}
.shot img { display: block; width: 100%; height: 100%; object-fit: cover; transform-origin: 50% 50%; }
.plate { position: absolute; left: 0; right: 0; bottom: 0; padding: var(--margin); padding-top: calc(var(--margin) * 1.7);
  background: ${sketch ? 'none' : `linear-gradient(to top, rgb(${paint.scrim}) 10%, rgba(${paint.scrim}, 0.72) 52%, rgba(${paint.scrim}, 0) 100%)`}; }
.frame--picture { justify-content: flex-end; padding: 0; gap: 0; }
`.trim();
}
