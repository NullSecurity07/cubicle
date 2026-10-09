import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApprovals, putToFounder } from '../approvals.ts';
import { standingBlock } from './standing.ts';
import { citedFacts, standingFacts } from './synthesis.ts';
import { saidNoProposal } from './watch.ts';
import { againstNo, answerNos, asksSaidNo, effectsOf, holdWaiting, recallNos, chatNo, checkAgainst, createSaidNo, ruledOutBy, ruledOutLine, standingNosIn, overlap, proposalOf, promptLine, sameProposal, SAID_NO_MOST, suggestionIn, type SaidNoEntry } from './saidno.ts';

const DAY = 86_400_000;
const OCT_3 = Date.UTC(2026, 9, 3, 12);
const entry = (over: Partial<SaidNoEntry> = {}): SaidNoEntry => ({ id: 'no-1', tool: 'propose_bet', subject: 'Cut the price to €29', at: OCT_3, asked: 0, reason: 'too early', who: 'Maya', ...over });

describe('the said-no match', () => {
  it('holds the same tool and most of the same words, and lets another kind of tool or another subject through', () => {
    expect(overlap('Cut the price to €29', 'cut price to 29 euros')).toBeGreaterThanOrEqual(0.6);
    expect(sameProposal(entry(), { tool: 'propose_bet', subject: 'Cut price to 29' })).toBe(true);
    expect(sameProposal(entry(), { tool: 'propose_bet', subject: 'Run a LinkedIn ad test' })).toBe(false);
    expect(sameProposal(entry(), { tool: 'propose_decision', subject: 'Cut the price to €29' })).toBe(false);
    // A no said in chat stands against any tool.
    expect(sameProposal(entry({ tool: 'chat' }), { tool: 'propose_decision', subject: 'Cut the price to 29' })).toBe(true);
  });

  it('takes an email as the same only to the same lead and about much the same thing', () => {
    const declined = { ...proposalOf('draft_email', { to: 'ana@acme.io', subject: 'Quick intro' }, ['ana@acme.io'])!, at: OCT_3, id: 'x', asked: 0 } as SaidNoEntry;
    expect(declined.key).toBe('lead:ana@acme.io');
    expect(sameProposal(declined, proposalOf('send_email', { to: 'Ana@acme.io', subject: 'Following up on pricing' }, ['ana@acme.io'])!)).toBe(false);
    expect(sameProposal(declined, proposalOf('send_email', { to: 'Ana@acme.io', subject: 'Quick intro!' }, ['ana@acme.io'])!)).toBe(true);
    expect(sameProposal(declined, proposalOf('send_email', { to: 'bo@acme.io', subject: 'Quick intro' }, ['bo@acme.io'])!)).toBe(false);
    const plain = { ...proposalOf('send_email', { to: 'bob@x.io', subject: 'Launch day' })!, at: OCT_3, id: 'y', asked: 0 } as SaidNoEntry;
    expect(sameProposal(plain, proposalOf('send_email', { to: 'eve@x.io', subject: 'Launch day' })!)).toBe(false);
    expect(sameProposal(plain, proposalOf('draft_email', { to: 'bob@x.io', subject: 'Launch day!' })!)).toBe(true);
  });

  it("a Don't on an intro email to a lead leaves a follow-up about a meeting fresh, and the same intro is asked again", () => {
    const leads = ['mira@fablab.example'];
    const intro = { ...proposalOf('draft_email', { to: 'mira@fablab.example', subject: 'Intro: PrintNear for FabLab members' }, leads)!, at: OCT_3, id: 'm', asked: 0 } as SaidNoEntry;
    const meeting = proposalOf('draft_email', { to: 'mira@fablab.example', subject: 'Follow-up about our meeting next week' }, leads)!;
    expect(checkAgainst([intro], meeting, OCT_3 + DAY).verdict).toBe('fresh');
    const again = proposalOf('draft_email', { to: 'mira@fablab.example', subject: 'Intro: PrintNear for FabLab members' }, leads)!;
    expect(checkAgainst([intro], again, OCT_3 + DAY)).toMatchObject({ verdict: 'reask' });
    expect(promptLine([intro])).toContain('email to mira@fablab.example about "Intro: PrintNear for FabLab members"');
  });

  it("a Don't on a watch proposal holds that proposal, not every email to the lead", () => {
    const watched = saidNoProposal({ move: 'reply', draft: { kind: 'email', to: 'Mira@fablab.example', subject: 'Re: a 20-minute call about PrintNear', body: 'Would a call work?' } });
    const held = { ...watched, at: OCT_3, id: 'w', asked: 0 } as SaidNoEntry;
    const answer = proposalOf('draft_email', { to: 'mira@fablab.example', subject: 'How pickup works and one trial job' }, ['mira@fablab.example'])!;
    expect(checkAgainst([held], answer, OCT_3 + DAY).verdict).toBe('fresh');
    expect(checkAgainst([held], saidNoProposal({ move: 'reply', draft: { kind: 'email', to: 'mira@fablab.example', subject: 'Re: a 20-minute call about PrintNear', body: '' } }), OCT_3 + DAY).verdict).toBe('reask');
  });

  it('is fresh, then asked again once with the no quoted, then declined, and only inside fourteen days', () => {
    const proposal = { tool: 'propose_bet', subject: 'Cut price to €29' };
    expect(checkAgainst([], proposal, OCT_3).verdict).toBe('fresh');
    const again = checkAgainst([entry()], proposal, OCT_3 + DAY);
    expect(again).toMatchObject({ verdict: 'reask', line: "You said no to this on 3 Oct: 'too early'. Ask again?" });
    const third = checkAgainst([entry({ asked: 1 })], proposal, OCT_3 + DAY);
    expect(third.verdict).toBe('declined');
    if (third.verdict === 'declined') expect(third.line).toMatch(/^Already declined: the founder said no to "Cut the price to €29" on 3 Oct \('too early'\)/);
    expect(checkAgainst([entry({ asked: 1 })], proposal, OCT_3 + 15 * DAY).verdict).toBe('fresh');
  });
});

describe('the said-no log', () => {
  it('keeps a no said twice as one, with its count of asks, the newest reason, and forgets it on a yes', async () => {
    let now = OCT_3;
    const book = createSaidNo(await mkdtemp(join(tmpdir(), 'saidno-')), () => now);
    const first = await book.record({ tool: 'propose_bet', subject: 'Cut the price to €29', who: 'Maya', reason: 'too early' });
    expect((await book.check({ tool: 'propose_bet', subject: 'cut price to 29' })).verdict).toBe('reask');
    await book.asked(first.id);
    now += DAY;
    await book.record({ tool: 'propose_bet', subject: 'Cut price to €29' });
    const list = await book.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ asked: 1, reason: 'too early', at: now });
    expect((await book.check({ tool: 'propose_bet', subject: 'cut price to 29' })).verdict).toBe('declined');
    await book.forget({ tool: 'propose_bet', subject: 'cut the price to 29' });
    expect(await book.list()).toEqual([]);
  });

  it('keeps the last fifty, newest first, in said-no.json, and shows ten', async () => {
    let now = OCT_3;
    const dir = await mkdtemp(join(tmpdir(), 'saidno-'));
    const book = createSaidNo(dir, () => now);
    for (let at = 0; at < 60; at += 1) { now += 1000; await book.record({ tool: 'run_code', subject: `script ${at}01 ${at}02` }); }
    const saved = JSON.parse(await readFile(join(dir, 'said-no.json'), 'utf8')).entries as SaidNoEntry[];
    expect(saved).toHaveLength(SAID_NO_MOST);
    expect(saved[0].subject).toBe('script 5901 5902');
    expect(await book.lines()).toHaveLength(10);
    expect(promptLine(await book.list())).toMatch(/^The founder said no to:\n- "script 5901 5902" \(3 Oct\)/);
  });
});

describe('a no heard', () => {
  it('reads a chat reply that turns a proposal down, with its reason, and not "no problem" or "not sure"', () => {
    expect(chatNo('No, too early for a price cut')).toEqual({ reason: 'too early for a price cut' });
    expect(chatNo("Don't. We keep €39")).toEqual({ reason: "Don't. We keep €39" });
    expect(chatNo('no')).toEqual({});
    expect(chatNo('No problem, go ahead')).toBeNull();
    expect(chatNo('not sure yet')).toBeNull();
    expect(chatNo('Yes, do it')).toBeNull();
    expect(suggestionIn('Numbers look thin. I suggest we cut the price to €29 for a month. Thoughts?')).toBe('I suggest we cut the price to €29 for a month.');
  });

  it('hears the founder answer an approval, with what it was to, and never a stopped turn', async () => {
    const approvals = createApprovals();
    const heard: [string, boolean][] = [];
    approvals.founderAnswers((about, answer) => heard.push([about.event!.name, answer.ok]));
    const book = { raise: async () => {}, clear: async () => {} };
    const asking = await putToFounder(book, approvals, { id: 'approval:c1', kind: 'approval', title: 'Send this email?', at: 1, event: { id: 'c1', name: 'send_email', args: {} } });
    approvals.answer('c1', { ok: false, args: { reason: 'too early' } }, 'founder');
    expect((await asking.answer).ok).toBe(false);
    const stopped = new AbortController();
    const other = await putToFounder(book, approvals, { id: 'approval:c2', kind: 'approval', title: 'Run?', at: 1, event: { id: 'c2', name: 'run_code', args: {} } }, stopped.signal);
    stopped.abort();
    await other.answer;
    approvals.answer('c3', { ok: false });
    expect(heard).toEqual([['send_email', false]]);
  });
});

describe('said no in the standing facts', () => {
  it('lists what the founder said no to, and counts an answer that names one as a standing fact', () => {
    const line = '- "Cut the price to €29" (Maya, 3 Oct: too early)';
    const block = standingBlock({ verdicts: [], numbers: '', open: [], planned: [], flagCounts: [], decided: [], learned: [], declined: [line] }, []);
    expect(block).toContain(`The founder said no to (never put one to them again as new):\n${line}`);
    const facts = standingFacts({ verdicts: [], numbers: '', open: [], planned: [], flagCounts: [], decided: [], learned: [], declined: [line] });
    expect(citedFacts('You said no to the €29 cut last week, so keep the price and chase the three pilots.', facts).map((fact) => fact.kind)).toEqual(['declined']);
  });
});

// Journey 15: "Don't propose cold outreach to more makers this week" kept nothing, and the refresh and the next
// morning's note proposed contacting more makers.
describe('a standing no said in chat', () => {
  it('reads what the founder rules out and why, without the time it was said for', () => {
    expect(standingNosIn('No to the task of contacting 10 more makers, because we are at 9 jobs and the last one comes from a host. Don\'t propose cold outreach to more makers this week.')).toEqual([
      { subject: 'contacting 10 more makers', reason: 'we are at 9 jobs and the last one comes from a host' },
      { subject: 'cold outreach to more makers', reason: 'we are at 9 jobs and the last one comes from a host' },
    ]);
    expect(standingNosIn('No more discounts.')).toEqual([{ subject: 'discounts' }]);
    expect(standingNosIn('Sounds good, go ahead.')).toEqual([]);
    expect(standingNosIn('No problem, do it.')).toEqual([]);
  });

  it('keeps "No X, because Y", "Never X", "Don\'t X" and "Stop X" at the head of a sentence, and lets small talk through', () => {
    // Journey 17: answered "I have recorded that rule" with nothing kept.
    expect(standingNosIn('No cold outreach to nurses we have not met, because nurses hate it.')).toEqual([
      { subject: 'cold outreach to nurses we have not met', reason: 'nurses hate it' },
    ]);
    expect(standingNosIn('Never claim allergen safety.')).toEqual([{ subject: 'claim allergen safety' }]);
    expect(standingNosIn("Don't email Anna again.")).toEqual([{ subject: 'email Anna' }]);
    expect(standingNosIn('Stop discounting to win nurses back, since it cheapens us.')).toEqual([
      { subject: 'discounting to win nurses back', reason: 'it cheapens us' },
    ]);
    for (const talk of ['No, too early.', 'No worries.', "Don't worry about it.", 'No idea.', 'Never mind.', 'No cold outreach this week?', 'Stop.', 'No.'])
      expect(standingNosIn(talk)).toEqual([]);
  });

  it('holds a move against it by the no\'s own words, and lets a move that keeps to it through', () => {
    const no = 'cold outreach to more makers';
    expect(againstNo(no, 'Contact 40 more local makers to secure the remaining 6 print jobs.')).toBe(true);
    expect(againstNo(no, 'Reach out to 10 more makers today.')).toBe(true);
    expect(againstNo(no, 'Close that final print job without cold outreach to makers.')).toBe(false);
    expect(againstNo(no, 'Update the Company brief from 4 to 9 jobs.')).toBe(false);
    expect(againstNo(no, 'Email Mira the pickup answer.')).toBe(false);
  });

  it('finds the no a move breaks inside the window and says it as the founder ruled it out', () => {
    const entry = { id: 'n', tool: 'chat', subject: 'cold outreach to more makers', at: OCT_3, asked: 0, reason: 'we are at 9 jobs' } as SaidNoEntry;
    expect(ruledOutBy([entry], 'Contact 40 more local makers', OCT_3 + DAY)).toBe(entry);
    expect(ruledOutBy([entry], 'Contact 40 more local makers', OCT_3 + 15 * DAY)).toBeUndefined();
    expect(ruledOutLine(entry)).toBe("You ruled out cold outreach to more makers on 3 Oct ('we are at 9 jobs')");
  });

  it('gives a reason said just after a Don\'t to the no that had none', async () => {
    let clock = OCT_3;
    const book = createSaidNo(await mkdtemp(join(tmpdir(), 'saidno-why-')), () => clock);
    await book.record({ tool: 'propose_task', subject: 'Reply to Mira proposing a 20-minute call' });
    clock += 60_000;
    expect(await book.explain('she asked how pickup works')).toMatchObject({ reason: 'she asked how pickup works' });
    clock += 60 * 60_000;
    await book.record({ tool: 'propose_task', subject: 'Contact more makers' });
    clock += 20 * 60_000;
    expect(await book.explain('too late')).toBeNull();
  });
});

describe('a decision said no to (journey 18)', () => {
  const first = proposalOf('propose_decision', {
    title: 'Give a free month for referring two other plumbers',
    options: ['Give one free month to any plumber who refers two others', 'No referral reward for now'],
    recommendation: 'Give one free month for two referrals: referrals are the cheapest way to new plumbers',
  })!;
  const second = proposalOf('propose_decision', {
    title: 'Free month for plumbers who refer two others',
    options: ['A free month per two referred plumbers', 'Wait'],
    recommendation: 'Offer the free month for two referrals',
  })!;
  const third = proposalOf('propose_decision', {
    title: 'Referral program with a free month for two referrals',
    options: ['Launch the referral program now', 'Hold it until 15 paying'],
    recommendation: 'Launch it: a free month for every two referrals brings plumbers in cheaply',
  })!;

  it('holds the same offer under any of the three titles the journey saw, by its options and effect', () => {
    const declined = { ...first, at: OCT_3, id: 'd', asked: 1, reason: 'no free months: plumbers who join for a free month leave when it ends' } as SaidNoEntry;
    expect(sameProposal(declined, second)).toBe(true);
    expect(sameProposal(declined, third)).toBe(true);
    expect(checkAgainst([declined], third, OCT_3 + DAY).verdict).toBe('declined');
    // Another kind of move is another decision.
    expect(sameProposal(declined, proposalOf('propose_decision', { title: 'Raise the price to €39', options: ['Raise now', 'Wait a month'] })!)).toBe(false);
    expect(sameProposal(declined, proposalOf('propose_decision', { title: '20% discount for trial user conversion', options: ['Offer 20% off the first month', 'No discount'] })!)).toBe(false);
  });

  it('holds a decision against an old no kept by title alone too, by its effect and words', () => {
    const declined = { tool: 'propose_decision', subject: 'Give a free month to any plumber who refers two others', at: OCT_3, id: 'd', asked: 1 } as SaidNoEntry;
    expect(sameProposal(declined, third)).toBe(true);
  });

  it('holds a "20% discount" decision against the standing no on discounts, and keeps a decision that does without', () => {
    const no = { id: 'n', tool: 'chat', subject: 'discounts', reason: 'it trains customers to wait', at: OCT_3, asked: 0 } as SaidNoEntry;
    const discount = proposalOf('propose_decision', { title: '20% discount for trial user conversion', options: ['Offer 20% off the first month', 'Convert without a discount'], recommendation: 'Convert trial users without discounts' })!;
    expect(sameProposal(no, discount)).toBe(true);
    expect(checkAgainst([no], discount, OCT_3 + DAY).verdict).toBe('reask');
    expect(sameProposal(no, proposalOf('propose_decision', { title: 'Give trial users 15% off the first month', options: ['Yes', 'No'] })!)).toBe(true);
    expect(sameProposal(no, proposalOf('propose_decision', { title: 'Call the 22 trial users this week', options: ['Call all', 'Call five'] })!)).toBe(false);
    const trials = { ...no, subject: 'count the trials as customers' };
    expect(sameProposal(trials, discount)).toBe(false);
  });
});

// Journey 19: Don't on Sam's ready reply to Tom, then "No to that reply for Tom, because ... Never promise a feature we
// have not shipped." Lea's honest answer later reused the subject and the gate said "You said no to this".
describe('a no on a drafted email', () => {
  const tom = 'tom@becker-sanitaer.example';
  const subject = 'Re: QuoteSnap / WhatsApp to quotes for Becker Sanitär';
  const sams = 'Hi Tom,\n\nThanks for your questions. Yes, QuoteSnap works with photos from any Android phone. And yes, your quotes can show VAT separately.\n\nBest,';
  const leas = 'Hi Tom,\n\nThanks for your questions. QuoteSnap turns WhatsApp photos of a job into a written quote in your own template.\nI will check whether it works with photos from your old Android phone and come back to you by Tuesday. I will check whether the quote can show VAT separately and come back to you by Tuesday.\n\nBest,';

  it('keeps the draft, its id and its claims, and holds a later draft only when it is the same or makes the same claims', async () => {
    const book = createSaidNo(await mkdtemp(join(tmpdir(), 'saidno-')), () => OCT_3);
    const declined = saidNoProposal({ id: 'lead-1', move: 'Reply to Tom', draft: { kind: 'email', to: tom, subject, body: sams } });
    const kept = await book.record({ ...declined, who: 'Sam' });
    expect(kept).toMatchObject({ draftId: 'lead-1', claims: expect.arrayContaining(['Android']) });
    expect(kept.body).toContain('any Android phone');
    expect(await book.explain('to that reply for Tom, because never promise a feature we have not shipped')).toMatchObject({ id: kept.id });
    // Lea's honest answer, same lead, same subject: fresh.
    expect((await book.check(proposalOf('draft_email', { to: tom, subject, body: leas }, [tom])!)).verdict).toBe('fresh');
    // The same claims again under another subject: the same no.
    expect((await book.check(proposalOf('draft_email', { to: tom, subject: 'Quick answer', body: 'Hi Tom,\n\nGood news: it runs on Android phones of any age.\n\nBest,' }, [tom])!)).verdict).toBe('reask');
    // The same draft again: the same no.
    expect((await book.check(saidNoProposal({ id: 'lead-1', move: 'Reply', draft: { kind: 'email', to: tom, subject, body: sams } }))).verdict).not.toBe('fresh');
  });

  it('a draft with no product claims is held only by its id or by much the same words', () => {
    const plain = 'Hi Tom,\n\nThanks for your reply. Would a 20-minute call this week work for you to see a quote made from your photos?\n\nBest,';
    const no = entry({ tool: 'draft_email', subject, to: tom, key: `lead:${tom}`, draftId: 'lead-2', body: 'Hi Tom,\n\nThanks for your reply. We would love to show you a quote made from your own job photos this week.\n\nBest,', claims: [] });
    expect(sameProposal(no, proposalOf('draft_email', { to: tom, subject, body: leas }, [tom])!)).toBe(false);
    expect(sameProposal(no, proposalOf('draft_email', { to: tom, subject, body: plain }, [tom])!)).toBe(false);
    expect(sameProposal(no, proposalOf('draft_email', { to: tom, subject: 'Other', body: no.body }, [tom])!)).toBe(true);
    // An older no kept without a body still stands by its subject.
    expect(sameProposal(entry({ tool: 'draft_email', subject, to: tom, key: `lead:${tom}` }), proposalOf('draft_email', { to: tom, subject, body: leas }, [tom])!)).toBe(true);
  });
});

// Journey 19: "what have I said no to" recalled two of five.
describe('what the founder said no to, recalled from the record', () => {
  it('hears the question and lists every no of the last thirty days, newest first', async () => {
    let clock = OCT_3;
    const book = createSaidNo(await mkdtemp(join(tmpdir(), 'saidno-')), () => clock);
    await book.record({ tool: 'draft_email', subject: 'Re: QuoteSnap / WhatsApp to quotes', to: 'tom@becker.example', who: 'Sam', reason: 'never promise a feature we have not shipped' });
    clock += 1000; await book.record({ tool: 'chat', subject: 'promise a feature we have not shipped', who: 'Sam' });
    clock += 1000; await book.record({ tool: 'chat', subject: 'count the trials as customers', who: 'Sam' });
    clock += 1000; await book.record({ tool: 'propose_decision', subject: 'Give trial users a free month', who: 'Sam', reason: 'no free months' });
    clock += 1000; await book.record({ tool: 'chat', subject: 'discounts', who: 'Sam', reason: 'it trains customers to wait' });
    clock -= 40 * DAY; await book.record({ tool: 'chat', subject: 'paid ads', who: 'Sam' });
    for (const ask of ['What have I said no to?', 'which things did I say no to so far', 'Remind me what I have declined', 'List my nos']) expect(asksSaidNo(ask)).toBe(true);
    for (const ask of ['No, too early', 'What did the lead say?', 'Should I say no to Tom?']) expect(asksSaidNo(ask)).toBe(false);
    const recall = recallNos(await book.list(), OCT_3 + DAY);
    expect(recall.split('\n')).toHaveLength(6);
    expect(recall).toContain('(5)');
    for (const one of ['discounts', 'free month', 'count the trials as customers', 'promise a feature we have not shipped', 'email to tom@becker.example']) expect(recall).toContain(one);
    expect(recall).not.toContain('paid ads');
    expect(answerNos('You said no to discounts and free months.', 'What have I said no to?', recall)).toBe(recall);
    expect(answerNos('The kill line is below 11.', 'What is the kill line now, and what have I said no to?', recall)).toBe(`The kill line is below 11.\n\n${recall}`);
  });
});

// Journey 21: declined in the panel, re-asked ("already proposed and waiting"), then retitled as two months at no charge.
describe('a decision declined in the panel and asked again', () => {
  const declined = { id: 'd', tool: 'propose_decision', subject: 'First Three Months Free for New Cafés', options: ['Give new cafés their first three months free', 'Keep the full price from day one'], pick: 'Give the first three months free to grow from 6 to 12', reason: 'cafés that join for free leave when the free months end', at: OCT_3, asked: 0 } as SaidNoEntry;
  it('holds the retitle that gives months at no charge for a referral', () => {
    const retitle = proposalOf('propose_decision', { title: 'Café Referral Incentive', options: ['A café gets two months at no charge if it brings in another café', 'No referral reward'], recommendation: 'Two months at no charge for each café brought in' })!;
    expect(effectsOf('A café gets two months at no charge if it brings in another café')).toEqual(new Set(['free', 'referral']));
    expect(sameProposal(declined, retitle)).toBe(true);
    expect(sameProposal(declined, proposalOf('propose_decision', { title: 'Referral reward', options: ['A €10 credit for each café brought in', 'Wait'] })!)).toBe(false);
  });
  it('says the no, never "waiting", when no such decision waits or the proposal was held', () => {
    const reply = 'The decision "First Three Months Free for New Cafés" is already proposed and waiting in your list. Anything else?';
    expect(holdWaiting(reply, [], [declined], [])).toBe('You declined "First Three Months Free for New Cafés" on 3 Oct (\'cafés that join for free leave when the free months end\'), so it is not waiting in your list. Say so if something has changed and you want it back. Anything else?');
    expect(holdWaiting(reply, ['First Three Months Free for New Cafés'], [declined], [])).toBe(reply);
    expect(holdWaiting('I have proposed "Café Referral Incentive"; it now waits in your list.', [], [declined], [declined])).toContain('was not put to you again');
    expect(holdWaiting('The task "Call Ines" waits in your list.', [], [], [])).toBe('The task "Call Ines" waits in your list.');
  });
});
