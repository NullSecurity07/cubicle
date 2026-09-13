import { describe, it, expect } from 'vitest';
import {
  renderInterviewAsked, closeInterview, supersedeInterview, interviewPhase, interviewClosed,
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
    expect(interviewClosed(interviewPhase(closed))).toBe(true);
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

  it('leaves an open interview open, and an unasked one unasked', () => {
    expect(interviewClosed(interviewPhase(ASKED))).toBe(false);
    expect(interviewClosed(interviewPhase(null))).toBe(false);
    // The three endings that already closed it stay closed.
    expect(interviewClosed(interviewPhase(closeInterview(ASKED, 'skip')))).toBe(true);
    expect(interviewClosed(interviewPhase(closeInterview(ASKED, 'go')))).toBe(true);
  });
});
