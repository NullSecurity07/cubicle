import { describe, it, expect } from 'vitest';
import { unkeptIdeaFindings, unkeptForcesReturn, keptIdeasGoalBlock } from '../src/index.js';

describe('a plan that draws on ideas nobody kept (spec §4)', () => {
  it('returns the plan for a parked or scrapped idea and only warns about an undecided one', () => {
    expect(unkeptForcesReturn([{ decision: 'scrap' }])).toBe(true);
    expect(unkeptForcesReturn([{ decision: 'park' }])).toBe(true);
    expect(unkeptForcesReturn([{ decision: 'undecided' }])).toBe(false);
    expect(unkeptForcesReturn([])).toBe(false);
    // One parked idea among undecided ones is still a return: the company ruled on that one.
    expect(unkeptForcesReturn([{ decision: 'undecided' }, { decision: 'park' }])).toBe(true);
  });

  it("names the idea and what the company decided about it, in the board's own findings", () => {
    const f = unkeptIdeaFindings([{ id: 'crypto-loyalty', decision: 'scrap' }, { id: 'b2b-api', decision: 'undecided' }]);
    expect(f[0]).toContain('[[Ideas/crypto-loyalty]]');
    expect(f[0]).toContain('scrapped');
    expect(f[1]).toContain('has not ruled on yet');
    expect(unkeptIdeaFindings([{ id: 'nursery-pilot', decision: 'park' }])[0]).toContain('parked');
  });

  it('tells the CEO what it may plan against, and what to do on day one when nothing is kept', () => {
    expect(keptIdeasGoalBlock(['[[Ideas/meal-kits]] — Meal kits (score 46/60)'])).toContain('only ideas this plan may draw on');
    expect(keptIdeasGoalBlock(['[[Ideas/meal-kits]] — Meal kits (score 46/60)'])).toContain('- [[Ideas/meal-kits]] — Meal kits (score 46/60)');
    expect(keptIdeasGoalBlock([])).toContain('Memory/founder-brief.md');
  });
});
