import { describe, it, expect } from 'vitest';
import { emptyState, applyEvent, type State, type CubicleEvent } from '../state.js';
import { headlineFor } from './surfaces.js';
import { tintFor, NIGHT_ALPHA } from './time.js';

const ev = (type: string, payload: Record<string, unknown>): CubicleEvent => ({ ts: '2026-09-03T12:00:00.000Z', type, agent: 'engineer', job: null, payload });
const withTerminal = (lines: string[]): State => lines.reduce((s, text) => applyEvent(s, ev('shell.output', { text })), emptyState());

describe('in-world previews', () => {
  it('the terminal shed shows the last three output lines, cut to the box width', () => {
    const s = withTerminal(['one', 'two', 'three', 'four', 'a line long enough that the preview has to cut it before it reaches the wall']);
    const h = headlineFor('terminal', s);
    expect(h.head).toBe('Shell');
    expect(h.lines).toHaveLength(3);
    expect(h.lines[0]).toBe('three');
    expect(h.lines.at(-1)).toMatch(/…$/);
    for (const l of h.lines) expect(l.length).toBeLessThanOrEqual(44);
    expect(headlineFor('terminal', emptyState()).head).toBe('Shell idle');
  });

  it('an unregistered surface falls back to its own name rather than throwing', () => {
    expect(headlineFor('nowhere', emptyState())).toEqual({ head: 'nowhere', lines: [] });
  });
});

describe('day / night tint', () => {
  it('is clear during the working day and dark at night', () => {
    expect(tintFor(13)).toBe(0);
    expect(tintFor(2)).toBe(NIGHT_ALPHA);
    expect(tintFor(23)).toBe(NIGHT_ALPHA);
  });
  it('fades in at dusk and out at dawn', () => {
    expect(tintFor(7)).toBeCloseTo(NIGHT_ALPHA / 2);
    expect(tintFor(19.5)).toBeCloseTo(NIGHT_ALPHA / 2);
    expect(tintFor(8)).toBe(0);
  });
});
