import { describe, expect, it } from 'vitest';
import { COMPANY_SECTIONS, companyTemplate, isCompanyTitle, morningText, parsePlan, planTaskTitle, readMorning } from './partner.ts';

// The shape the journey's 2-week plan came back in (Sam, 2026-09-26): a heading per week, a heading per day with
// bullets under it, then KPIs and kill criteria that are not steps at all.
const TWO_WEEKS = `# Flipside: 2-week validation plan

Goal: find out if founders pay for a weekly list.

## Week 1: build the list

### Mon 28 Sep (Day 1)
- Draft the landing page copy
- Set up a Tally pre-order form at $9
  - nested detail that is not a step of its own

### Tue 29 Sep (Day 2)
1. List 30 abandoned projects from Microns and SideProjectors
2. **Write** valuation notes for the first 10

### Day 3 – Wed 30 Sep
- [ ] Post in r/SaaS and Indie Hackers

## KPIs
- Revenue >= $150 from paid pre-orders
- NPS >= 7

## Kill criteria
- Fewer than 17 paying users by day 14
`;

describe('the Company document', () => {
  it('starts with the six sections in order, under the exact title', () => {
    const text = companyTemplate();
    expect(text.startsWith('# Company\n')).toBe(true);
    const found = [...text.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
    expect(found).toEqual([...COMPANY_SECTIONS]);
    expect(found).toEqual(['Idea', 'Customer', 'Numbers', 'Decisions', 'Bets', 'Open questions']);
  });

  it('is known by its title and nothing looser', () => {
    expect(isCompanyTitle('Company')).toBe(true);
    expect(isCompanyTitle(' company ')).toBe(true);
    expect(isCompanyTitle('Company brief')).toBe(false);
  });
});

describe('a plan read as steps', () => {
  it('takes the bullets under each day heading, labelled by the day, and leaves KPIs and kill criteria out', () => {
    const steps = parsePlan(TWO_WEEKS);
    expect(steps).toEqual([
      { day: 'Mon 28 Sep (Day 1)', text: 'Draft the landing page copy' },
      { day: 'Mon 28 Sep (Day 1)', text: 'Set up a Tally pre-order form at $9' },
      { day: 'Tue 29 Sep (Day 2)', text: 'List 30 abandoned projects from Microns and SideProjectors' },
      { day: 'Tue 29 Sep (Day 2)', text: 'Write valuation notes for the first 10' },
      { day: 'Day 3 – Wed 30 Sep', text: 'Post in r/SaaS and Indie Hackers' },
    ]);
    expect(planTaskTitle(steps[0])).toBe('Mon 28 Sep (Day 1): Draft the landing page copy');
  });

  it('reads a day written at the front of a bullet or a bold line, and a table with a day column', () => {
    expect(parsePlan('- Day 1: call five founders\n- Day 2 – write the list\n**Day 3:** send it')).toEqual([
      { day: 'Day 1', text: 'call five founders' }, { day: 'Day 2', text: 'write the list' }, { day: 'Day 3', text: 'send it' },
    ]);
    expect(parsePlan('| Day | Task |\n|---|---|\n| Mon 5 Oct | Ship the page |\n| Tue 6 Oct | Email 20 leads |')).toEqual([
      { day: 'Mon 5 Oct', text: 'Ship the page' }, { day: 'Tue 6 Oct', text: 'Email 20 leads' },
    ]);
  });

  it('finds nothing in a document that has no days in it', () => {
    expect(parsePlan('# Notes\n\n- one idea\n- another idea')).toEqual([]);
  });
});

describe('the morning note', () => {
  it('reads three things, one risk and one question out of the reply', () => {
    const reply = 'Three things that matter today:\n1. Ship the landing page.\n2. **Email** the five replied leads.\n3. Log last week\'s signups.\n\nRisk: pre-orders are at 3 of 17.\nQuestion: Do you keep the $9 price?';
    const read = readMorning(reply);
    expect(read).toEqual({ things: ['Ship the landing page.', 'Email the five replied leads.', 'Log last week\'s signups.'], risk: 'pre-orders are at 3 of 17.', question: 'Do you keep the $9 price?' });
    expect(morningText(read!)).toBe('Three things that matter today:\n1. Ship the landing page.\n2. Email the five replied leads.\n3. Log last week\'s signups.\n\nRisk: pre-orders are at 3 of 17.\n\nQuestion: Do you keep the $9 price?');
  });

  it('takes headings in place of labels, and the risk on the line after its heading', () => {
    const read = readMorning('## Three things\n- a\n- b\n- c\n## One risk\nRunning out of cash in May.\n## One question\nRaise now?');
    expect(read).toEqual({ things: ['a', 'b', 'c'], risk: 'Running out of cash in May.', question: 'Raise now?' });
  });

  it('refuses a reply without the shape', () => {
    expect(readMorning('Good morning! Lots going on today.')).toBeNull();
    expect(readMorning('1. a\n2. b\n3. c\nRisk: x')).toBeNull();
  });
});
