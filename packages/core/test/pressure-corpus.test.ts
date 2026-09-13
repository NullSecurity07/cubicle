import { describe, it, expect } from 'vitest';
import {
  readPressureVerdict, parseRubric, pressureFindings,
  PRESSURE_REFUSAL_MISSING, type BoardRubric, type PressureVerdict,
} from '../src/pressure.js';

/**
 * The corpus: realistic chair answers, written before the parser was changed, each with the verdict, rubric and
 * flaws a person reading it would take from it. Three reviews in a row found the parse clever and wrong on a
 * shape nobody had written down, so the shapes are written down here first and the parser is whatever passes
 * them. Every entry is something a model actually does with the prompt in `chairFormat()`: it bolds what it was
 * shown in bold, numbers what it was shown numbered, fences the block, lower-cases, states the total it was
 * told the rubric is out of, or reprints the template instead of deciding.
 *
 * `verdict: null` means the answer is refused — the chair gets its one re-ask — and `reason` says which refusal.
 */
interface Case {
  name: string;
  text: string;
  verdict: PressureVerdict | null;
  reason?: string;
  rubric?: BoardRubric | null;
  flaws?: string[];
  wedge?: string;
}

const R = (core_assumption: number, fatal_flaws: number, pain: number, founder_fit: number, why_now: number): BoardRubric =>
  ({ core_assumption, fatal_flaws, pain, founder_fit, why_now });

const CORPUS: Case[] = [
  {
    name: '1. the shape the prompt asks for, written exactly',
    text: [
      'VERDICT: STRONG',
      'RUBRIC: core assumption 2, fatal flaws 1, pain 2, founder fit 1, why now 1',
      '',
      '## Core Assumption',
      'Nurseries will pay 40 a week to stop planning meals.',
      '',
      '## Three Fatal Flaws',
      '- The county caterer already holds the contract and renews every August',
      '- Allergen liability sits with the nursery manager',
      '- Delivery before 7am needs a van you do not have',
      '',
      '## Problem Validation',
      '- They run the menu off a shared spreadsheet today',
      '',
      '## Founder-Market Fit',
      'The owner ran a nursery kitchen for six years.',
      '',
      '## Brutal Verdict',
      'Build the cheap test this week.',
    ].join('\n'),
    verdict: 'STRONG',
    rubric: R(2, 1, 2, 1, 1),
    flaws: [
      'The county caterer already holds the contract and renews every August',
      'Allergen liability sits with the nursery manager',
      'Delivery before 7am needs a van you do not have',
    ],
  },
  {
    name: '2. bolded rather than hashed, all the way down (I2)',
    text: [
      '**VERDICT: WEAK**',
      '**RUBRIC: core assumption 1, fatal flaws 0, pain 1, founder fit 1, why now 0**',
      '',
      '**Core Assumption**',
      'Nurseries have a budget line for food they control.',
      '',
      '**Three Fatal Flaws**',
      '- the caterer will not release the contract mid-year',
      '- liability is unpriced and the manager will not sign for it',
      '- nobody here can drive a refrigerated van at 6am',
      '',
      '**Problem Validation**',
      'A vitamin: the spreadsheet works and nobody is hacking around it.',
    ].join('\n'),
    verdict: 'WEAK',
    rubric: R(1, 0, 1, 1, 0),
    flaws: [
      'the caterer will not release the contract mid-year',
      'liability is unpriced and the manager will not sign for it',
      'nobody here can drive a refrigerated van at 6am',
    ],
  },
  {
    name: '3. the handbook\'s own rubric example, total first (C1)',
    text: [
      'VERDICT: STRONG',
      'RUBRIC: 7/10 — core assumption 2, fatal flaws 1, pain 2, founder fit 1, why now 1',
      '',
      '## Three Fatal Flaws',
      '- the caterer holds the contract',
    ].join('\n'),
    verdict: 'STRONG',
    rubric: R(2, 1, 2, 1, 1),
    flaws: ['the caterer holds the contract'],
  },
  {
    name: '4. the chair states the total the prompt told it the rubric is out of (C1)',
    text: [
      'VERDICT: WEAK',
      'RUBRIC: core assumption 2, fatal flaws 1, pain 2, founder fit 1, why now 1 — total 7/10',
      '',
      '## Three Fatal Flaws',
      '- the payer is not the user',
    ].join('\n'),
    verdict: 'WEAK',
    rubric: R(2, 1, 2, 1, 1),
    flaws: ['the payer is not the user'],
  },
  {
    name: '5. each dimension scored out of two (C1)',
    text: [
      'VERDICT: STRONG',
      'RUBRIC: core assumption 2/2, fatal flaws 1/2, pain 2/2, founder fit 1/2, why now 1/2',
      '',
      '## Three Fatal Flaws',
      '- delivery is unpriced',
    ].join('\n'),
    verdict: 'STRONG',
    rubric: R(2, 1, 2, 1, 1),
    flaws: ['delivery is unpriced'],
  },
  {
    name: '6. the rubric labels on their own lines',
    text: [
      'VERDICT: PIVOT REQUIRED',
      'RUBRIC:',
      '- core assumption: 1',
      '- fatal flaws: 1',
      '- pain: 2',
      '- founder fit: 1',
      '- why now: 0',
      '',
      '## Three Fatal Flaws',
      '- the buyer is the county, not the nursery',
      '',
      'WEDGE: the one chain of 40 sites that already orders together',
    ].join('\n'),
    verdict: 'PIVOT REQUIRED',
    rubric: R(1, 1, 2, 1, 0),
    flaws: ['the buyer is the county, not the nursery'],
    wedge: 'the one chain of 40 sites that already orders together',
  },
  {
    name: '7. lower case throughout',
    text: [
      'verdict: weak',
      'rubric: core assumption 1, fatal flaws 1, pain 1, founder fit 2, why now 1',
      '',
      '## three fatal flaws',
      '- nobody is hacking a solution today',
      '- the workaround is free',
    ].join('\n'),
    verdict: 'WEAK',
    rubric: R(1, 1, 1, 2, 1),
    flaws: ['nobody is hacking a solution today', 'the workaround is free'],
  },
  {
    name: '8. the whole answer inside a fenced block',
    text: [
      'Here is the merged verdict:',
      '',
      '```',
      'VERDICT: STRONG',
      'RUBRIC: core assumption 2, fatal flaws 2, pain 2, founder fit 2, why now 1',
      '',
      '## Three Fatal Flaws',
      '- the van is not booked',
      '```',
    ].join('\n'),
    verdict: 'STRONG',
    rubric: R(2, 2, 2, 2, 1),
    flaws: ['the van is not booked'],
  },
  {
    name: '9. the five parts numbered, the way the advisors were asked for them',
    text: [
      '1. Core Assumption — nurseries will pay weekly.',
      '2. Three Fatal Flaws',
      '   - nobody has priced delivery',
      '   - the payer is not the user',
      '   - no van before 7am',
      '3. Problem Validation — painkiller, they already pay a caterer.',
      '4. Founder-Market Fit — the owner ran a kitchen.',
      '5. Brutal Verdict — WEAK.',
      '',
      'RUBRIC: core assumption 1, fatal flaws 1, pain 2, founder fit 2, why now 1',
    ].join('\n'),
    verdict: 'WEAK',
    rubric: R(1, 1, 2, 2, 1),
    flaws: ['nobody has priced delivery', 'the payer is not the user', 'no van before 7am'],
  },
  {
    name: '10. no VERDICT line at all — the owner\'s own heading, with a full stop',
    text: [
      'Brutal Verdict: STRONG.',
      'RUBRIC: core assumption 2, fatal flaws 2, pain 2, founder fit 1, why now 2',
      '',
      '## Three Fatal Flaws',
      '- the contract renews in August',
    ].join('\n'),
    verdict: 'STRONG',
    rubric: R(2, 2, 2, 1, 2),
    flaws: ['the contract renews in August'],
  },
  {
    name: '11. a bullet that says "Verdict: strong disagreement" is not a vote (I4)',
    text: [
      'VERDICT: WEAK',
      'RUBRIC: core assumption 1, fatal flaws 1, pain 1, founder fit 1, why now 1',
      '',
      '## Three Fatal Flaws',
      '- the caterer holds the contract',
      '',
      '## Brutal Verdict',
      '- Verdict: strong disagreement among the advisors on pain, and the skeptic wins it',
    ].join('\n'),
    verdict: 'WEAK',
    rubric: R(1, 1, 1, 1, 1),
    flaws: ['the caterer holds the contract'],
  },
  {
    name: '12. the template reprinted with its angle brackets, and nothing decided (C2)',
    text: [
      'VERDICT: <STRONG|WEAK|PIVOT REQUIRED>',
      'RUBRIC: core assumption <0-2>, fatal flaws <0-2>, pain <0-2>, founder fit <0-2>, why now <0-2>',
      '',
      '## Three Fatal Flaws',
      '- the caterer holds the contract',
    ].join('\n'),
    verdict: null,
    reason: PRESSURE_REFUSAL_MISSING,
  },
  {
    name: '13. the template reprinted as an English list (C2)',
    text: 'VERDICT: STRONG, WEAK or PIVOT REQUIRED\n\n## Three Fatal Flaws\n- the caterer holds the contract',
    verdict: null,
    reason: PRESSURE_REFUSAL_MISSING,
  },
  {
    name: '14. a pivot that names its wedge',
    text: [
      'VERDICT: PIVOT REQUIRED',
      'RUBRIC: core assumption 1, fatal flaws 1, pain 2, founder fit 1, why now 1',
      'WEDGE: the 40-site chain that already orders together, whose manager is the buyer',
      '',
      '## Three Fatal Flaws',
      '- the buyer is not the user',
      '- the county renews in August',
    ].join('\n'),
    verdict: 'PIVOT REQUIRED',
    rubric: R(1, 1, 2, 1, 1),
    flaws: ['the buyer is not the user', 'the county renews in August'],
    wedge: 'the 40-site chain that already orders together, whose manager is the buyer',
  },
  {
    name: '15. quoted back to the owner as a blockquote',
    text: [
      '> VERDICT: WEAK',
      '> RUBRIC: core assumption 1, fatal flaws 0, pain 1, founder fit 1, why now 1',
      '',
      '> ## Three Fatal Flaws',
      '> - nobody has tried to buy it',
    ].join('\n'),
    verdict: 'WEAK',
    rubric: R(1, 0, 1, 1, 1),
    flaws: ['nobody has tried to buy it'],
  },
  {
    name: '16. a chair that thinks again is taken at its last word',
    text: [
      'VERDICT: STRONG',
      '',
      'On reflection, the caterer contract is fatal this year.',
      '',
      'VERDICT: PIVOT REQUIRED',
      'RUBRIC: core assumption 2, fatal flaws 1, pain 2, founder fit 1, why now 0',
      'WEDGE: the nurseries with no caterer contract at all',
      '',
      '## Three Fatal Flaws',
      '- the county contract renews in August',
    ].join('\n'),
    verdict: 'PIVOT REQUIRED',
    rubric: R(2, 1, 2, 1, 0),
    flaws: ['the county contract renews in August'],
    wedge: 'the nurseries with no caterer contract at all',
  },
  {
    name: '17. a chair that dismisses the other two outcomes has still decided',
    text: 'VERDICT: PIVOT REQUIRED (not STRONG or WEAK)\n\n## Three Fatal Flaws\n- the payer is not the user',
    verdict: 'PIVOT REQUIRED',
    rubric: null,
    flaws: ['the payer is not the user'],
  },
  {
    name: '18. em dashes where the prompt showed colons',
    text: [
      '**VERDICT** — STRONG',
      '**RUBRIC** — core assumption 2, fatal flaws 2, pain 2, founder fit 2, why now 2',
      '',
      '#### Three Fatal Flaws',
      '- the margin is thin until 40 boxes a week',
    ].join('\n'),
    verdict: 'STRONG',
    rubric: R(2, 2, 2, 2, 2),
    flaws: ['the margin is thin until 40 boxes a week'],
  },
  {
    name: '19. the five parts and nothing else: the verdict sits under the heading it was shown',
    text: [
      'RUBRIC: core assumption 1, fatal flaws 1, pain 1, founder fit 2, why now 1',
      '',
      '## Core Assumption',
      'That the nursery manager, not the county, chooses the food.',
      '',
      '## Three Fatal Flaws',
      '- the county holds the contract and renews in August',
      '- allergen liability is unpriced',
      '',
      '## Problem Validation',
      'A vitamin: the spreadsheet works and nobody is hacking around it.',
      '',
      '## Founder-Market Fit',
      'The owner ran a nursery kitchen for six years.',
      '',
      '## Brutal Verdict',
      'WEAK. The payer is not the user and the contract is annual.',
    ].join('\n'),
    verdict: 'WEAK',
    rubric: R(1, 1, 1, 2, 1),
    flaws: ['the county holds the contract and renews in August', 'allergen liability is unpriced'],
  },
  {
    name: '20. the same, with the heading bolded and the verdict alone under it',
    text: [
      '**Brutal Verdict**',
      '',
      'PIVOT REQUIRED',
      '',
      'WEDGE: the 40-site chain whose manager is the buyer',
    ].join('\n'),
    verdict: 'PIVOT REQUIRED',
    rubric: null,
    flaws: [],
    wedge: 'the 40-site chain whose manager is the buyer',
  },
  {
    name: '21. a chair that reconsiders under the heading is taken at its last word, not its first',
    text: [
      'VERDICT: STRONG',
      '',
      '## Brutal Verdict',
      'WEAK, on the contract alone.',
    ].join('\n'),
    verdict: 'WEAK',
  },
  {
    name: '22. prose under the heading is reasoning, not a vote, and the re-ask says the line is missing',
    text: [
      'RUBRIC: core assumption 1, fatal flaws 1, pain 1, founder fit 1, why now 1',
      '',
      '## Brutal Verdict',
      'The idea does not survive its first flaw.',
    ].join('\n'),
    verdict: null,
    reason: PRESSURE_REFUSAL_MISSING,
  },
  {
    name: '23. and the template enumerated under the heading is still not a vote',
    text: '## Brutal Verdict\n\nSTRONG, WEAK or PIVOT REQUIRED',
    verdict: null,
    reason: PRESSURE_REFUSAL_MISSING,
  },
  {
    name: '24. the chair lists what its three advisors voted and then says which it agrees with (Critical 1)',
    text: [
      'VERDICT: WEAK',
      'RUBRIC: core assumption 1, fatal flaws 1, pain 1, founder fit 1, why now 1',
      '',
      '## Three Fatal Flaws',
      '- the county holds the contract',
      '',
      '## Brutal Verdict',
      'The three advisors split:',
      '- Brutal Verdict — WEAK (growth)',
      '- Brutal Verdict — WEAK (research)',
      '- Brutal Verdict — STRONG (engineering)',
      'Two of three say weak and I agree with them.',
    ].join('\n'),
    verdict: 'WEAK',
    rubric: R(1, 1, 1, 1, 1),
    flaws: ['the county holds the contract'],
  },
  {
    name: '25. the chair quotes an advisor\'s verdict in order to disagree with it (Critical 1)',
    text: [
      'VERDICT: PIVOT REQUIRED',
      'WEDGE: the one nursery chain that already buys your fruit',
      '',
      '## Brutal Verdict',
      'The engineering advisor wrote:',
      '',
      '> Brutal Verdict — STRONG',
      '',
      'I do not agree. The buyer is not the user.',
    ].join('\n'),
    verdict: 'PIVOT REQUIRED',
    rubric: null,
    wedge: 'the one nursery chain that already buys your fruit',
  },
  {
    name: '26. the label written, then the line broken, then the answer',
    text: 'VERDICT:\nWEAK\n\n## Three Fatal Flaws\n- the payer is not the user',
    verdict: 'WEAK',
    flaws: ['the payer is not the user'],
  },
  {
    name: '27. the same with the heading, the colon and the emphasis the chair was shown',
    text: '**VERDICT:**\nSTRONG',
    verdict: 'STRONG',
  },
  {
    name: '28. the flaws as a numbered list, under a sentence introducing them',
    text: [
      'VERDICT: WEAK',
      '',
      '## Three Fatal Flaws',
      'Three things could kill this:',
      '1. the agent bundles it into the listing fee',
      '2. it sells once in nine years',
      '3. a phone does it free',
    ].join('\n'),
    verdict: 'WEAK',
    flaws: ['the agent bundles it into the listing fee', 'it sells once in nine years', 'a phone does it free'],
  },
  {
    name: '29. the rubric laid out as a markdown table, header row and all',
    text: [
      'VERDICT: WEAK',
      'RUBRIC:',
      '| dimension | score |',
      '| --- | --- |',
      '| core assumption | 2 |',
      '| fatal flaws | 1 |',
      '| pain | 2 |',
      '| founder fit | 1 |',
      '| why now | 1 |',
      '',
      '## Three Fatal Flaws',
      '- the payer is not the user',
    ].join('\n'),
    verdict: 'WEAK',
    rubric: R(2, 1, 2, 1, 1),
    flaws: ['the payer is not the user'],
  },
  {
    name: '30. the machine lines themselves written as table rows',
    text: [
      '| VERDICT | PIVOT REQUIRED |',
      '| RUBRIC | core assumption 2, fatal flaws 1, pain 2, founder fit 1, why now 1 |',
      '| WEDGE | the 40-site chain whose manager is the buyer |',
    ].join('\n'),
    verdict: 'PIVOT REQUIRED',
    rubric: R(2, 1, 2, 1, 1),
    wedge: 'the 40-site chain whose manager is the buyer',
  },  {
    // SP8 §3. The full board does not hand the parse one merged answer: it hands it the five round findings,
    // rendered as the parts, with the chair's **last turn** under them. So the page the parse reads carries the
    // chair's own words twice over — once as the finding it wrote closing the verdict round, and once as the
    // machine lines it voted with — and it has to take the vote and not the prose above it. The flaws come from
    // round two's finding, which is bullets, and the verdict from the bottom of the page.
    name: '16. a multi-turn dialogue, rendered as the five parts with the chair\'s last turn under them (SP8)',
    text: [
      '## Core Assumption',
      '',
      'Nurseries will pay 40 a week to stop planning meals.',
      '',
      '## Three Fatal Flaws',
      '',
      'three ways this dies',
      '- The county caterer holds the contract and renews every August',
      '- Nobody has quoted the 7am van',
      '',
      '## Problem Validation',
      '',
      'A painkiller: they already pay a caterer every term.',
      '',
      '## Founder-Market Fit',
      '',
      'QUESTION FOR THE OWNER: what have you actually run before?',
      '',
      '## Brutal Verdict',
      '',
      'The pain is real and the fit is unknown; I am not pivoting on an unknown.',
      '',
      'FINDING: the wedge is right and the fit is the open question',
      '',
      'VERDICT: WEAK',
      'RUBRIC: core assumption 2, fatal flaws 1, pain 2, founder fit 0, why now 1',
    ].join('\n'),
    verdict: 'WEAK',
    rubric: R(2, 1, 2, 0, 1),
    flaws: [
      'The county caterer holds the contract and renews every August',
      'Nobody has quoted the 7am van',
    ],
  },
];

describe('the corpus: every shape a chair actually writes (rulings H1, H2)', () => {
  it('has more than a dozen entries, so the parse is judged on a corpus and not on one example', () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(12);
  });

  for (const c of CORPUS) {
    it(c.name, () => {
      const r = readPressureVerdict(c.text);
      if (c.verdict === null) {
        expect(r.ok).toBe(false);
        if (c.reason) expect(r.ok === false && r.reason).toBe(c.reason);
        return;
      }
      expect(r.ok, c.name).toBe(true);
      if (!r.ok) throw new Error('unreachable');
      expect(r.verdict).toBe(c.verdict);
      if (c.rubric !== undefined) expect(r.rubric).toEqual(c.rubric);
      if (c.flaws !== undefined) expect(r.flaws).toEqual(c.flaws);
      if (c.wedge !== undefined) {
        expect(r.wedge).toBe(c.wedge);
        expect(pressureFindings(r)[0]).toContain(c.wedge);
      }
    });
  }
});

describe('the rubric survives every way a chair names its own total (C1)', () => {
  // Each of these threw the whole rubric away before ruling H2: the chair is told the rubric is "out of 10" and
  // shown a worked example that leads with `7/10`, so a second number on the line is what compliance looks like.
  const lines = [
    'RUBRIC: core assumption 2, fatal flaws 1, pain 2, founder fit 1, why now 1 — total 7/10',
    'RUBRIC: core assumption 2, fatal flaws 1, pain 2, founder fit 1, why now 1 (7/10)',
    'RUBRIC: core assumption 2, fatal flaws 1, pain 2, founder fit 1, why now 1 = 7 out of 10',
    'RUBRIC: core assumption 2/2, fatal flaws 1/2, pain 2/2, founder fit 1/2, why now 1/2',
    'RUBRIC: 7/10 — core assumption 2, fatal flaws 1, pain 2, founder fit 1, why now 1',
  ];
  for (const line of lines) {
    it(`reads ${line.slice(8, 48)}…`, () => {
      expect(parseRubric(line)).toEqual(R(2, 1, 2, 1, 1));
    });
  }

  it('and still refuses a placeholder, a range and prose, which are not scores', () => {
    expect(parseRubric('RUBRIC: core assumption <0-2>, fatal flaws <0-2>, pain <0-2>, founder fit <0-2>, why now <0-2>')).toBeNull();
    expect(parseRubric('RUBRIC: core assumption 1-2, fatal flaws 1, pain 2, founder fit 1, why now 1')).toBeNull();
    expect(parseRubric('RUBRIC: core assumption high, fatal flaws 1, pain 2, founder fit 1, why now 1')).toBeNull();
    expect(parseRubric('RUBRIC: core assumption 2, fatal flaws 1, pain 2, founder fit 1')).toBeNull();
    expect(parseRubric('RUBRIC: core assumption 3, fatal flaws 1, pain 2, founder fit 1, why now 1')).toBeNull();
  });
});

describe('an enumeration standing in place of the answer is never a vote (C2)', () => {
  // Every one of these reached the parse as the answer's only verdict line. Four of them used to pass as STRONG,
  // which is the one direction spec Decision 7 rules out: an idea nobody judged would have been passed.
  const echoes = [
    'VERDICT: STRONG | WEAK | PIVOT REQUIRED',
    'VERDICT: [STRONG | WEAK | PIVOT REQUIRED]',
    'VERDICT: STRONG/WEAK/PIVOT REQUIRED',
    'VERDICT: <STRONG|WEAK|PIVOT REQUIRED>',
    'VERDICT: STRONG, WEAK, or PIVOT REQUIRED',
    'VERDICT: STRONG, WEAK or PIVOT REQUIRED',
    'VERDICT: one of STRONG, WEAK, PIVOT REQUIRED',
  ];
  for (const echo of echoes) {
    it(`refuses ${echo}`, () => {
      const r = readPressureVerdict(echo);
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.reason).toBe(PRESSURE_REFUSAL_MISSING);
    });
  }

  it('but a chair that names one outcome and argues against another has voted', () => {
    for (const [text, verdict] of [
      ['VERDICT: WEAK (not STRONG)', 'WEAK'],
      ['VERDICT: STRONG, and no pivot is required', 'STRONG'],
      ['VERDICT: WEAK - not STRONG enough', 'WEAK'],
      ['VERDICT: PIVOT REQUIRED (not STRONG or WEAK)', 'PIVOT REQUIRED'],
    ] as const) {
      expect(readPressureVerdict(text), text).toMatchObject({ ok: true, verdict });
    }
  });
});
