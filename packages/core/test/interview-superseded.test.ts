import { describe, it, expect } from 'vitest';
import {
  renderInterviewAsked, closeInterview, supersedeInterview, interviewPhase,
  interviewSuperseded, ownerAnsweredInterview, INTERVIEW_SUPERSEDED_HEADING,
} from '../src/discovery.js';

const ASKED = renderInterviewAsked('2026-09-13T17:46:00.000Z');

describe('the interview closes when the brief is adopted (ruling W3-7)', () => {
  it('stamps the transcript with what happened and the date', () => {
    const closed = supersedeInterview(ASKED, '2026-09-13T12:56:26.103Z')!;
    expect(closed).toContain(INTERVIEW_SUPERSEDED_HEADING);
    expect(closed).toContain('The founder brief was adopted on 2026-09-13');
    expect(closed).toContain('this interview is closed');
  });

  it('reads as closed — and never as the owner having spoken', () => {
    const closed = supersedeInterview(ASKED)!;
    expect(interviewSuperseded(closed)).toBe(true);
    expect(interviewPhase(closed)).toBe('superseded');
    // The CEO answered the six itself; a brief may not cite those as the owner's word (ruling P8-13).
    expect(ownerAnsweredInterview(closed)).toBe(false);
  });

  it('keeps the owner\'s own addition when there is one, and still closes', () => {
    const added = closeInterview(ASKED, 'The buyers are nursery chains, not single nurseries.', '2026-09-13T12:00:00.000Z');
    const closed = supersedeInterview(added)!;
    expect(closed).toContain('**You:** The buyers are nursery chains');
    expect(interviewPhase(closed)).toBe('superseded');
    expect(ownerAnsweredInterview(closed)).toBe(true);
  });

  it('does nothing twice, and nothing to a transcript that does not exist', () => {
    const closed = supersedeInterview(ASKED)!;
    expect(supersedeInterview(closed)).toBeNull();
    expect(supersedeInterview(null)).toBeNull();
    expect(supersedeInterview('   ')).toBeNull();
  });

  it('leaves a transcript that already records why it ended exactly as it is', () => {
    // A skip and an endorsement each already say how the interview ended, and `interviewPhase` reads the first
    // heading it finds — a second note under the first would be a line nobody ever reads.
    const skipped = closeInterview(ASKED, 'skip');
    expect(supersedeInterview(skipped)).toBeNull();
    expect(interviewPhase(skipped)).toBe('skipped');
    // An endorsement is the owner having spoken, so the adoption does stamp it: what ended that interview and
    // what the company now plans against are two different facts, and the transcript should carry both.
    const endorsed = closeInterview(ASKED, 'go');
    expect(interviewPhase(endorsed)).toBe('answered');
    expect(supersedeInterview(endorsed)).toContain(INTERVIEW_SUPERSEDED_HEADING);
  });
});
