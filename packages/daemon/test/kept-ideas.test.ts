import { describe, it, expect } from 'vitest';
import { FOUNDER_BRIEF } from '@cubicle/core';
import { unkeptIdeaFindings, unkeptForcesReturn, keptIdeasGoalBlock, planReturnFindings, MAX_PLAN_FINDINGS, MAX_GUARD_FINDINGS } from '../src/index.js';

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
    expect(keptIdeasGoalBlock([])).toContain(FOUNDER_BRIEF);
  });

  it("never lets the guard's warnings crowd out the board's own findings (review T10, finding 1)", () => {
    const guard = unkeptIdeaFindings([
      { id: 'a', decision: 'undecided' }, { id: 'b', decision: 'undecided' },
      { id: 'c', decision: 'undecided' }, { id: 'd', decision: 'undecided' },
    ]);
    const session = ['no metric on the growth objective', 'nobody owns the deploy', 'the free tier runs out in week two'];
    const merged = planReturnFindings(guard, session);
    expect(merged).toHaveLength(MAX_PLAN_FINDINGS);
    // Every one of the board's own survives; the fourth guard warning is what gives way.
    for (const f of session) expect(merged).toContain(f);
    expect(merged.filter((f) => guard.includes(f))).toHaveLength(MAX_GUARD_FINDINGS);
    expect(merged).not.toContain(guard[3]);
  });

  it('the board keeps all four findings it is allowed even when the guard has plenty, and the guard has the budget to itself when the board never sat', () => {
    const guard = ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7'];
    const four = ['s1', 's2', 's3', 's4'];   // mergeBoardVerdict's own ceiling
    expect(planReturnFindings(guard, four)).toEqual(['g1', 'g2', 's1', 's2', 's3', 's4']);
    expect(planReturnFindings(guard, ['s1'])).toEqual(['g1', 'g2', 'g3', 's1']);
    // No session at all: the guard returned the plan before the board sat, so nothing is being reserved.
    expect(planReturnFindings(guard)).toEqual(['g1', 'g2', 'g3', 'g4', 'g5', 'g6']);
    expect(planReturnFindings([], four)).toEqual(four);
  });
});
