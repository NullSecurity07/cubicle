import { describe, expect, it } from 'vitest';
import { REGRESSIONS, runRegressions } from './regressions.ts';

describe('the journeys\' defects that a check in code holds', () => {
  for (const one of REGRESSIONS) {
    it(one.defect, async () => {
      expect(await one.check()).toBeNull();
    });
  }

  it('says which case failed and why, and counts the rest as passed', async () => {
    const { passed, failed } = await runRegressions([
      { defect: 'holds', check: () => null },
      { defect: 'came back', check: () => 'got 5, want 3' },
      { defect: 'threw', check: () => { throw new Error('boom'); } },
    ]);
    expect(passed).toBe(1);
    expect(failed).toEqual([{ defect: 'came back', fault: 'got 5, want 3' }, { defect: 'threw', fault: 'threw: boom' }]);
  });
});
