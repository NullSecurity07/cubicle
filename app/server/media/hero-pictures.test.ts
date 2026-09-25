import { describe, expect, it } from 'vitest';
import { aboutTheLine, criticiseVisuals, drawnAs, heldUp, listSubject, nounsOf, photoOfTheLine, repairVisuals, visualFrom, type Visual } from './visuals.ts';

// The hero film's promise, "nothing leaves your computer that you did not wire", sat over a loading dock. The
// director's lock over a data diagram was rightly refused, and what was built in its place was "computer and nothing
// and decide, on a loading bay at dusk", which a picture model reads as a loading bay.
const PROMISE = 'You decide, and nothing leaves your computer that you did not wire.';
const slot = (subject: string, over: Partial<Visual> = {}): Visual => ({
  at: 3, scene: 3, take: 0, line: PROMISE, about: PROMISE, subject, kind: 'object', room: 'top', ...over,
});

describe('a picture of the line it sits under', () => {
  it('knows the line\'s things from its other words', () => {
    expect(nounsOf(PROMISE)).toContain('computer');
    expect(nounsOf(PROMISE)).not.toContain('nothing');
    expect(nounsOf(PROMISE)).not.toContain('decide');
    expect(nounsOf(PROMISE)).not.toContain('leaves');
  });

  it('is not the director\'s lock and diagram, and not a stand-in that names none of the line', () => {
    expect(aboutTheLine(slot('A lock floats over a stylized data flow, symbolizing privacy and control'))).toBe(false);
    expect(aboutTheLine(slot('A heavy iron pocket watch resting inside a velvet-lined wooden case', { metaphor: 'Data secured locally and resting completely still' }))).toBe(false);
    expect(aboutTheLine(slot('A closed computer resting on a bare wooden table'))).toBe(true);
    expect(aboutTheLine(slot('A padlock on a plain wooden box', { metaphor: 'your computer kept shut' }))).toBe(true);
  });

  it('is never a list of the line\'s words in front of a place, remembered or new', () => {
    const salad = slot('computer and nothing and decide, on a loading bay at dusk');
    expect(listSubject(salad.subject)).toBe(true);
    expect(heldUp(salad)).toBe(false);
    expect(criticiseVisuals([salad]).some((one) => one.rule === 'thin')).toBe(true);
  });

  it('is rebuilt from the line\'s own things, with the thing bigger than the place', () => {
    const { visuals } = repairVisuals([slot('A lock icon floats over a stylized data flow diagram on a screen, symbolizing privacy and control')]);
    const subject = visuals[0].subject;
    expect(subject).toMatch(/\ba computer\b/);
    expect(subject).not.toMatch(/loading|bay|corridor|stairwell|rooftop|station/i);
    expect(listSubject(subject)).toBe(false);
    expect(heldUp(visuals[0])).toBe(true);
    expect(drawnAs(visuals[0], 'clean still-life photography')).toMatch(/a computer/);
    expect(visualFrom(PROMISE, 3, new Set())).toMatch(/^a computer beside a wire, /);
  });

  it('takes a found photograph only when its own description has one of the line\'s things in it', () => {
    expect(photoOfTheLine('Loading dock at dusk with trucks', slot(''))).toBe(false);
    expect(photoOfTheLine('Laptop computer closed on a wooden desk', slot(''))).toBe(true);
  });
});
