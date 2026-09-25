import { describe, expect, it } from 'vitest';
import { matchesFramework, MORE, shelfOf, shelve, SHELVES } from './frameworks.ts';

const one = (name: string, stage?: string, intent = '') => ({ name, stage, intent });

describe('the frameworks shelf', () => {
  it('puts a framework on the shelf it names, and anything else under More', () => {
    expect(shelfOf(one('Seed round prep', 'Raise'))).toBe('Raise');
    expect(shelfOf(one('Mine'))).toBe(MORE);
    expect(shelfOf(one('Odd', 'Somewhere else'))).toBe(MORE);
  });

  it('groups in the order a company lives it, by name inside a shelf, More last in the order it came', () => {
    const groups = shelve([one('Zeta', 'Raise'), one('Newest mine'), one('Beta', 'Find out'), one('Alpha', 'Find out'), one('Older mine')]);
    expect(groups.map((group) => group.shelf)).toEqual(['Find out', 'Raise', MORE]);
    expect(groups[0].frameworks.map((framework) => framework.name)).toEqual(['Alpha', 'Beta']);
    expect(groups[2].frameworks.map((framework) => framework.name)).toEqual(['Newest mine', 'Older mine']);
    expect(SHELVES).toHaveLength(4);
  });

  it('finds by any word of the name, what it is for, or its shelf, in any order and any case', () => {
    const seed = one('Seed round prep', 'Raise', 'Get the pitch deck and the data room ready.');
    expect(matchesFramework(seed, '')).toBe(true);
    expect(matchesFramework(seed, 'SEED')).toBe(true);
    expect(matchesFramework(seed, 'deck raise')).toBe(true);
    expect(matchesFramework(seed, 'deck pricing')).toBe(false);
    expect(matchesFramework(one('Café plan', 'Find out'), 'cafe')).toBe(true);
  });
});
