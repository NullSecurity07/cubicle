import { describe, expect, it } from 'vitest';
import type { TurnResult } from '../loop.ts';
import { asksCommitment, checksPreconditions, holdPartner, oneCall, PRECONDITION_NUDGE, UNCHECKED } from './pushback.ts';

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
