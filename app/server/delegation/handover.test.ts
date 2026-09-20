import { describe, expect, it } from 'vitest';
import { readHandover, spoken, told } from './handover.ts';

const whole = { done: true, summary: 'Wrote the FAQ.', changed: ['Brand doc'] };

describe('the shape work comes back in', () => {
  it('reads the four fields and drops whatever else came along', () => {
    expect(readHandover(JSON.stringify({ ...whole, blocked: '  ', mood: 'pleased' }))).toEqual(whole);
  });

  it('finds it inside a fence, after their own words', () => {
    expect(readHandover(`All done.\n\n\`\`\`json\n${JSON.stringify(whole)}\n\`\`\``)).toEqual(whole);
  });

  it('keeps what stopped them when they did not finish', () => {
    expect(readHandover(JSON.stringify({ done: false, summary: 'Got half way.', changed: [], blocked: 'No key for the mailbox.' })))
      .toEqual({ done: false, summary: 'Got half way.', changed: [], blocked: 'No key for the mailbox.' });
  });

  it('says what is wrong with it, in the words the correction goes back with', () => {
    expect(() => readHandover('I finished it!')).toThrow(/no json/);
    expect(() => readHandover('[1, 2]')).toThrow(/not an object/);
    expect(() => readHandover(JSON.stringify({ summary: 'x', changed: [] }))).toThrow(/"done"/);
    expect(() => readHandover(JSON.stringify({ done: true, changed: [] }))).toThrow(/"summary"/);
    expect(readHandover(JSON.stringify({ done: true, summary: 'x', changed: 'the doc' })).changed).toEqual([]);
  });

  it('leaves the colleague their own words in their own room, without the shape at the end of them', () => {
    expect(spoken(`Rewrote the brand doc.\n\n\`\`\`json\n${JSON.stringify(whole)}\n\`\`\``, whole)).toBe('Rewrote the brand doc.');
    expect(spoken(`Rewrote it.\n${JSON.stringify(whole)}`, whole)).toBe('Rewrote it.');
    expect(spoken(JSON.stringify(whole), whole)).toBe('Wrote the FAQ.');
    expect(spoken('Just words.', null)).toBe('Just words.');
  });

  it('reads back to the asker as lines, not as json', () => {
    expect(told('Dev', whole)).toBe('Dev finished.\nWrote the FAQ.\nChanged: Brand doc');
    expect(told('Dev', { done: false, summary: 'Stuck.', changed: [], blocked: 'No mailbox.' })).toBe('Dev did not finish.\nStuck.\nWhat stopped them: No mailbox.');
  });
});
