import { describe, expect, it } from 'vitest';
import { askLine } from './askLine';

describe('the line an empty chat opens with', () => {
  it('asks the partner about the company, by the partner\'s name', () => {
    expect(askLine({ name: 'Sam', role: 'Partner', partner: true })).toBe('Ask Sam anything about the company.');
    // The journey's card: named and titled "Partner" both, it no longer reads "anything about partner".
    expect(askLine({ name: 'Partner', role: 'Partner', partner: true })).toBe('Ask Partner anything about the company.');
  });

  it('asks anyone else about their work, and never about their own name', () => {
    expect(askLine({ name: 'Maya', role: 'Marketing' })).toBe('Ask Maya anything about marketing.');
    expect(askLine({ name: 'Dev', role: 'dev' })).toBe('Ask Dev anything.');
    expect(askLine({ name: 'Ana', role: '' })).toBe('Ask Ana anything.');
  });
});
