import { describe, it, expect } from 'vitest';
import { nextBlinkDelay, nextGestureDelay, pickGesture, walkBob, typingFrame, emoteBob, faceToward, thinkingDots, GESTURE_MS } from './expressions.js';

describe('sprite small life', () => {
  it('blink and gesture delays stay inside their bands', () => {
    for (const r of [0, 0.5, 0.999]) {
      expect(nextBlinkDelay(r)).toBeGreaterThanOrEqual(2); expect(nextBlinkDelay(r)).toBeLessThan(6.01);
      expect(nextGestureDelay(r)).toBeGreaterThanOrEqual(6); expect(nextGestureDelay(r)).toBeLessThan(14.01);
    }
  });
  it('a sleeper only yawns; an idle agent glances more than it stretches; every gesture has a duration', () => {
    expect(['yawn', 'none']).toContain(pickGesture(0.1, 'asleep'));
    expect(pickGesture(0.9, 'asleep')).toBe('none');
    expect(pickGesture(0.1, 'neutral')).toBe('look_left');
    expect(pickGesture(0.5, 'neutral')).toBe('look_right');
    expect(pickGesture(0.8, 'neutral')).toBe('stretch');
    expect(pickGesture(0.95, 'neutral')).toBe('none');
    for (const g of ['stretch', 'look_left', 'look_right', 'yawn'] as const) expect(GESTURE_MS[g]).toBeGreaterThan(0);
  });
  it('bobs alternate between 0 and a small lift; typing alternates hands; dots cycle 1→3', () => {
    expect(new Set([walkBob(0), walkBob(6), walkBob(12)])).toEqual(new Set([0, -1]));
    expect(new Set([emoteBob(0), emoteBob(400)])).toEqual(new Set([0, -2]));
    expect(typingFrame(0)).not.toBe(typingFrame(150));
    expect([thinkingDots(0), thinkingDots(350), thinkingDots(700)]).toEqual(['·', '··', '···']);
  });
  it('a seated agent turns towards the speaker', () => {
    const me = { x: 100, y: 100 };
    expect(faceToward(me, { x: 60, y: 100 })).toBe(1);
    expect(faceToward(me, { x: 140, y: 90 })).toBe(2);
    expect(faceToward(me, { x: 102, y: 120 })).toBe(0);
  });
});
