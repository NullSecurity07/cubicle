import { describe, expect, it } from 'vitest';
import type { Slide } from '../../shared/deck.ts';
import { applyEdits, readNotes, splitNotes } from './notes.ts';

const deck: Slide[] = [
  { id: 's1', shape: 'title', headline: 'Relay', lines: ['Calmer agencies'] },
  { id: 's2', shape: 'problem', headline: 'Agencies drown', lines: ['Too many tools'] },
  { id: 's3', shape: 'solution', headline: 'One stage', lines: ['Everything wired', 'Too many tools'] },
  { id: 's4', shape: 'market', headline: 'A big market', lines: [] },
  { id: 's5', shape: 'ask', headline: 'Join us', lines: [] },
];

describe('notes on a deck', () => {
  it('splits a line of notes into the things it asks for', () => {
    expect(splitNotes('merge 4 and 5, the market slide needs a source. drop 2')).toEqual(['merge 4 and 5', 'the market slide needs a source', 'drop 2']);
    expect(splitNotes('merge slides 2 and 3')).toEqual(['merge slides 2 and 3']);
  });

  it('reads plain edits against the numbers the founder was looking at', () => {
    const read = readNotes('merge slides 2 and 3; drop 5; move 4 to 2; slide 1 headline: "Relay, for agencies"; the market slide needs a source; make it pop', deck);
    expect(read.edits).toEqual([
      { kind: 'merge', into: 's2', from: 's3' },
      { kind: 'drop', id: 's5' },
      { kind: 'move', id: 's4', to: 2 },
      { kind: 'headline', id: 's1', text: 'Relay, for agencies' },
      { kind: 'rewrite', id: 's4', ask: 'the market slide needs a source' },
    ]);
    expect(read.unread).toEqual(['make it pop']);
  });

  it('never guesses at a slide that is not there', () => {
    expect(readNotes('merge 4 and 9', deck)).toEqual({ edits: [], unread: ['merge 4 and 9 (there is no slide by that number)'] });
    expect(readNotes('drop the team slide', deck).unread[0]).toContain('there is no team slide');
  });

  it('merges two slides into one, the lines of both without repeats, and leaves the rest alone', () => {
    const { slides, touched, said } = applyEdits(deck, readNotes('merge slides 2 and 3', deck).edits);
    expect(slides.map((one) => one.id)).toEqual(['s1', 's2', 's4', 's5']);
    expect(slides[1].lines).toEqual(['Too many tools', 'One stage', 'Everything wired']);
    expect([...touched]).toEqual(['s2']);
    expect(said).toEqual(['merged slides 2 and 3']);
    expect(slides[0]).toEqual(deck[0]);
  });

  it('moves, swaps and drops by id, so earlier edits do not shift later numbers', () => {
    const { slides } = applyEdits(deck, readNotes('drop 1, swap 4 and 5', deck).edits);
    expect(slides.map((one) => one.id)).toEqual(['s2', 's3', 's5', 's4']);
    expect(applyEdits(deck, readNotes('move 5 before 1', deck).edits).slides[0].id).toBe('s5');
  });
});
