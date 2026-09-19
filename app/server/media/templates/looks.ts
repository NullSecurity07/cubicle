import type { Shape } from '../../../shared/model.ts';

// The three shapes a video can be, and how big everything in it is drawn. `scale` multiplies the whole type scale so a
// tall phone video is not the wide one with the words falling off the sides — a phone is read at arm's length, so its
// words are larger against their frame, not smaller. `lift` is how much air is left under a block: type centred on the
// middle of the frame looks low, so every block sits a little above it.
export const FORMATS: Record<Shape, { width: number; height: number; scale: number; margin: number; lift: number }> = {
  wide: { width: 1280, height: 720, scale: 1, margin: 96, lift: 56 },
  tall: { width: 720, height: 1280, scale: 0.9, margin: 68, lift: 110 },
  square: { width: 1080, height: 1080, scale: 0.94, margin: 92, lift: 58 },
};

export const LOOKS = ['clean', 'sketch'] as const;
export type Look = (typeof LOOKS)[number];

// Two ways a video can look, and only two. `clean` is the instrument panel: cold slate, brass, air, the type doing all
// the work. `sketch` is the notebook: paper, a blue pen, a yellow highlighter, every line drawn by hand.
export const PAINT: Record<Look, { ground: string; ink: string; quiet: string; signal: string; mark: string; scrim: string }> = {
  clean: { ground: '#1C2530', ink: '#F2F5F8', quiet: '#93A3B4', signal: '#E8B04B', mark: '#E8B04B', scrim: '28, 37, 48' },
  sketch: { ground: '#F4F0E6', ink: '#1F1D1A', quiet: '#6B6660', signal: '#2B54C8', mark: '#FFD24A', scrim: '244, 240, 230' },
};

// One type scale, set once, used everywhere: display, heading, lead, body, label, and the one big number. The sizes are
// written for something watched from across a room, not read on a page: on a wide frame a heading is a fifteenth of the
// height, a title a seventh, and the one number on a stat scene is over a third of it.
export function styleSheet(shape: Shape, look: Look): string {
  const { scale, margin, lift } = FORMATS[shape];
  const paint = PAINT[look];
  const sketch = look === 'sketch';
  return `
@font-face { font-family: 'Studio Sans'; src: url('vendor/inter.woff2') format('woff2-variations'); font-weight: 100 900; font-style: normal; font-display: block; }
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: 100%; height: 100%; overflow: hidden; background: ${paint.ground}; }
:root { --s: ${scale}; --margin: ${margin}px; --lift: ${lift}px; --ground: ${paint.ground}; --ink: ${paint.ink}; --quiet: ${paint.quiet}; --signal: ${paint.signal}; --mark: ${paint.mark}; }
#root { position: relative; width: 100%; height: 100%; overflow: hidden; background: ${paint.ground}; color: ${paint.ink};
  font-family: 'Studio Sans', sans-serif; font-synthesis: none; -webkit-font-smoothing: antialiased; }
.clip { position: absolute; inset: 0; }
.marks { position: absolute; inset: 0; width: 100%; height: 100%; }
/* Every scene is the same asymmetric block: one left margin, the words stacked down it, nothing centred for its own
   sake. The block is set a little above the middle, because type centred on the middle of a frame reads as low. */
.frame { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: flex-start; justify-content: center;
  padding: var(--margin) var(--margin) calc(var(--margin) + var(--lift)); gap: calc(var(--margin) * 0.32); }
.frame > * { position: relative; }
/* A title card is set on the foot of the frame instead, with the air above it, the way a poster is. */
.frame--title { justify-content: flex-end; padding-bottom: calc(var(--margin) * 1.05); }
/* A figure that size carries its own lift: the digits stand well above their line and nothing hangs below them. */
.frame--stat { padding-bottom: var(--margin); }
.display { font-size: calc(112px * var(--s)); line-height: 1.0; letter-spacing: -0.038em; font-weight: 660; max-width: 10.5em; overflow-wrap: break-word; }
.heading { font-size: calc(68px * var(--s)); line-height: 1.08; letter-spacing: -0.03em; font-weight: 630; max-width: 13.5em; overflow-wrap: break-word; }
.lead { font-size: calc(38px * var(--s)); line-height: 1.3; letter-spacing: -0.016em; font-weight: 450; max-width: 22em; overflow-wrap: break-word; }
.body { font-size: calc(34px * var(--s)); line-height: 1.32; letter-spacing: -0.012em; font-weight: 440; max-width: 20em; overflow-wrap: break-word; }
.label { font-size: calc(22px * var(--s)); line-height: 1.3; font-weight: 620; text-transform: uppercase; letter-spacing: 0.1em; }
/* The one number a stat scene carries is the scene: everything else on it is a caption to the number. */
.stat { font-size: calc(300px * var(--s)); line-height: 0.88; letter-spacing: -0.052em; font-weight: 680; color: ${sketch ? paint.ink : paint.signal};
  font-variant-numeric: tabular-nums; white-space: nowrap; }
/* The figure counts up to itself, so the digits are held to their final width and nothing beside them shifts. */
.count { display: inline-block; text-align: right; }
.quote { font-size: calc(62px * var(--s)); line-height: 1.18; letter-spacing: -0.024em; font-weight: 520; max-width: 12.5em;
  border-left: ${sketch ? 'transparent' : paint.signal} solid calc(5px * var(--s)); padding-left: calc(var(--margin) * 0.5); overflow-wrap: break-word; }
.quiet { color: ${paint.quiet}; }
/* The one piece of structure that recurs: a short measured bar that says the block ends here. Drawn by hand in the notebook. */
.rule { flex: none; width: calc(176px * var(--s)); height: calc(5px * var(--s)); transform-origin: 0 50%; background: ${sketch ? 'transparent' : paint.signal}; }
.list { list-style: none; display: flex; flex-direction: column; gap: calc(var(--margin) * 0.34); }
.list li { display: flex; align-items: baseline; gap: calc(34px * var(--s)); }
.tick { flex: none; position: relative; top: -0.3em; width: calc(34px * var(--s)); height: calc(4px * var(--s)); transform-origin: 0 50%; background: ${sketch ? 'transparent' : paint.signal}; }
/* A picture fills the frame in the clean look and is taped onto the page, with a margin, in the notebook. */
.shot { position: absolute; inset: ${sketch ? 'calc(var(--margin) * 0.72)' : '0'}; overflow: hidden; }
${sketch ? '.frame--captioned .shot { bottom: calc(var(--margin) * 2.2); }' : ''}
.shot img { display: block; width: 100%; height: 100%; object-fit: cover; transform-origin: 50% 50%; }
.plate { position: absolute; left: 0; right: 0; bottom: 0; padding: var(--margin); padding-top: calc(var(--margin) * 1.7);
  background: ${sketch ? 'none' : `linear-gradient(to top, rgb(${paint.scrim}) 12%, rgba(${paint.scrim}, 0.74) 56%, rgba(${paint.scrim}, 0) 100%)`}; }
.frame--picture { justify-content: flex-end; padding: 0; gap: 0; }
`.trim();
}
