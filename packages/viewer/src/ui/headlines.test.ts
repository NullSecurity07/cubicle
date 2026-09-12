import { describe, it, expect } from 'vitest';
import { emptyState, applyEvent, type State, type CubicleEvent } from '../state.js';
import { headlineFor } from './surfaces.js';
import { cut } from './headlines.js';
import { tintFor, NIGHT_ALPHA } from './time.js';

const ev = (type: string, payload: Record<string, unknown>): CubicleEvent => ({ ts: '2026-09-03T12:00:00.000Z', type, agent: 'backend_engineer', job: null, payload });
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
    expect(tintFor(8)).toBe(0);
  });
  /**
   * Visual QA R2-I4: over a straight three-hour line 19:00 landed at a third, and the building measured 87 % of
   * noon under a sunset sky. Light goes fast once the sun is on the horizon, so the first hour takes half.
   */
  it('spends half the evening ramp in its first hour, so 19:00 is dusk and not late afternoon', () => {
    expect(tintFor(18)).toBe(0);
    expect(tintFor(19)).toBeCloseTo(NIGHT_ALPHA * 0.55);
    expect(tintFor(20)).toBeCloseTo(NIGHT_ALPHA * 0.82);
    expect(tintFor(21)).toBe(NIGHT_ALPHA);
    for (let h = 18; h < 21; h += 0.1) expect(tintFor(h), `${h}`).toBeLessThanOrEqual(tintFor(h + 0.1) + 1e-9);
  });
});

describe('cut', () => {
  it('ends on a whole word, never mid-word, where a word boundary fits', () => {
    expect(cut('What company will you start?', 18)).toBe('What company…');   // was 'What company wil…'
    expect(cut('Queue of proposals waiting for you', 10)).toBe('Queue of…');
    expect(cut('Board room', 9)).toBe('Board…');
  });
  it('leaves anything that already fits exactly alone, ellipsis included', () => {
    expect(cut('Board room', 10)).toBe('Board room');
    expect(cut('Board room', 40)).toBe('Board room');
    expect(cut('  Board \n  room ', 40)).toBe('Board room');   // whitespace is normalised first
  });
  it('still cuts a single word longer than the budget — there is no boundary to fall back to', () => {
    expect(cut('supercalifragilistic', 10)).toBe('supercali…');
    expect(cut('supercalifragilistic', 10).length).toBe(10);
  });
  it('keeps a partial word rather than leaving a near-empty line', () => {
    expect(cut('Deployment succeeded', 14)).toBe('Deployment…');            // the boundary is worth taking
    expect(cut('a verylongwordindeed', 12)).toBe('a verylongw…');            // trimming back to "a" would say nothing
  });
  it('never exceeds the budget', () => {
    const s = 'What company will you start? Tell the CEO and it begins.';
    for (let n = 2; n < 40; n++) expect(cut(s, n).length, `n=${n}`).toBeLessThanOrEqual(n);
  });
});
