import { describe, expect, it } from 'vitest';
import { insightsAsk, insightsTitle, interviewName, isAudioName, length, stamp, whereIs } from './interviews.ts';

describe('an interview in words', () => {
  it('names it by who, company and day, leaving out what is not known', () => {
    expect(interviewName({ who: 'Ana', company: 'Acme', on: '2026-09-25' })).toBe('Ana, Acme, 2026-09-25');
    expect(interviewName({ who: ' Ana ' })).toBe('Ana');
    expect(interviewName({})).toBe('Someone');
    expect(insightsTitle({ who: 'Ana', company: 'Acme', on: '2026-09-25' })).toBe('Insights: Ana, Acme');
  });

  it('says a time in the call and a length the way a person would', () => {
    expect(stamp(7.9)).toBe('0:07');
    expect(stamp(760)).toBe('12:40');
    expect(stamp(3723)).toBe('1:02:03');
    expect(stamp(-3)).toBe('0:00');
    expect(length(40.4)).toBe('40 s');
    expect(length(0.2)).toBe('1 s');
    expect(length(24 * 60 + 10)).toBe('24 min');
    expect(length(65 * 60)).toBe('1 h 5 min');
    expect(length(120 * 60)).toBe('2 h');
  });

  it('finds which recording a moment falls in, the last one taking anything past the end', () => {
    const recordings = [{ path: 'a', seconds: 60, at: 0 }, { path: 'b', seconds: 30, at: 0 }];
    expect(whereIs(recordings, 10)).toEqual({ index: 0, offset: 10 });
    expect(whereIs(recordings, 75)).toEqual({ index: 1, offset: 15 });
    expect(whereIs(recordings, 95)).toEqual({ index: 1, offset: 35 });
    expect(whereIs([], 3)).toBeNull();
  });

  it('knows a recording by its name', () => {
    expect(isAudioName('call.M4A')).toBe(true);
    expect(isAudioName('zoom.mp4')).toBe(true);
    expect(isAudioName('notes.txt')).toBe(false);
  });

  it('asks for insights into a new doc, or adds to one already there', () => {
    const card = { who: 'Ana', company: 'Acme', on: '2026-09-25' };
    const fresh = insightsAsk(card, { title: 'Insights: Ana, Acme', fresh: true });
    expect(fresh).toContain('Read the interview with Ana at Acme with read_interview');
    expect(fresh).toContain('story-interview skill');
    expect(fresh).toContain('into the doc "Insights: Ana, Acme":');
    for (const part of ['pains', 'what they do today instead', 'quotes', 'would pay']) expect(fresh).toContain(part);
    const adding = insightsAsk(card, { title: 'Interviews', fresh: false });
    expect(adding).toContain('adding a section headed "Ana, Acme, 2026-09-25" with append_doc');
  });
});
