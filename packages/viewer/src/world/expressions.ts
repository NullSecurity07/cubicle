/**
 * Timing and choice helpers for the sprites' small life: blinks, idle gestures, the walking bob, meeting glances.
 * Pure functions of a random number / clock so they are testable and replay-speed friendly.
 */
export const BLINK_MS = 120;
export const GESTURE_MS: Record<Gesture, number> = { none: 0, stretch: 1200, look_left: 900, look_right: 900, yawn: 1000 };
export type Gesture = 'none' | 'stretch' | 'look_left' | 'look_right' | 'yawn';

/** Seconds until the next blink: 2–6 s, never two within a second. */
export function nextBlinkDelay(rand = Math.random()): number { return 2 + rand * 4; }

/** Seconds until the next idle gesture at the desk: 6–14 s. */
export function nextGestureDelay(rand = Math.random()): number { return 6 + rand * 8; }

/** What an idle agent does next; a sleeper only yawns, everyone else mostly glances around and sometimes stretches. */
export function pickGesture(rand: number, mood: string): Gesture {
  if (mood === 'asleep') return rand < 0.3 ? 'yawn' : 'none';
  if (rand < 0.35) return 'look_left';
  if (rand < 0.7) return 'look_right';
  if (rand < 0.9) return 'stretch';
  return 'none';
}

/** Vertical bob while walking: 0 or -1 px, from the distance walked. */
export function walkBob(distancePx: number): number { return Math.floor(distancePx / 6) % 2 === 0 ? 0 : -1; }

/** Typing hands alternate every 150 ms while working at the desk. */
export function typingFrame(nowMs: number): 0 | 1 { return Math.floor(nowMs / 150) % 2 === 0 ? 0 : 1; }

/** Emote icons hover: a slow 2 px bob. */
export function emoteBob(nowMs: number): number { return Math.floor(nowMs / 400) % 2 === 0 ? 0 : -2; }

/** Which way a seated sprite turns to look at a speaker: 1 = left, 2 = right, 0 = towards the viewer (speaker below/near). */
export function faceToward(me: { x: number; y: number }, speaker: { x: number; y: number }): 0 | 1 | 2 {
  const dx = speaker.x - me.x, dy = speaker.y - me.y;
  if (Math.abs(dx) < 6 && dy >= 0) return 0;
  if (Math.abs(dx) >= 6) return dx < 0 ? 1 : 2;
  return 0;
}

/** Thought-bubble dots: "·", "··", "···" cycling every 350 ms. */
export function thinkingDots(nowMs: number): string { return '···'.slice(0, 1 + (Math.floor(nowMs / 350) % 3)); }
