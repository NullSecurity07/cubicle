import { describe, it, expect } from 'vitest';
import { trustVerdictFor } from '../src/trust.js';

const rev = { id: 'job_rev', type: 'office:compliance.review', assigned: 'clo', trust_key: 'job_1:1:3', trust_proposal: 'prop_1' };

describe('a finished review becomes the record (spec §9)', () => {
  it('pass is a pass, and an absent verdict on a done review is a pass', () => {
    expect(trustVerdictFor(rev, { status: 'done', verdict: 'pass', findings: [] })).toMatchObject({ gate: 'office:compliance.review', verdict: 'pass', key: 'job_1:1:3', proposal: 'prop_1', job: 'job_rev', by: 'clo' });
    expect(trustVerdictFor(rev, { status: 'done', findings: [] })!.verdict).toBe('pass');
  });

  it('return carries the findings', () => {
    expect(trustVerdictFor(rev, { status: 'done', verdict: 'return', findings: ['no unsubscribe link'] })).toMatchObject({ verdict: 'return', findings: ['no unsubscribe link'] });
  });

  it('a failed review is a return, because a review that did not happen is not a pass (Decision 14)', () => {
    expect(trustVerdictFor(rev, { status: 'failed', blockers: ['step_limit'], summary: 'ran out' })).toMatchObject({ verdict: 'return', findings: ['step_limit'] });
    expect(trustVerdictFor(rev, { status: 'failed', blockers: [], summary: '' })!.findings).toEqual(['the reviewer could not complete the review']);
  });

  it('a review that finished blocked records nothing and stays pending', () => {
    expect(trustVerdictFor(rev, { status: 'blocked', blockers: ['need a key'] })).toBeNull();
  });

  it('an ordinary job — or an ordinary chain review — records nothing', () => {
    expect(trustVerdictFor({ id: 'job_a', type: 'engineer.ship', assigned: 'backend_engineer' }, { status: 'done' })).toBeNull();
    expect(trustVerdictFor({ id: 'job_g', type: 'office:security.review', assigned: 'ciso' }, { status: 'done', verdict: 'pass' })).toBeNull();
    expect(trustVerdictFor({ ...rev, trust_proposal: undefined }, { status: 'done' })).toBeNull();
  });
});
