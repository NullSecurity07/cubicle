import { describe, it, expect } from 'vitest';
import { loadGates, gatesFor, criteriaFor } from '../src/gates.js';
import { KNOWN_JOB_TYPES } from '../src/schemas.js';

describe('config/gates.yaml covers every known job type', () => {
  const table = loadGates();

  it('every job type has its own gates entry, not the custom fallback', () => {
    const missing = KNOWN_JOB_TYPES.filter((t) => !Object.prototype.hasOwnProperty.call(table, t));
    expect(missing).toEqual([]);
  });

  it('colleague.answer is a gate-free job type with criteria', () => {
    expect(KNOWN_JOB_TYPES).toContain('colleague.answer');
    expect(gatesFor(table, 'colleague.answer')).toEqual([]);
    expect(criteriaFor(table, 'colleague.answer')).toBe('The question is answered with colleague.message(re:<id>)');
  });

  it('the office and room gates are declared, and the pre-office names still resolve', () => {
    for (const t of ['team:qa.review', 'office:operations.verify', 'office:security.review', 'division.plan', 'board.premortem', 'qa.review', 'coo.verify', 'security.review']) {
      expect(Object.prototype.hasOwnProperty.call(table, t), t).toBe(true);
      expect(gatesFor(table, t)).toEqual([]);
    }
    expect(gatesFor(table, 'engineer.ship')).toEqual(['team:qa.review', 'office:operations.verify']);
    expect(gatesFor(table, 'custom')).toEqual(['office:operations.verify']);
    // SP6/SP7 keys survive the rename
    expect(gatesFor(table, 'research')).toEqual(['research.review', 'requester.review']);
    expect(gatesFor(table, 'incident')).toEqual(['office:operations.verify']);
  });
});
