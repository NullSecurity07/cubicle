import { describe, expect, it } from 'vitest';
import { bare, COMPANY_SECTIONS, companyTemplate, dueOf, findCompanyDoc, isCompanyTitle, isPlanDoc, morningText, parsePlan, planStepLine, planTaskTitle, readMorning } from './partner.ts';

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

  it('is the recorded one while it is there, else the first pinned one called so', () => {
    const docs = [{ id: 'brand', title: 'Company', pinned: false }, { id: 'company-brief', title: 'Company brief', pinned: true }, { id: 'renamed', title: 'Our startup', pinned: true }];
    expect(findCompanyDoc(docs)?.id).toBe('company-brief');
    expect(findCompanyDoc(docs, 'renamed')?.id).toBe('renamed');
    expect(findCompanyDoc(docs, 'gone')).toBeUndefined();
  });

  it('is known by its title and nothing looser', () => {
    expect(isCompanyTitle('Company')).toBe(true);
    expect(isCompanyTitle(' company ')).toBe(true);
    expect(isCompanyTitle('Company brief')).toBe(true);
    expect(isCompanyTitle('Company notes')).toBe(false);
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
    expect(planTaskTitle(steps[0])).toBe('Draft the landing page copy');
    expect(planStepLine(steps[0])).toBe('Mon 28 Sep (Day 1): Draft the landing page copy');
  });

  it('reads a day written at the front of a bullet or a bold line, and a table with a day column', () => {
    expect(parsePlan('- Day 1: call five founders\n- Day 2 – write the list\n**Day 3:** send it')).toEqual([
      { day: 'Day 1', text: 'call five founders' }, { day: 'Day 2', text: 'write the list' }, { day: 'Day 3', text: 'send it' },
    ]);
    expect(parsePlan('| Day | Task |\n|---|---|\n| Mon 5 Oct | Ship the page |\n| Tue 6 Oct | Email 20 leads |')).toEqual([
      { day: 'Mon 5 Oct', text: 'Ship the page' }, { day: 'Tue 6 Oct', text: 'Email 20 leads' },
    ]);
  });

  it('reads a bold day bullet with its steps nested under it, and phases', () => {
    expect(parsePlan('- **Day 1**\n  - call five founders\n  - write the list\n- **Day 2:**\n  - send it\n- a note, not a day\n  - not a step')).toEqual([
      { day: 'Day 1', text: 'call five founders' }, { day: 'Day 1', text: 'write the list' }, { day: 'Day 2', text: 'send it' },
    ]);
    expect(parsePlan('## Phase 1: validate\n- ten interviews')).toEqual([{ day: 'Phase 1: validate', text: 'ten interviews' }]);
    expect(isPlanDoc('Launch plans', '')).toBe(true);
    expect(isPlanDoc('Notes', '# Planning the launch')).toBe(true);
    expect(isPlanDoc('Planet', '# Notes')).toBe(false);
  });

  // The plan Sam wrote in the second journey (2026-09-26), exactly: a week heading, then bold day ranges with dates.
  const JOURNEY_DOC = '# Two-week validation plan\n\nStarting Monday, 28 September 2026. Goal: Validate whether indie hackers will pay.\n\n## Week 1: Sourcing & Landing Page (28 Sep \u2013 4 Oct)\n- **Mon\u2013Tue (28\u201329 Sep):** Find and vet 5 real abandoned/struggling SaaS side-projects. Write a short valuation note for each.\n- **Wed (30 Sep):** Set up a simple landing page (e.g., Carrd or Substack).\n\n## Week 2: Outreach & Go/No-Go Decision (5 Oct \u2013 11 Oct)\n- **Sat\u2013Sun (10\u201311 Oct):** Make the go/no-go call.\n';
  // And the steps Sam handed to propose_tasks, with the narrow no-break spaces the model wrote.
  const JOURNEY_STEPS = ['Mon\u202f28\u202fSep \u2013 Tue\u202f29\u202fSep: Find & vet 5 abandoned SaaS side\u2011projects; write valuation notes', 'Wed\u202f30\u202fSep: Build landing page (Carrd/Substack) with pricing or guarantee'];

  it('keeps a day range one label, never glues the week heading on, and dates each step', () => {
    const steps = parsePlan(JOURNEY_DOC);
    expect(steps.map((step) => planTaskTitle(step))).toEqual([
      'Find and vet 5 real abandoned/struggling SaaS side-projects. Write a short\u2026',
      'Set up a simple landing page (e.g., Carrd or Substack)',
      'Make the go/no-go call',
    ]);
    expect(steps.map((step) => dueOf(step.day!, '2026-09-26'))).toEqual(['2026-09-28', '2026-09-30', '2026-10-10']);
    const handed = JOURNEY_STEPS.flatMap((line) => parsePlan(line));
    expect(handed.map((step) => planTaskTitle(step))).toEqual(['Find & vet 5 abandoned SaaS side\u2011projects; write valuation notes', 'Build landing page (Carrd/Substack) with pricing or guarantee']);
    expect(handed.map((step) => dueOf(step.day!, '2026-09-26'))).toEqual(['2026-09-28', '2026-09-30']);
  });

  // Journey 5: the steps the partner handed to propose_tasks, with "Day 1–2:" ranges. Titles kept the label and no
  // task had a due date, so the dashboard's "Due today" stayed 0.
  const J5_STEPS = ['Day 1–2: Build a minimal form to create client profiles (Name, EU VAT number, address)', 'Day 3: Generate a PDF invoice from a client profile',
    'Days 4-5: Add invoice numbering and VAT reverse-charge wording', 'Day 6 – Send the invoice feature to the 3 beta users', 'Day 7: Collect feedback and decide what is next'];

  it('reads "Day N–M:" as one label, and dates it from the day the plan starts', () => {
    const steps = J5_STEPS.flatMap((line) => parsePlan(line));
    expect(steps.map((step) => step.day)).toEqual(['Day 1–2', 'Day 3', 'Days 4-5', 'Day 6', 'Day 7']);
    expect(steps.map((step) => planTaskTitle(step, '2026-09-27'))).toEqual([
      'Build a minimal form to create client profiles (Name, EU VAT number, address)', 'Generate a PDF invoice from a client profile',
      'Add invoice numbering and VAT reverse-charge wording', 'Send the invoice feature to the 3 beta users', 'Collect feedback and decide what is next',
    ]);
    expect(steps.map((step) => dueOf(step.day!, '2026-09-27', '2026-09-27'))).toEqual(['2026-09-27', '2026-09-29', '2026-09-30', '2026-10-02', '2026-10-03']);
    expect(dueOf('Week 2', '2026-09-27', '2026-09-27')).toBe('2026-10-04');
    // A calendar day in the label still wins, and with no start a "Day 3" names no day and keeps its label.
    expect(dueOf('Mon 28 Sep (Day 1)', '2026-09-26', '2026-09-20')).toBe('2026-09-28');
    expect(planTaskTitle(steps[1])).toBe('Day 3: Generate a PDF invoice from a client profile');
  });

  it('dates a label only when it names a calendar day, in the year nearest today', () => {
    expect(dueOf('Day 3', '2026-09-26')).toBeUndefined();
    expect(dueOf('Mon', '2026-09-26')).toBeUndefined();
    expect(dueOf('Sep 28', '2026-09-26')).toBe('2026-09-28');
    expect(dueOf('Sep 28 – 2 Oct', '2026-09-26')).toBe('2026-09-28');
    expect(dueOf('Mon 4 Jan', '2026-12-28')).toBe('2027-01-04');
    expect(dueOf('2026-10-02', '2026-09-26')).toBe('2026-10-02');
    expect(planTaskTitle({ day: 'Mon 28 Sep', text: 'Mon 28 Sep: call Ana' })).toBe('call Ana');
    expect(planStepLine({ day: 'Mon 28 Sep', text: 'Mon 28 Sep: call Ana' })).toBe('Mon 28 Sep: call Ana');
  });

  // Journey 3's board: "Sep 26: Set up ... under $5k for indie hacke". The due date is on the card, so the label
  // goes; a label that names no calendar day ("Day 3", "Mon") stays, since nothing else on the card says it.
  it('titles a task without a dated label and cuts a long one at a word, within eighty characters', () => {
    const journey = { day: 'Sep 26', text: 'Set up a dead-simple, free static landing page listing 10 hand-picked abandoned SaaS projects under $5k for indie hackers' };
    const title = planTaskTitle(journey);
    expect(title.length).toBeLessThanOrEqual(80);
    expect(title).toBe('Set up a dead-simple, free static landing page listing 10 hand-picked abandoned\u2026');
    expect(title).not.toMatch(/Sep 26/);
    expect(planTaskTitle({ day: 'Day 3', text: 'send it' })).toBe('Day 3: send it');
    expect(planTaskTitle({ day: 'Mon', text: 'call Ana' })).toBe('Mon: call Ana');
    expect(planTaskTitle({ text: 'x'.repeat(100) })).toHaveLength(80);
    expect(planTaskTitle({ day: '2026-10-02', text: 'Ship it.' })).toBe('Ship it.');
  });

  it('finds nothing in a document that has no days in it', () => {
    expect(parsePlan('# Notes\n\n- one idea\n- another idea')).toEqual([]);
  });
});

describe('a bet\'s words between full stops', () => {
  it('drops whatever stop the writer ended on, an ellipsis too', () => {
    for (const said of ['It gives us a head start.', 'It gives us a head start', 'It gives us a head start...', 'It gives us a head start\u2026', ' It gives us a head start. ']) expect(bare(said), said).toBe('It gives us a head start');
  });
});

describe('the morning note', () => {
  it('reads three things, one risk and one question out of the reply', () => {
    const reply = 'Three things that matter today:\n1. Ship the landing page.\n2. **Email** the five replied leads.\n3. Log last week\'s signups.\n\nRisk: pre-orders are at 3 of 17.\nQuestion: Do you keep the $9 price?';
    const read = readMorning(reply);
    expect(read).toEqual({ things: ['Ship the landing page.', 'Email the five replied leads.', 'Log last week\'s signups.'], risk: 'pre-orders are at 3 of 17.', question: 'Do you keep the $9 price?' });
    expect(morningText(read!)).toBe('Three moves for today:\n1. Ship the landing page.\n2. Email the five replied leads.\n3. Log last week\'s signups.\n\nRisk: pre-orders are at 3 of 17.\n\nQuestion: Do you keep the $9 price?');
  });

  it('takes headings in place of labels, and the risk on the line after its heading', () => {
    const read = readMorning('## Three things\n- a\n- b\n- c\n## One risk\nRunning out of cash in May.\n## One question\nRaise now?');
    expect(read).toEqual({ things: ['a', 'b', 'c'], risk: 'Running out of cash in May.', question: 'Raise now?' });
  });

  it('reads labels however they are dressed, and leaves the My call line out', () => {
    const shapes = [
      '1. a\n2. b\n3. c\n- Risk: r\n- Question: q?',
      '**1.** a\n**2.** b\n**3.** c\n**Risk:** r\n**Question:** q?',
      'Three things:\n1. a\n2. b\n3. c\nBiggest risk: r\nQuestion for you: q?',
      '1. a\n2. b\n3. c\nRisk: r\nQuestion: q?\n\nMy call: ship the page today.',
      '1. a\n2. b\n3. c\nRisk: r\nQuestion: q?\n**My call:** ship it.',
    ];
    for (const reply of shapes) expect(readMorning(reply), reply).toEqual({ things: ['a', 'b', 'c'], risk: 'r', question: 'q?' });
    // A thing that mentions a risk is still a thing.
    expect(readMorning('- Risk of churn rises\n- b\nRisk: r\nQuestion: q?')).toEqual({ things: ['Risk of churn rises', 'b'], risk: 'r', question: 'q?' });
  });

  it('refuses a reply without the shape', () => {
    expect(readMorning('1. only one\nRisk: r\nQuestion: q?')).toBeNull();
    expect(readMorning('Good morning! Lots going on today.')).toBeNull();
    expect(readMorning('1. a\n2. b\n3. c\nRisk: x')).toBeNull();
  });
});
