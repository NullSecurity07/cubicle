import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApprovals, putToFounder } from '../approvals.ts';
import { standingBlock } from './standing.ts';
import { citedFacts, standingFacts } from './synthesis.ts';
import { chatNo, checkAgainst, createSaidNo, overlap, proposalOf, promptLine, sameProposal, SAID_NO_MOST, suggestionIn, type SaidNoEntry } from './saidno.ts';

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

  it('takes an email by its lead whatever the subject, and the same subject to another address as another email', () => {
    const declined = { ...proposalOf('draft_email', { to: 'ana@acme.io', subject: 'Quick intro' }, ['ana@acme.io'])!, at: OCT_3, id: 'x', asked: 0 } as SaidNoEntry;
    expect(declined.key).toBe('lead:ana@acme.io');
    expect(sameProposal(declined, proposalOf('send_email', { to: 'Ana@acme.io', subject: 'Following up on pricing' }, ['ana@acme.io'])!)).toBe(true);
    const plain = { ...proposalOf('send_email', { to: 'bob@x.io', subject: 'Launch day' })!, at: OCT_3, id: 'y', asked: 0 } as SaidNoEntry;
    expect(sameProposal(plain, proposalOf('send_email', { to: 'eve@x.io', subject: 'Launch day' })!)).toBe(false);
    expect(sameProposal(plain, proposalOf('draft_email', { to: 'bob@x.io', subject: 'Launch day!' })!)).toBe(true);
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
