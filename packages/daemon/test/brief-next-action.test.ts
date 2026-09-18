import { describe, it, expect } from 'vitest';
import { nextActionLines } from '../src/heartbeat.js';

/**
 * The brief's `## Next action per team` block, after the 2026-09-14 dry-run.
 *
 * A company of ten teams with two jobs queued printed eight lines of "nothing queued" in a brief whose whole job
 * is to be read in a minute. The teams with work are lines; the rest are one line.
 */
describe('the brief’s next action per team', () => {
  it('gives a line to each team with work and one line to the rest', () => {
    const out = nextActionLines([
      { id: 'dev', next: 'Ship the scanner' },
      { id: 'qa', next: null },
      { id: 'sales', next: null },
      { id: 'research', next: 'Size the market' },
      { id: 'ops', next: null },
    ]);
    expect(out.split('\n')).toEqual([
      '- dev: Ship the scanner',
      '- research: Size the market',
      '- qa, sales, ops: nothing queued',
    ]);
  });

  it('says it once when nothing is queued anywhere', () => {
    expect(nextActionLines([{ id: 'dev', next: null }, { id: 'qa', next: null }])).toBe('- dev, qa: nothing queued');
    expect(nextActionLines([])).toBe('- nothing queued anywhere');
  });

  it('keeps the shape the next cycle reads back: one team, one colon, the action', () => {
    const line = nextActionLines([{ id: 'dev', next: 'Ship the scanner' }]);
    expect(/^- dev: (.+)$/.exec(line)?.[1]).toBe('Ship the scanner');
  });
});
