import { describe, it, expect, afterEach } from 'vitest';
import { DUR, EASE, MOTION, withMotion, dur, reducedMotion } from './motion.js';

afterEach(() => withMotion(1));

describe('motion table', () => {
  it('has the spec durations and easings', () => {
    expect(DUR.micro).toBe(120); expect(DUR.open).toBe(200); expect(DUR.sheet).toBe(280); expect(DUR.reader).toBe(360);
    expect(DUR.pan).toBe(420); expect(DUR.zoom).toBe(120); expect(DUR.depart).toBe(100); expect(DUR.settle).toBe(90);
    expect(EASE.spring).toBe('Back.easeOut'); expect(EASE.inOut).toBe('Cubic.easeInOut');
  });
  it('reduced motion scales every duration to 1 ms but never to 0', () => {
    expect(dur(DUR.pan)).toBe(420);
    withMotion(0); expect(MOTION.scale).toBe(0); expect(dur(DUR.pan)).toBe(1); expect(dur(DUR.zoom)).toBe(1);
    withMotion(0.5); expect(dur(200)).toBe(100);
  });
  it('reducedMotion reads the media query and defaults to false', () => {
    expect(reducedMotion(() => ({ matches: true }))).toBe(true);
    expect(reducedMotion(() => ({ matches: false }))).toBe(false);
    expect(reducedMotion(undefined)).toBe(false);
  });
});
