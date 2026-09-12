import { describe, it, expect } from 'vitest';
import { FRAMES, POSES, frameIndex, frameFor, poseFor, faceFrame, talkOpen, WALK_FRAMES, WALK_STEP_MS, BOB, type PoseCtx } from './frames.js';
import type { AgentView } from '../state.js';

const view = (o: Partial<AgentView> = {}): AgentView => ({ role: 'sre', display: 'SRE', sprite: 'sre', desk: 'sre', active: true, state: 'idle_at_desk', tool: null, job: null, bubble: null, target: null, badge: null, mood: 'neutral', moodUntil: null, emote: null, idleSince: null, checking: null, division: 'other', family: 'member', ...o });
const ctx = (o: Partial<PoseCtx> = {}): PoseCtx => ({ atDesk: true, riding: false, sideSeat: null, nowMs: 0, gesture: 'none', detour: null, ...o });

describe('frame table', () => {
  it('has 31 unique frames: 4 idle, 16 walk, 11 poses', () => {
    expect(FRAMES).toHaveLength(31); expect(new Set(FRAMES).size).toBe(31);
    expect(FRAMES.slice(0, 4)).toEqual(['idle:0', 'idle:1', 'idle:2', 'idle:3']);
    expect(FRAMES[4]).toBe('walk:0:0'); expect(FRAMES[19]).toBe('walk:3:3');
    expect(FRAMES.slice(20)).toEqual(POSES.map((p) => `pose:${p}`));
    expect(frameIndex('pose:ride')).toBe(28); expect(frameIndex('nope')).toBe(0);
    expect(WALK_FRAMES).toBe(4); expect(WALK_STEP_MS).toBe(110); expect(BOB).toEqual([0, -1, 0, -1]);
  });
  it('frameFor picks walk, idle or pose', () => {
    expect(frameFor({ moving: true, dir: 2, step: 5 })).toBe('walk:2:1');
    expect(frameFor({ moving: false, dir: 3, step: 0 })).toBe('idle:3');
    expect(frameFor({ moving: false, dir: 0, step: 0, pose: 'coffee' })).toBe('pose:coffee');
    expect(frameFor({ moving: true, dir: 0, step: 0, pose: 'ride' })).toBe('pose:ride');   // a pose wins over movement
  });
});

describe('poseFor', () => {
  it('riding, coffee and wave come first', () => {
    expect(poseFor(view(), ctx({ riding: true }))).toBe('ride');
    expect(poseFor(view(), ctx({ detour: 'coffee' }))).toBe('coffee');
    expect(poseFor(view(), ctx({ detour: 'sit' }))).toBe('coffee');
    expect(poseFor(view({ emote: { kind: 'wave', until: 1 } }), ctx({ atDesk: false }))).toBe('wave');
  });
  it('at the desk: typing alternates while working, read for docs, phone for chat and mail, seated otherwise', () => {
    expect(poseFor(view({ state: 'working' }), ctx({ nowMs: 0 }))).toBe('typing_a');
    expect(poseFor(view({ state: 'working' }), ctx({ nowMs: 150 }))).toBe('typing_b');
    expect(poseFor(view({ state: 'working', tool: 'doc' }), ctx())).toBe('read');
    expect(poseFor(view({ state: 'working', tool: 'chat' }), ctx())).toBe('phone');
    expect(poseFor(view({ state: 'talking', tool: 'envelope' }), ctx())).toBe('phone');
    expect(poseFor(view(), ctx())).toBe('seated');
    expect(poseFor(view(), ctx({ gesture: 'stretch' }))).toBe('stretch');
    expect(poseFor(view(), ctx({ gesture: 'yawn' }))).toBe('stretch');
  });
  it('side seats and standing', () => {
    expect(poseFor(view({ target: 'boardroom' }), ctx({ atDesk: false, sideSeat: 'l' }))).toBe('sit_side_l');
    expect(poseFor(view({ target: 'meetingroom' }), ctx({ atDesk: false, sideSeat: 'r' }))).toBe('sit_side_r');
    expect(poseFor(view({ state: 'working', target: 'billboard' }), ctx({ atDesk: false }))).toBeNull();
  });
});

describe('faces', () => {
  it('names mood, direction, talk and glasses', () => {
    expect(faceFrame('happy', 1, {})).toBe('happy:1');
    expect(faceFrame('neutral', 0, { talk: true })).toBe('neutral:0:talk');
    expect(faceFrame('worried', 2, { glasses: true })).toBe('worried:2:g');
    expect(faceFrame('thinking', 0, { talk: true, glasses: true })).toBe('thinking:0:talk:g');
  });
  it('the mouth toggles every 140 ms for the first 2.5 s of a bubble', () => {
    expect(talkOpen(0, 0)).toBe(true); expect(talkOpen(140, 0)).toBe(false); expect(talkOpen(280, 0)).toBe(true);
    expect(talkOpen(2600, 0)).toBe(false); expect(talkOpen(2600 + 280, 2600)).toBe(true);
  });
});
