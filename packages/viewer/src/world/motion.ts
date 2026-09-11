/** The one duration / easing table (visual notes §1 "Motion", §4). Phaser tweens read `dur(DUR.x)` so reduced motion scales everything at once. */
export const DUR = { micro: 120, open: 200, sheet: 280, reader: 360, zoom: 120, pan: 420, depart: 100, settle: 90, bubbleIn: 160, bubbleOut: 120, wipe: 120, crossfade: 80, minimapPan: 300, talkToggle: 140, talkFor: 2500, doorSlide: 150, livePulse: 1000 } as const;
export const EASE = { out: 'Cubic.easeOut', in: 'Cubic.easeIn', inOut: 'Cubic.easeInOut', spring: 'Back.easeOut', sine: 'Sine.easeInOut' } as const;
/** `scale` 1 = full motion, 0 = reduced motion (every tween becomes 1 ms; walking and the elevator still move, they are state, not decoration). */
export const MOTION = { scale: 1 };
export function withMotion(scale: number): void { MOTION.scale = Math.max(0, scale); }
export function dur(ms: number): number { return Math.max(1, Math.round(ms * MOTION.scale)); }
/**
 * True when motion is off. A tween that repeats forever must be *removed* here, not shortened: `dur()` floors at
 * 1 ms, so an infinite yoyo would become a per-frame alpha flip — a strobe, the opposite of reduced motion.
 * Callers that loop (`repeat: -1`) check this, set the resting value and add no tween at all.
 */
export function motionOff(): boolean { return MOTION.scale === 0; }
export function reducedMotion(mm: ((q: string) => { matches: boolean }) | undefined = typeof matchMedia === 'function' ? matchMedia.bind(globalThis) : undefined): boolean { return mm ? mm('(prefers-reduced-motion: reduce)').matches : false; }
