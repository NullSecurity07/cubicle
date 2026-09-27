import { describe, expect, it } from 'vitest';
import { suggest, type Known } from '../../overlay/commands';
import { partnerCommands, takeBetLabel } from './words';

const known: Known = { cards: [{ id: 'marketing', type: 'room', label: 'Maya', role: 'Marketing' }] };

describe('the partner\'s words in the command bar', () => {
  it('adds the partner by name, default Partner, and never hires a person called "Partner"', () => {
    const added: string[] = [];
    const extra = partnerCommands({ add: (name) => added.push(name), morning: () => {} });
    const found = suggest('add partner', known, extra);
    expect(found[0].label).toBe('Add your partner');
    expect(found.some((one) => one.label.startsWith('Add a person'))).toBe(false);
    (found[0].action as { run(): void }).run();
    const named = suggest('Add a partner called sam lee', known, extra);
    expect(named[0].label).toBe('Add Sam Lee, your partner');
    (named[0].action as { run(): void }).run();
    expect(suggest('hire a cofounder', known, extra)[0].label).toBe('Add your partner');
    expect(added).toEqual(['Partner', 'Sam Lee']);
  });

  it('asks for the morning note and opens the bets by the words a founder reaches for', () => {
    let asked = 0;
    const extra = partnerCommands({ add: () => {}, morning: () => { asked += 1; } });
    for (const typed of ['morning note', 'morning', "today's morning note", 'note from my partner']) expect(suggest(typed, known, extra).map((one) => one.label), typed).toContain('Morning note');
    for (const typed of ['bets', 'my bets', 'open bets', 'ledger']) expect(suggest(typed, known, extra).map((one) => one.label), typed).toContain('Bets');
    (suggest('morning note', known, extra).find((one) => one.label === 'Morning note')!.action as { run(): void }).run();
    expect(asked).toBe(1);
  });
});

describe('the button that takes a suggested bet', () => {
  it('says it adds a Metrics card when the bet\'s number is only in the Company brief', () => {
    expect(takeBetLabel('Measured by "paying users" on the Company brief: 5 by 2026-10-15. Add a Metrics card from the brief and take the bet: taking it adds a Metrics card with Paying users at 2, wired to Sam.')).toBe('Add a Metrics card and take the bet');
  });

  it('says only take the bet when a card already holds the number, or nothing is said', () => {
    expect(takeBetLabel('Measured by "mrr" on the Metrics card: 900 by 2026-10-15.')).toBe('Take the bet');
    expect(takeBetLabel(undefined)).toBe('Take the bet');
  });
});
