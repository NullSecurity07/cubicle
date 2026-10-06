import { describe, expect, it } from 'vitest';
import { docTitle } from './doc-title.ts';

describe('a doc title', () => {
  it.each([
    ['Write me a doc about our pricing in 400 words', 'Pricing'],
    ['Customer notes: what we actually know about our beta studios', 'Customer notes'],
    ['Unit economics: runway, break-even users at our price', 'Unit economics'],
    ['Draft a 300-word memo on the launch plan', 'Launch plan'],
    ['Make a short doc about churn risks for the next quarter, 200 words max', 'Churn risks for the next quarter'],
    ['Please create a document called Hiring plan', 'Hiring plan'],
    ['Competitor map', 'Competitor map'],
    ['Go-to-market plan', 'Go-to-market plan'],
    ['"Investor update — October"', 'Investor update'],
    ['A plan for how we find the first ten paying studios and what we say to them', 'Plan for how we find'],
    ['write up the interview findings (500 words)', 'Interview findings'],
  ])('%s', (asked, title) => {
    expect(docTitle(asked)).toBe(title);
  });

  it('is at most six words', () => {
    expect(docTitle('One two three four five six seven eight').split(' ')).toHaveLength(6);
  });
});
