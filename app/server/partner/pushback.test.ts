import { describe, expect, it } from 'vitest';
import type { TurnResult } from '../loop.ts';
import { asksCommitment, buildsAgainst, checksPreconditions, holdPartner, isWeak, oneCall, PRECONDITION_NUDGE, stripStance, UNCHECKED, UNWEIGHED } from './pushback.ts';

const JOURNEY = 'I want to raise a $2M pre-seed next week. We have no users. Draft the plan.';
const turn = (text: string, tools: TurnResult['tools'] = []): TurnResult => ({ text, tools, provider: 'p', model: 'm', usage: { input: 10, output: 5 }, stopped: false });

describe('the partner\'s precondition check', () => {
  it('knows a founder asking for a raise, hire, spend or pivot plan, and not an ask that only shares the words', () => {
    for (const said of [JOURNEY, 'Plan how we hire two engineers next month', 'Draft a budget to spend $20k on ads', "Let's pivot to B2B, write the plan", 'We should pivot to B2B. Thoughts?', 'should we hire a designer eventually?', 'Should we raise now?', 'Draft outreach to investors for our seed']) expect(asksCommitment(said), said).toBe(true);
    for (const said of ['What do you think of the name?', 'Draft the landing page copy', 'We raised the price, how do users react?', 'help me write an investor update', "let's spend the afternoon on customer calls", 'I want to raise the price to $20']) expect(asksCommitment(said), said).toBe(false);
  });

  // Routine outreach and small spend are the founder's week, not a commitment: the audits' phrases, each asked for
  // the preconditions and a "Not yet" they did not need.
  it('leaves routine investor mail, outreach, small spend and a contractor alone, and still knows a raise, headcount, a big spend or a budget', () => {
    for (const said of ['Help me draft the monthly email to investors', 'draft monthly email to investors', 'plan outreach to investors', 'Plan intros to two angels who asked for the deck',
      'plan how we spend the $300 ad budget', 'hire a contractor for the landing page', 'Help me hire a freelancer for the logo', 'should we hire a contractor for the site?',
      'help me write an investor update', "Let's spend $200 on ads this week", 'Draft the investor update email']) expect(asksCommitment(said), said).toBe(false);
    for (const said of ['Help me plan a seed round of $500k', "Let's raise $1.5M from angels", 'Plan how we spend $5,000 on ads', 'Draft a budget for the launch', 'Plan how we spend our savings on this',
      'Help me hire our first engineer', "Let's hire 3 people next quarter", 'Plan the pivot to agencies', 'Should we raise a pre-seed?']) expect(asksCommitment(said), said).toBe(true);
  });

  // The review's probes: a large sum is a commitment whichever verb sits beside it, and so is money from angels, a VC or a lender.
  it('knows a large sum beside any money verb, either side, and money from angels, a VC, a loan or an offer', () => {
    for (const said of ['help me plan a $15k spend on a conference', "Let's put $20k into Google ads", 'Plan to allocate $50,000 to marketing', 'plan spending 1,500 dollars on ads',
      'Should we take the $250k offer from the VC?', 'I want to raise from angels', 'Should we take on a $100k loan?', 'Help me plan a $5k budget', "Let's invest 10k in a booth"]) expect(asksCommitment(said), said).toBe(true);
    for (const said of ['Draft a $300 budget for the ad test', 'Should we hire a freelance designer?', "Let's put $200 into boosting the post", 'Plan to pay $50 for the domain']) expect(asksCommitment(said), said).toBe(false);
  });

  // Round 2: money already spent, a price, a thank-you and a user count are not asks to commit.
  it('leaves money already spent, a price, an offer of help and a count of users alone', () => {
    for (const said of ['we pay $1,200/month rent, help me draft the landlord email', 'we burned $3k last month, help me plan the week', 'Help me draft a thank-you note for the $1,000 offer of help',
      'Help me plan pay-as-you-go pricing at $2k/year', "20k users by Q1, what should we pay attention to? Let's plan", 'We spent $5k on ads last month, help me draft the recap']) expect(asksCommitment(said), said).toBe(false);
  });

  // Journey 5: "should we raise the price?" read as a raise and posted with "Partner did not check preconditions."
  it('never takes raising a price, prices, pricing, rates or fees as a raise ask, however it is asked', () => {
    for (const said of ['should we raise the price? Give me a number.', 'Should we raise prices?', 'should I raise pricing next month?', 'Should we raise our rates?', 'should we raise the fees for new users?',
      'Should we raise our monthly price to $49?', "Let's raise pricing for new customers, plan it", 'Help me plan how we raise prices by 20%']) expect(asksCommitment(said), said).toBe(false);
    for (const said of ['Should we raise now?', 'Should we raise a pre-seed?', 'should we raise money before pricing is settled?']) expect(asksCommitment(said), said).toBe(true);
  });

  it('knows a reply that checked the preconditions, however it says no', () => {
    for (const reply of ['Not yet. Before that, get 20 paying users.', 'I disagree: no users means no round.\n\nMy call: no.', 'No. Here is why: nobody has paid yet.', "I'd hold off until you have ten users.", 'Plan below.\n\nMy call: not now.', 'Too early. First get ten paying readers.', "Don't raise yet: nobody pays so far.", 'My call: **wait** a month.']) expect(checksPreconditions(reply), reply).toBe(true);
    expect(checksPreconditions('Here is your 7-phase raise plan. 1. Prepare a SAFE with a $2M cap.')).toBe(false);
    expect(checksPreconditions('Great idea. Know your numbers before the first call.')).toBe(false);
    // The journey's own failure, and replies that only start a line with "No" or say "wait", are not pushback.
    for (const reply of ['Here is the plan.\n\nNo existing marketplace serves this niche, so investors will love it.\n\nMy call: raise $2M.', 'Steps:\n- No-code landing page\n- SAFE at $2M\n\nMy call: go.', 'Wait for replies in week 2, then send the deck.\n\nMy call: go.']) expect(checksPreconditions(reply), reply).toBe(false);
    for (const reply of ["You can't raise without users.", 'I have to push back on this.', 'Wait until you have ten paying readers.']) expect(checksPreconditions(reply), reply).toBe(true);
  });

  it('asks once more with the nudge when a raise plan comes back unchecked, and keeps the tools of both', async () => {
    let asked = 0;
    const reply = await holdPartner(JOURNEY, turn('Phase 1: SAFE at $2M.', [{ id: 't1', name: 'web_search', args: {}, ok: true }]), async (first) => { asked += 1; expect(first.text).toBe('Phase 1: SAFE at $2M.'); return turn('Not yet. Before that: 20 users.\n\nMy call: no raise this month.'); });
    expect(asked).toBe(1);
    expect(reply.text).toBe('Not yet. Before that: 20 users.\n\nMy call: no raise this month.');
    expect(reply.tools.map((one) => one.id)).toEqual(['t1']);
    expect(reply.usage).toEqual({ input: 20, output: 10 });
  });

  it('never asks again after a first answer that did something, and labels it instead', async () => {
    let asked = 0;
    const wrote = turn('Here is the raise plan, saved as a doc.', [{ id: 'w1', name: 'create_doc', args: { title: 'Raise plan' }, ok: true }]);
    const reply = await holdPartner(JOURNEY, wrote, async () => { asked += 1; return turn('x'); });
    expect(asked).toBe(0);
    expect(reply.text).toBe(`Here is the raise plan, saved as a doc.\n\n${UNCHECKED}`);
    expect(reply.tools.map((one) => one.id)).toEqual(['w1']);
  });

  it('posts the second answer with a line for the founder when it still did not check', async () => {
    const reply = await holdPartner(JOURNEY, turn('Phase 1: SAFE.'), async () => turn('Phase 1: SAFE, again.'));
    expect(reply.text).toBe(`Phase 1: SAFE, again.\n\n${UNCHECKED}`);
    expect(UNCHECKED).toContain('Partner did not check preconditions.');
  });

  it('leaves other asks, checked replies and stopped turns alone', async () => {
    let asked = 0;
    const again = async () => { asked += 1; return turn('x'); };
    await holdPartner('What do you think of the name?', turn('Fine.'), again);
    await holdPartner(JOURNEY, turn('Not yet.'), again);
    await holdPartner(JOURNEY, { ...turn('Phase 1'), stopped: true }, again);
    expect(asked).toBe(0);
    expect(PRECONDITION_NUDGE).toMatch(/preconditions/);
  });

  it('keeps one "My call:" line, the last', () => {
    expect(oneCall('Newsletter first.\n\nMy call: **Newsletter first**.\n\nWhy: less risk.\n\nMy call: Newsletter first.')).toBe('Newsletter first.\n\nWhy: less risk.\n\nMy call: Newsletter first.');
    expect(oneCall('- **My call:** a\ntext\n**My call:** b')).toBe('text\n**My call:** b');
    expect(oneCall('No call here.')).toBe('No call here.');
  });
});

// Journey 6: the standing facts held "PIVOT REQUIRED 6/10" and the partner still said "build invoicing" three times.
describe('the partner held to a weak team verdict', () => {
  const PIVOT = { title: 'Evaluation', word: 'PIVOT REQUIRED', score: 6 };

  it('knows a weak verdict, and a call to build that does not weigh it', () => {
    expect(isWeak(PIVOT)).toBe(true);
    expect(isWeak({ title: 'E', word: 'STRONG', score: 8 })).toBe(false);
    expect(isWeak({ title: 'E', score: 5 })).toBe(true);
    expect(buildsAgainst('Runway is 3.8 months.\n\nMy call: build the invoicing form today.', PIVOT)).toBe(true);
    expect(buildsAgainst('My call: dive straight into building the client profile form.', PIVOT)).toBe(true);
    // No call line, no call: a draft or an email that says what the company is building is not advice to build.
    expect(buildsAgainst('Hi all,\n\nWe are building invoicing and will ship it next week.', PIVOT)).toBe(false);
    for (const reply of ['My call: do not build yet; call the three users.', 'The PIVOT verdict says pause. My call: build nothing this week.', 'Given the team\'s verdict, my call: pause coding and run 10 interviews.', 'My call: talk to the three users today.'])
      expect(buildsAgainst(reply, PIVOT), reply).toBe(false);
  });

  it('asks once more with the verdict quoted, and labels a second miss', async () => {
    const nudges: string[] = [];
    const again = async (_first: TurnResult, nudge?: string) => { nudges.push(nudge ?? ''); return turn('Still: ship it.\n\nMy call: build the form.'); };
    const held = await holdPartner('what do I do now?', turn('My call: build the invoicing form today.'), again, PIVOT);
    expect(nudges).toEqual(['The team\'s verdict is PIVOT REQUIRED 6/10 (Evaluation); answer in its light or say why you overrule it. Name the verdict in your reply.']);
    expect(held.text).toBe(`Still: ship it.\n\nMy call: build the form.\n\n${UNWEIGHED}`);
    const weighed = await holdPartner('what do I do now?', turn('My call: build the form.'), async () => turn('The PIVOT REQUIRED verdict comes first. My call: run the interviews.'), PIVOT);
    expect(weighed.text).toBe('The PIVOT REQUIRED verdict comes first. My call: run the interviews.');
    // No weak verdict, or one already weighed: nothing is asked again.
    let asked = 0;
    await holdPartner('what now?', turn('My call: build the form.'), async () => { asked += 1; return turn('x'); }, { title: 'E', word: 'STRONG', score: 8 });
    await holdPartner('what now?', turn('My call: build the form.'), async () => { asked += 1; return turn('x'); }, null);
    expect(asked).toBe(0);
  });

  it('never asks again about something written for customers', async () => {
    let asked = 0;
    const email = 'Hi all, we are building PDF invoicing.\n\nMy call: send this and ship invoicing on Friday.';
    const held = await holdPartner('Draft a short update for our 3 beta users about what we are building', turn(email), async () => { asked += 1; return turn('x'); }, PIVOT);
    expect(asked).toBe(0);
    expect(held.text).toBe(email);
  });

  it('takes one second look per turn: a raise answer asked again that still builds against the verdict is only labelled', async () => {
    let asked = 0;
    const held = await holdPartner(JOURNEY, turn('Phase 1: SAFE.\n\nMy call: go.'), async () => { asked += 1; return turn('Not yet: no users. My call: build the product first.'); }, PIVOT);
    expect(asked).toBe(1);
    expect(held.text).toBe(`Not yet: no users. My call: build the product first.\n\n${UNWEIGHED}`);
  });
});

// Journey 6: "Before any plan to raise money, hire, spend or pivot, we must check its preconditions against the Company
// document and chat." in the raise, hire and price replies.
describe('the partner\'s rules are not said back', () => {
  it('takes out a sentence that is a near copy of the stance or the preconditions rule, and keeps the rest', () => {
    const reply = 'Not yet. Before any plan to raise money, hire, spend or pivot, we must check its preconditions against the Company document and chat. You have 3.8 months of runway.\n\n- Before any plan to raise money, hire, spend or pivot, list its preconditions and check each against the Company document and the chat.\n- MRR over $10k\n\nMy call: wait.';
    expect(stripStance(reply)).toBe('Not yet. You have 3.8 months of runway.\n\n- MRR over $10k\n\nMy call: wait.');
    // Journey 7: "Never round this upward." under the runway answer.
    expect(stripStance('Your runway is **3.8 months** (€4,200 cash divided by an €1,100/month burn). Never round this upward.')).toBe('Your runway is **3.8 months** (€4,200 cash divided by an €1,100/month burn).');
    expect(stripStance('Runway is 3.8 months, never rounded up.\n\nNever round it toward the better side.\n\nMy call: cut burn.')).toBe('Runway is 3.8 months, never rounded up.\n\nMy call: cut burn.');
    // A short rule said back word for word goes too.
    expect(stripStance('Be concise. My call: talk to users.')).toBe('My call: talk to users.');
    const own = 'Raise when you can show investors a month of retention and ten paying users who stayed, not before.';
    expect(stripStance(own)).toBe(own);
  });
});
