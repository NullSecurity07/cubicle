import { describe, expect, it } from 'vitest';
import type { Bet } from '../../shared/partner.ts';
import type { TurnResult } from '../loop.ts';
import type { StandingParts } from './standing.ts';
import { asksWhatNext, citedFacts, holdSynthesis, standingFacts, synthesisNudge, synthesises, UNTIED } from './synthesis.ts';

const bet: Bet = { id: 'b1', made: '2026-09-27', what: 'Ship PDF invoicing to grow paying users to 4', hypothesis: 'they pay', metric: 'paying_users', target: 4, checkDate: '2026-10-11', status: 'open', at: 1 };
const parts = (extra: Partial<StandingParts> = {}): StandingParts => ({
  verdicts: ['- Evaluation, 5. Verdict: PIVOT REQUIRED, score 6/10. Interview 10 more consultants before writing further code.'],
  numbers: '- Cash: €4,200\n- Monthly burn: €1,100\n- Paying beta users: 3 (founder, 2026-09-27)',
  open: [bet], planned: ['- left from 2026-09-26: Build the VAT export format'], flagCounts: [],
  decided: ['- 2026-09-27 Invoicing timing: wait until 10 paying users'],
  learned: ['- 2026-09-20: Cold email 30 did not work; "leads:replied" was 1 against 5.'],
  promised: ['- call 5 beta users by Friday (due 2026-10-02)'],
  ...extra,
});
const turn = (text: string, extra: Partial<TurnResult> = {}): TurnResult => ({ text, tools: [], provider: 'p', model: 'm', usage: { input: 1, output: 1 }, stopped: false, ...extra });

describe('an ask for what to do next', () => {
  it('is "what do I do now", "what\'s next", "plan the week" and their kin, and not an ordinary question', () => {
    for (const said of ['so what do I do right now?', 'What\'s next?', 'what now', 'Plan the week for me', 'plan my week', 'What should we focus on this week?', 'next steps?', 'Where do I start?'])
      expect(asksWhatNext(said), said).toBe(true);
    for (const said of ['What is our runway?', 'Write the beta-user update', 'What is next to the logo?']) expect(asksWhatNext(said), said).toBe(false);
  });
});

describe('the standing facts a reply names', () => {
  const facts = standingFacts(parts());

  it('reads one fact per verdict, number, bet, lesson, due task, promise and decision', () => {
    expect(facts.map((one) => one.kind)).toEqual(['verdict', 'numbers', 'numbers', 'numbers', 'bets', 'learned', 'due', 'promise', 'decided']);
  });

  it('knows each by its name, its number or its words, not by a word any advice uses', () => {
    const named = (reply: string) => citedFacts(reply, facts).map((one) => one.line);
    expect(named('The PIVOT REQUIRED verdict comes first.')).toEqual([facts[0].line]);
    expect(named('The Evaluation says talk to users.')).toEqual([facts[0].line]);
    expect(named('With €4,200 in the bank and €1,100 going out')).toEqual(['- Cash: €4,200', '- Monthly burn: €1,100']);
    expect(named('your cash lasts; the burn is fine')).toEqual(['- Cash: €4,200', '- Monthly burn: €1,100']);
    expect(named('Keep your 3 paying users happy.')).toEqual(['- Paying beta users: 3 (founder, 2026-09-27)']);
    expect(named('Talk to users today.')).toEqual([]);
    expect(named('Your bet on paying_users checks on Oct 11.')).toEqual([expect.stringContaining('Ship PDF invoicing')]);
    expect(named('Cold email did not work last time: 1 reply against 5.')).toEqual([facts[5].line]);
    expect(named('Finish the VAT export format first.')).toEqual([facts[6].line]);
    expect(named('You said you would call 5 beta users by Friday.')).toEqual([facts[7].line]);
    expect(named('You decided to wait until 10 paying users on invoicing.')).toEqual([facts[8].line]);
  });

  it('holds a reply to two facts from two kinds, when the stage has two kinds', () => {
    expect(synthesises('My call: dive straight into building the PDF invoicing feature.', facts)).toBe(false);
    expect(synthesises('With €4,200 cash and €1,100 burn, move fast.', facts)).toBe(false);
    expect(synthesises('The PIVOT REQUIRED verdict and €4,200 in cash say: interviews before code.', facts)).toBe(true);
    // One kind on the stage: two of it will do; one fact alone asks nothing.
    const numbersOnly = standingFacts(parts({ verdicts: [], open: [], planned: [], decided: [], learned: [], promised: [] }));
    expect(synthesises('With €4,200 cash and €1,100 burn, move fast.', numbersOnly)).toBe(true);
    expect(synthesises('Anything.', standingFacts(parts({ verdicts: [], numbers: '- Cash: €4,200', open: [], planned: [], decided: [], learned: [], promised: [] })))).toBe(true);
  });
});

describe('a partner reply to "what now" held to the standing facts', () => {
  const facts = standingFacts(parts());
  const FIRST = 'My call: open your task board and dive into building the PDF invoicing feature.';
  const GOOD = 'The PIVOT REQUIRED verdict says interviews before code, and €4,200 cash at €1,100 burn is under four months.\n\nMy call: book five interviews today.';

  it('asks once more with the facts quoted, and keeps the answer that names them', async () => {
    const nudges: string[] = [];
    const held = await holdSynthesis('what do I do now?', turn(FIRST), async (_first, nudge) => { nudges.push(nudge); return turn(GOOD); }, facts);
    expect(nudges).toEqual([synthesisNudge(facts)]);
    expect(nudges[0]).toContain('- Evaluation, 5. Verdict: PIVOT REQUIRED');
    expect(nudges[0]).toContain('- Cash: €4,200');
    expect(held.text).toBe(GOOD);
    expect(held.usage).toEqual({ input: 2, output: 2 });
  });

  it('labels a second miss, and a first that already did something, without asking again', async () => {
    const missed = await holdSynthesis('what\'s next?', turn(FIRST), async () => turn('My call: build it.'), facts);
    expect(missed.text).toBe(`My call: build it.\n\n${UNTIED}`);
    let asked = 0;
    const did = await holdSynthesis('what\'s next?', turn(FIRST, { tools: [{ id: 't', name: 'propose_decision', args: {}, ok: true }] }), async () => { asked += 1; return turn(GOOD); }, facts);
    expect(asked).toBe(0);
    expect(did.text).toBe(`${FIRST}\n\n${UNTIED}`);
    // A turn that already took its second look is only labelled.
    const looked = await holdSynthesis('what\'s next?', turn(FIRST), async () => { asked += 1; return turn(GOOD); }, facts, true);
    expect(asked).toBe(0);
    expect(looked.text).toBe(`${FIRST}\n\n${UNTIED}`);
    expect(UNTIED).toBe('*Not tied to the standing facts.*');
  });

  it('leaves other asks, stopped replies and a reply that names the facts alone', async () => {
    let asked = 0;
    const again = async () => { asked += 1; return turn(GOOD); };
    expect((await holdSynthesis('Write the beta update', turn(FIRST), again, facts)).text).toBe(FIRST);
    expect((await holdSynthesis('what now?', turn(FIRST, { stopped: true }), again, facts)).text).toBe(FIRST);
    expect((await holdSynthesis('what now?', turn(GOOD), again, facts)).text).toBe(GOOD);
    expect(asked).toBe(0);
  });
});
