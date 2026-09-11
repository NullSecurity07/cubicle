/**
 * Named sprite frames and the rules that choose one. Pure: agents.ts asks `poseFor` what a sprite is doing and
 * `frameFor` which frame that is; the sheet (`sprite-draw.ts`) is drawn in `FRAMES` order so `frameIndex` is the
 * column. Faces are a separate overlay sheet named by `faceFrame`.
 */
import type { AgentView, Mood } from '../state.js';
import { typingFrame } from './expressions.js';
import { DUR } from './motion.js';

export type Dir = 0 | 1 | 2 | 3;
export const POSES = ['seated', 'typing_a', 'typing_b', 'read', 'phone', 'coffee', 'wave', 'stretch', 'ride', 'sit_side_l', 'sit_side_r'] as const;
export type Pose = typeof POSES[number];
export const WALK_FRAMES = 4;
export const WALK_STEP_MS = 110;
/** Vertical bob per walk step: contact, pass, contact, pass. */
export const BOB = [0, -1, 0, -1] as const;
/** How long a speech bubble keeps the mouth animating, and how often it toggles (ms). */
const TALK_FOR_MS = DUR.talkFor;
const TALK_TOGGLE_MS = DUR.talkToggle;

export const FRAMES: readonly string[] = [
  ...[0, 1, 2, 3].map((d) => `idle:${d}`),
  ...[0, 1, 2, 3].flatMap((d) => [0, 1, 2, 3].map((s) => `walk:${d}:${s}`)),
  ...POSES.map((p) => `pose:${p}`),
];
const INDEX = new Map(FRAMES.map((n, i) => [n, i]));
export function frameIndex(name: string): number { return INDEX.get(name) ?? 0; }

export function frameFor(o: { moving: boolean; dir: Dir; step: number; pose?: Pose | null }): string {
  if (o.pose) return `pose:${o.pose}`;
  return o.moving ? `walk:${o.dir}:${((o.step % WALK_FRAMES) + WALK_FRAMES) % WALK_FRAMES}` : `idle:${o.dir}`;
}

export interface PoseCtx { atDesk: boolean; riding: boolean; sideSeat: 'l' | 'r' | null; nowMs: number; gesture: 'none' | 'stretch' | 'look_left' | 'look_right' | 'yawn'; detour: 'pantry' | 'sit' | 'coffee' | 'kitchen' | null }

/** What the body does right now, or null when the sprite simply stands (idle / walk frames apply). */
export function poseFor(view: AgentView, ctx: PoseCtx): Pose | null {
  if (ctx.riding) return 'ride';
  if (ctx.detour === 'coffee' || ctx.detour === 'sit') return 'coffee';
  if (view.emote?.kind === 'wave') return 'wave';
  if (ctx.sideSeat) return ctx.sideSeat === 'l' ? 'sit_side_l' : 'sit_side_r';
  if (!ctx.atDesk) return null;
  if (ctx.gesture === 'stretch' || ctx.gesture === 'yawn') return 'stretch';
  if (view.tool === 'doc') return 'read';
  if (view.tool === 'chat' || view.tool === 'envelope') return 'phone';
  if (view.state === 'working' || view.mood === 'thinking') return typingFrame(ctx.nowMs) === 0 ? 'typing_a' : 'typing_b';
  return 'seated';
}

export function faceFrame(mood: Mood | 'blink', dir: 0 | 1 | 2, o: { talk?: boolean; glasses?: boolean }): string { return `${mood}:${dir}${o.talk ? ':talk' : ''}${o.glasses ? ':g' : ''}`; }
/** Mouth open on even 140 ms ticks during the first 2.5 s after a speech bubble appeared. */
export function talkOpen(nowMs: number, bubbleSinceMs: number): boolean { const t = nowMs - bubbleSinceMs; return t >= 0 && t < TALK_FOR_MS && Math.floor(t / TALK_TOGGLE_MS) % 2 === 0; }
