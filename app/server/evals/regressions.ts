// The defects the co-founder journeys found that a check in code now holds, each put back through that check with the
// journey's own words. No model and no key: `pnpm check:evals` runs them first, and so does the unit suite
// (regressions.test.ts). A case says which journey found the defect, so a failure here names what came back.
//
// Only defects with a check in code are here: the judge's guard, caps and sums, her standing line, the colleague
// answer that is a menu, the Company brief's counts, and the truth net's rules. What a model chooses to say is proved
// live, on a journey, and nowhere else.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Framework } from '../../shared/frameworks.ts';
import type { DocRules, Stage } from '../../shared/model.ts';
import { parsePlan, planTaskTitle } from '../../shared/partner.ts';
import { place } from '../frameworks/place.ts';
import { customerReply } from '../partner/audience.ts';
import { cannotLose } from '../partner/bets.ts';
import { companyFacts, keepFacts, runwayFix } from '../partner/keep.ts';
import { asksCommitment, buildsAgainst, stripStance } from '../partner/pushback.ts';
import { NOTHING_WAITING, staleNeeds } from '../partner/standing.ts';
import { answerIntoSection, substance } from '../tools/docs.ts';
import type { ToolContext } from '../tools/registry.ts';
import { replaceSection } from '../tools/sections.ts';
import { breakdownMismatch, conversations, guardWrite, sectionBody, standingVerdict, verdictOf, WHOLE } from '../tools/verdict.ts';
import { checkReply, figureCheck, verdictRefused, verdictUnwritten } from '../truth.ts';

export type Regression = { defect: string; check: () => Promise<string | null> | string | null };

// What went wrong, or null: the got and the wanted side by side, as a failing case prints them.
const same = (got: unknown, want: unknown, what: string) =>
  (JSON.stringify(got) === JSON.stringify(want) ? null : `${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const holds = (ok: boolean, what: string) => (ok ? null : what);
const first = (...faults: (string | null)[]) => faults.find(Boolean) ?? null;

const OUTCOMES = ['WEAK', 'PIVOT REQUIRED', 'STRONG'];
const LABEL = 'Real customer conversations done';
const FILLED: Record<string, string> = {
  '1. Core assumption (falsifiable)': 'EU solo consultants will pay $29/month to have VAT returns drafted from their bank feed.',
  '2. Three specific ways it dies': '1. Reverse-charge liability lands on us — survivable? No.',
  '3. Is the pain real?': 'Painkiller\n\nReal customer conversations done (of ten to twenty): 3',
  '4. Founder-market fit': 'Lived it: filed VAT by hand for their own studio.',
};

// The startup evaluation team placed on an empty stage, as the app ships it: its rules, and its Evaluation doc with
// every section written except those named.
async function team() {
  const framework = JSON.parse(await readFile(resolve(import.meta.dirname, '../../frameworks/startup-evaluation/framework.json'), 'utf8')) as Framework;
  const { placed, texts } = place(framework, { rooms: [], docs: [], cards: [] }, { x: 0, y: 0 });
  const stage: Stage = { rooms: placed.rooms, docs: placed.docs, wires: placed.wires, cards: placed.cards };
  const doc = placed.docs.find((one) => one.rules)!;
  const rules = doc.rules as DocRules;
  const written = (skip: string[] = [], extra: Record<string, string> = {}) => Object.entries({ ...FILLED, ...extra })
    .filter(([heading]) => !skip.includes(heading))
    .reduce((text, [heading, body]) => { const next = replaceSection(text, heading, body); return 'text' in next ? next.text : text; }, texts[doc.id]);
  const withVerdict = (text: string, verdict: string) => { const next = replaceSection(text, '5. Verdict', verdict); return 'text' in next ? next.text : text; };
  const guard = (writerId: string, before: string, after: string, touches?: string | typeof WHOLE, numbers?: string) =>
    guardWrite({ rules, stage, docId: doc.id, writerId, before, after, now: Date.UTC(2026, 8, 27), touches, numbers });
  const refusal = (write: () => unknown) => { try { write(); return null; } catch (error) { return (error as Error).message; } };
  return { stage, rules, docId: doc.id, written, withVerdict, guard, refusal };
}

// Rohan answering Priya's ask_person, with the doc held in memory. Returns what Priya is told and section 4 after.
async function rohanAnswers(answer: string, question = 'What goes in section 4, the founder-market fit?') {
  const { stage, docId, written } = await team();
  const docs: Record<string, string> = { [docId]: written(['4. Founder-market fit']) };
  const store = { readDoc: async (id: string) => docs[id] ?? '', replaceDoc: async (id: string, text: string) => { docs[id] = text; }, readChat: async () => [] };
  const context = { stage, roomId: 'verdict', store, granted: new Map(), sources: () => [] } as unknown as ToolContext;
  const told = await answerIntoSection(context, 'fit', question, answer);
  return { told: told ?? '', section: sectionBody(docs[docId], '4. Founder-market fit') ?? '' };
}

const NUMBERS = '- Paying beta users: 3 (founder, 2026-09-27)\n- Cash: €4,200\n- Burn: €1,100/month';
const BRIEF = `# Company brief\n\n## Idea\n\n- I'm building Ledgerly: $29/month bookkeeping (founder, 2026-09-27)\n\n## Customer\n\n## Numbers\n\n${NUMBERS}\n\n## Open questions\n`;
const WEAK = { title: 'Evaluation', word: 'WEAK', score: 5 };

export const REGRESSIONS: Regression[] = [
  // ------------------------------------------------------------------ the judge's guard, caps and sums
  {
    defect: 'J5 #4: the judge rewrote the same verdict over a section the founder had emptied, and "Fit: 8" stood',
    async check() {
      const { guard, written, withVerdict } = await team();
      const verdict = 'WEAK\n\nScore: 3/10 (Assumption: 1, Flaws: 0, Pain: 1, Fit: 1, Why Now: 0)';
      const before = withVerdict(written(['4. Founder-market fit']), verdict);
      const out = guard('verdict', before, before, '5. Verdict');
      return first(holds(!!out.held, 'the unchanged verdict was not held'), holds(/^Not assessed: 4\. Founder-market fit \(Rohan has not written it yet\)/.test(sectionBody(out.text, '5. Verdict') ?? ''), 'the verdict does not say "Not assessed"'));
    },
  },
  {
    defect: 'J5 #6: "5/10 (Assumption: 1, Flaws: 3, Pain: 1, Fit: 8, Why Now: 2)" was written though the parts make 3/10',
    check: () => holds(/add up to 15 of 50, which is 3 of 10/.test(breakdownMismatch('Score: 5/10 (Assumption: 1, Flaws: 3, Pain: 1, Fit: 8, Why Now: 2)') ?? ''), 'the sum was not refused'),
  },
  {
    defect: 'J6 #5: "8/10 (assumption 1, flaws 0, pain 1, fit 2, why now 2)" got through, parts written without a colon',
    check: () => holds(/add up to 6 of 10/.test(breakdownMismatch('Score: 8/10 (assumption 1, flaws 0, pain 1, fit 2, why now 2)') ?? ''), 'the label-N sum was not refused'),
  },
  {
    defect: 'Round 6 parked: score parts written "1 of 2" were never added up',
    check: () => holds(/add up to 2 of 6/.test(breakdownMismatch('Score: 9/10 (pain 1 of 2, fit 1 of 2, flaws 0 of 2)') ?? ''), 'the a-of-b sum was not refused'),
  },
  {
    defect: 'J7 #7: the no-talks cap told the judge "at most WEAK" over PIVOT REQUIRED 6/10, and she softened a fatal flaw',
    async check() {
      const { guard, refusal, written, withVerdict } = await team();
      const before = written([], { '3. Is the pain real?': 'Painkiller\n\nReal customer conversations done (of ten to twenty): 0' });
      const pivot = refusal(() => guard('verdict', before, withVerdict(before, 'PIVOT REQUIRED\n\nScore: 4/10')));
      const over = refusal(() => guard('verdict', before, withVerdict(before, 'PIVOT REQUIRED\n\nScore: 6/10'))) ?? '';
      return first(same(pivot, null, 'PIVOT REQUIRED at 4/10 under the cap'), holds(/score is at most 5\/10 and the verdict is not STRONG; WEAK or PIVOT REQUIRED stand/.test(over), `the cap's words: ${over}`));
    },
  },
  {
    defect: 'J5 #14: the cap said "0 / 20 conversations" to a team whose founder had 3 paying beta users',
    async check() {
      const { guard, refusal, written, withVerdict } = await team();
      const before = written([], { '3. Is the pain real?': 'Painkiller\n\nReal customer conversations done (of ten to twenty): 0' });
      const said = refusal(() => guard('verdict', before, withVerdict(before, 'STRONG\n\nScore: 8/10'), undefined, NUMBERS)) ?? '';
      return first(holds(said.includes('the Numbers section says 3 paying users'), `refusal: ${said}`),
        same(conversations('Real customer conversations done: 12 (goal was 20)', LABEL), 12, 'a count beside a goal'));
    },
  },
  {
    defect: 'J7 #11: "(1) (2) (3 - ...)" section markers left on the verdict\'s score lines',
    async check() {
      const { guard, written, withVerdict } = await team();
      const before = written();
      const out = guard('verdict', before, withVerdict(before, 'WEAK\n\n- Because: 3/12 said it hurts (3).\n- Pain: 1/2 (3 - only 3 beta users)\n- Fit: 2/2 (4)\n\nScore: 5/10'));
      return same(sectionBody(out.text, '5. Verdict'), 'WEAK\n\n- Because: 3/12 said it hurts (3).\n- Pain: 1/2 (only 3 beta users)\n- Fit: 2/2\n\nScore: 5/10', 'verdict as saved');
    },
  },
  // ------------------------------------------------------------------ the judge's standing line and the truth net on her
  {
    defect: 'J5 #5 / J6 #6: after a refused write the judge said "WEAK ... Score 5/10" in chat anyway',
    check: () => {
      const receipts = [{ name: 'replace_section', ok: true, result: `Not written: ... ${verdictRefused('Rohan has not written "4. Founder-market fit" yet', OUTCOMES)}` }];
      return same(verdictUnwritten('**WEAK** — Score: 5/10 (Fit: 8)', receipts), 'Unconfirmed: the verdict was not written; Rohan has not written "4. Founder-market fit" yet.', 'flag');
    },
  },
  {
    defect: 'J7 #4 / J8 #2: with section 4 empty and no write tried, "PIVOT REQUIRED ... 6/10" in chat went unflagged',
    async check() {
      const { stage, rules, docId, written } = await team();
      const line = standingVerdict(stage, 'verdict', docId, rules, written(['4. Founder-market fit']));
      if (!line) return 'no standing line while section 4 is empty';
      return first(
        same(verdictUnwritten('PIVOT REQUIRED. 6/10.', [], [line]), 'Unconfirmed: the verdict was not written; Rohan has not written "4. Founder-market fit" yet.', 'flag'),
        same(standingVerdict(stage, 'pain', docId, rules, written(['4. Founder-market fit'])), null, 'a colleague gets the judge\'s line'),
      );
    },
  },
  {
    defect: 'J8 #3: on the refusing turn and the next, the verdict was said and only then flagged',
    check: () => {
      const lines = checkReply({ reply: 'PIVOT REQUIRED — 5/10.', receipts: [], sources: ['Your verdict is not written: Rohan has not written "4. Founder-market fit" yet. Name no verdict word (WEAK, PIVOT REQUIRED, STRONG) or score in chat until it is.'] });
      return holds(lines.includes('Unconfirmed: the verdict was not written; Rohan has not written "4. Founder-market fit" yet.'), `flags: ${JSON.stringify(lines)}`);
    },
  },
  // ------------------------------------------------------------------ a colleague's answer from chat
  {
    defect: 'J8 #4 / J7 #8: Rohan\'s pick-one menu for the founder was stored as section 4',
    async check() {
      const menu = '**Founder‑market fit (Section 4)**\n\n*Why you?* – Please tell me which of the following applies to you (pick **one** or more):\n\n- **Lived the problem**\n- **Unusual access**\n\n*Please provide the applicable reason(s) so I can complete Section 4.*';
      const { told, section } = await rohanAnswers(menu);
      return first(holds(told.includes('did not fill "4. Founder-market fit"'), `told: ${told}`), holds(!section.includes('Lived the problem'), 'the menu went in'));
    },
  },
  {
    defect: 'J6 #7: Rohan wrote "~200 solo-consultant peers" the founder never said into section 4',
    async check() {
      const { told, section } = await rohanAnswers('Earned secret: during those 6 years you built relationships with ~200 solo-consultant peers.');
      return first(holds(/Rohan's answer gives ~200 that nothing Rohan read gives/.test(told), `told: ${told}`), holds(!section.includes('~200'), 'the figure went in'));
    },
  },
  {
    defect: 'J5 #13: a from-chat section opened "✅ Section 4 ... is now completed:" and closed "You can now proceed to write the verdict."',
    check: () => same(substance('✅ **Section 4 – Founder‑market fit** in the Evaluation doc is now completed:\n\nLived it: filed VAT by hand.\n\nYou can now proceed to write the verdict.', '4. Founder-market fit'), 'Lived it: filed VAT by hand.', 'section body'),
  },
  {
    defect: 'Round 6 parked: an answer that uses "which of these" in a sentence was skipped as a question',
    async check() {
      const { section } = await rohanAnswers('Lived it: she tested which of these channels reach solo consultants, and cold email won.');
      return holds(section.startsWith('Lived it: she tested'), `section 4: ${section}`);
    },
  },
  // ------------------------------------------------------------------ the Company brief's counts
  {
    defect: 'J8 #1: "or wait until 10 paying users" overwrote "Paying beta users: 3"',
    check: () => {
      const { text } = keepFacts(BRIEF, companyFacts('Put a decision in my list: should I build invoicing this week? Options: build it now, or wait until 10 paying users.'), '2026-09-28');
      return holds(text.includes('Paying beta users: 3') && !/users: 10/i.test(text), `Numbers: ${sectionBody(text, 'Numbers')}`);
    },
  },
  {
    defect: 'J7 #6 / J6 #12: "Paying beta users: 3" and "Users: 3" made two users rows',
    check: () => {
      const { text } = keepFacts(BRIEF.replace(NUMBERS, ''), { numbers: [{ label: 'Paying users', value: '3' }, { label: 'Users', value: '3' }] }, '2026-09-27');
      return same(text.match(/^- .*users.*$/gim)?.length, 1, 'users rows');
    },
  },
  {
    defect: 'J8 #8: the Numbers held "Monthly burn: €1,100" and "Burn: €1,100/month" side by side',
    check: () => {
      const brief = BRIEF.replace('- Burn: €1,100/month', '- Monthly burn: €1,100');
      const { text } = keepFacts(brief, companyFacts('Burn is €1,100/month.'), '2026-09-28');
      return same(text.match(/burn/gi)?.length, 1, 'burn rows');
    },
  },
  {
    defect: 'Round 5 hotfix: "Revenue target: €10k" was replaced by "MRR: €300"',
    check: () => {
      const brief = BRIEF.replace(NUMBERS, '- Revenue target: €10k');
      const { text } = keepFacts(brief, companyFacts('MRR is €300 a month now.'), '2026-09-28');
      return holds(text.includes('Revenue target: €10k') && /MRR: €300/.test(text), `Numbers: ${sectionBody(text, 'Numbers')}`);
    },
  },
  // ------------------------------------------------------------------ the partner's checks in code
  {
    defect: 'J5 #1: a bet on paying users with the target 3 while the Metrics card reads 3',
    check: () => holds(/a target of 3 cannot lose/.test(cannotLose('paying_users', 3, { value: 3, said: '3, read from the Metrics card' }) ?? ''), 'the bet was let through'),
  },
  {
    defect: 'J5 #2 / J6 #3: "My call: dive straight into building the client profile form" under a WEAK verdict',
    check: () => first(
      holds(buildsAgainst('My call: dive straight into building the client profile form today.', WEAK), 'building against the verdict was not caught'),
      holds(!buildsAgainst('My call: pause coding and book the 3 interviews first.', WEAK), 'a call not to build was caught'),
    ),
  },
  {
    defect: 'J5 #7 / J6 #4 / J7 #5: "Approve the tasks waiting in your Needs you list" with nothing waiting',
    check: () => first(
      holds(staleNeeds('1. Approve the tasks on your board, waiting in your Needs you list.', []).endsWith(NOTHING_WAITING), 'Needs you advice'),
      holds(staleNeeds('Check your decisions list and approve the pricing call.', []).endsWith(NOTHING_WAITING), 'decisions-list advice'),
    ),
  },
  {
    defect: 'J5 #8: "should we raise the price? Give me a number." read as raising money',
    check: () => same(asksCommitment('should we raise the price? Give me a number.'), false, 'commitment'),
  },
  {
    defect: 'J5 #10: runway said as "4 months" from €4,200 over €1,100',
    check: () => same(runwayFix('You have 4 months of runway left.', NUMBERS), 'You have 4 months (3.8 months) of runway left.', 'runway'),
  },
  {
    defect: 'J5 #11 / J6 #13: plan titles kept "Day 1–2:" and "Week 2 Days 1-3:"',
    check: () => {
      const steps = parsePlan('- Day 1–2: Build a minimal client form\n- Week 2 Days 1-3: Ship the PDF invoice');
      return same(steps.map((step) => planTaskTitle(step, '2026-09-27')), ['Build a minimal client form', 'Ship the PDF invoice'], 'titles');
    },
  },
  {
    defect: 'J6 #10 / J7 #9: the stance ("Before any plan to raise money, hire, spend or pivot ...", "Never round this upward.") said to the founder',
    check: () => same(stripStance('Runway is 3.8 months. Never round this upward.\n\nMy call: hold the burn.'), 'Runway is 3.8 months.\n\nMy call: hold the burn.', 'reply'),
  },
  {
    defect: 'J5 #12: a beta-user update kept "[Board]" tags and "(founder to add)" placeholders',
    check: () => same(customerReply('# October update\n## Invoices\nComing next week [Board].\n## Asks\n- (founder to add)', NUMBERS), '# October update\n## Invoices\nComing next week.', 'customer text'),
  },
  // ------------------------------------------------------------------ the truth net's figure rules
  {
    defect: 'J5 #9: the partner\'s own options "$49, $79" flagged as unsourced',
    check: () => same(figureCheck('Options: keep $29, raise to $49, or go to $79.', ['Price: $29/month']), { unsourced: [], proposals: ['$49', '$79'] }, 'figures'),
  },
  {
    defect: 'J6 #8: "€29 × 3 ≈ €87" from a $29 price went unflagged',
    check: () => holds(checkReply({ reply: 'Revenue €29 × 3 ≈ €87 / month.', receipts: [], sources: ['Price: $29/month. Paying beta users: 3.'] }).some((line) => line.startsWith('Currency changed: €29 (source $), €87 (source $)')), 'no currency flag'),
  },
  {
    defect: 'J7 #11: "Unsourced figures: 100%" on "100% of your time"',
    check: () => same(figureCheck('Spend 100% of your time on sales this week.', []).unsourced, [], 'unsourced'),
  },
];

// Every case run, in order: the ones that failed with what went wrong.
export async function runRegressions(cases: Regression[] = REGRESSIONS): Promise<{ passed: number; failed: { defect: string; fault: string }[] }> {
  const failed: { defect: string; fault: string }[] = [];
  for (const one of cases) {
    let fault: string | null;
    try { fault = await one.check(); } catch (error) { fault = `threw: ${(error as Error).message}`; }
    if (fault) failed.push({ defect: one.defect, fault });
  }
  return { passed: cases.length - failed.length, failed };
}
