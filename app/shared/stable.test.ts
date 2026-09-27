import { describe, expect, it } from 'vitest';
import { stableJson } from './stable';

describe('stableJson', () => {
  it('writes the same text for the same value whatever order its keys were set in', () => {
    expect(stableJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe(stableJson({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }));
    expect(stableJson({ a: 1, gone: undefined })).toBe(stableJson({ a: 1 }));
  });
  it('still tells different values apart, and keeps the order of a list', () => {
    expect(stableJson({ a: 1 })).not.toBe(stableJson({ a: 2 }));
    expect(stableJson([1, 2])).not.toBe(stableJson([2, 1]));
    expect(stableJson('x')).toBe('"x"');
  });
});
