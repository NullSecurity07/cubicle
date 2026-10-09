import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChatMessage, Stage } from '../../shared/model.ts';
import { morningText, type Bet } from '../../shared/partner.ts';
import type { ModelMessage } from '../prompt.ts';
import type { FounderPromise } from './promises.ts';
import { saidNoFor } from './saidno.ts';
import { stateOf } from './economics.ts';
import { NOTHING_CHANGED } from './since.ts';
import { attributed, briefMoves, confirmedFix, gatherMorning, MORNING_ASK, morningDue, morningInputs, morningMessage, MOST_TRIES, reachedFlags, RETRY_AFTER, writeMorning, type MorningSources } from './morning.ts';

const at = (text: string) => new Date(text).getTime();
const NINE = at('2026-09-27T09:00');

describe('when the morning note is due', () => {
  it('comes once a day, not before six, not on the day the partner arrived, and tries again after a wait', () => {
    const since = { partnerSince: '2026-09-26' };
    expect(morningDue(since, NINE)).toBe(true);
    expect(morningDue({}, NINE)).toBe(false);
    expect(morningDue({ partnerSince: '2026-09-27' }, NINE)).toBe(false);
    expect(morningDue(since, at('2026-09-27T05:59'))).toBe(false);
    expect(morningDue({ ...since, morning: { day: '2026-09-27' } as never }, NINE)).toBe(false);
    expect(morningDue({ ...since, morning: { day: '2026-09-26' } as never }, NINE)).toBe(true);
    expect(morningDue({ ...since, tries: { day: '2026-09-27', count: 1, last: NINE } }, NINE + RETRY_AFTER - 1)).toBe(false);
    expect(morningDue({ ...since, tries: { day: '2026-09-27', count: 1, last: NINE } }, NINE + RETRY_AFTER)).toBe(true);
    expect(morningDue({ ...since, tries: { day: '2026-09-27', count: MOST_TRIES, last: NINE } }, NINE + 5 * RETRY_AFTER)).toBe(false);
    expect(morningDue({ ...since, tries: { day: '2026-09-26', count: MOST_TRIES, last: NINE } }, NINE)).toBe(true);
  });
});

async function sources(extra: Partial<MorningSources> = {}): Promise<MorningSources> {
  const stage: Stage = {
    rooms: [{ id: 'p1', name: 'Sam', role: 'Partner', accent: '#fff', brief: '', partner: true, x: 0, y: 0, w: 1, h: 1 }, { id: 'm', name: 'Maya', role: 'Marketing', accent: '#fff', brief: '', x: 0, y: 0, w: 1, h: 1 }],
    docs: [], wires: [], cards: [{ id: 'leads-1', kind: 'leads', x: 0, y: 0, w: 1, h: 1 }],
  };
  const chats: Record<string, ChatMessage[]> = {
    m: [
      { id: '1', role: 'user', text: 'old talk from last week', at: at('2026-09-20T10:00') },
      { id: '2', role: 'user', text: 'Price it at $9?', at: at('2026-09-26T15:00') },
      { id: '3', role: 'assistant', text: 'Yes, $9 for the pre-order.', at: at('2026-09-26T15:01') },
    ],
  };
  const bets: Bet[] = [
    { id: 'b1', made: '2026-09-20', what: 'Post in r/SaaS', hypothesis: 'founders sign up', metric: 'signups', target: 20, checkDate: '2026-10-03', status: 'open', at: 1 },
    { id: 'b2', made: '2026-09-01', what: 'Cold email 30', hypothesis: '', metric: 'leads:replied', target: 5, checkDate: '2026-09-20', status: 'closed', at: 1, result: { at: 2, verdict: 'did-not', value: 1, note: '', by: 'Founder' } },
    { id: 'b3', made: '2026-09-26', what: 'Proposed only', hypothesis: '', metric: 'x', target: 1, checkDate: '2026-10-01', status: 'proposed', at: 1 },
  ];
  return {
    workspace: await mkdtemp(join(tmpdir(), 'morning-')), stage, partnerId: 'p1', now: NINE,
    decisions: async () => [{ id: 'd1', title: 'Newsletter first', status: 'decided', at: at('2026-09-26T11:00'), decidedAt: at('2026-09-26T11:00'), context: '', options: [], chosen: 'Weekly newsletter' }],
    boards: async () => [], leads: async () => [], chat: async (roomId) => chats[roomId] ?? [], bets: async () => bets,
    ...extra,
  };
}

describe('what the partner reads in the morning', () => {
  it('holds yesterday\'s decisions, cards, talk and the bets on record, and nothing older', async () => {
    const text = await gatherMorning(await sources());
    expect(text).toContain('What changed from 2026-09-26 to 2026-09-27');
    expect(text).toContain('- 2026-09-26 Newsletter first: Weekly newsletter');
    expect(text).toContain('Leads [Leads]: 0 added');
    expect(text).toContain('Not on the stage: Metrics, Runway, Board.');
    expect(text).toContain('Maya (Marketing):\n  Founder: Price it at $9?\n  Maya: Yes, $9 for the pre-order.');
    expect(text).not.toContain('old talk');
    expect(text).toContain('- Open: Post in r/SaaS. Bet: founders sign up. Measured by "signups" on the Metrics card: 20 by 2026-10-03.');
    expect(text).toContain('- Closed 2026-09-20: Cold email 30. Did not work; "leads:replied" was 1 against 5.');
    expect(text).toContain('What we learned (closed bets):\n- 2026-09-20: Cold email 30 did not work; "leads:replied" was 1 against 5.');
    expect(text).not.toContain('Proposed only');
  });
});

// The journey's morning: a plan on the board, a WEAK verdict and an unsurvivable flaw beside it on the stage, and a
// colleague's figure the truth net flagged. The note copied plan steps 1-3 and said nothing of the rest.
const EVALUATION = '# Evaluation\n\n## 2. Death hunt\n\nSupply is the flaw nobody survives: 0 sellers signed.\n\n## 5. Verdict\n\nVerdict: WEAK\nScore: 4/10\nSupply decides it; the newsletter alone is a vitamin.\n';
const COMPANY = '# Company\n\n## Idea\n\nA weekly list of abandoned SaaS.\n\n## Numbers\n\nPrice: $9/month.\nRunway: $8,000.\n\n## Bets\n\n- Open: newsletter.\n';
async function acrossRooms(): Promise<MorningSources> {
  const base = await sources();
  const stage: Stage = {
    ...base.stage,
    rooms: [...base.stage.rooms, { id: 'dev', name: 'Dev', role: 'Build', accent: '#fff', brief: '', x: 0, y: 0, w: 1, h: 1 }],
    docs: [
      { id: 'eval', title: 'Evaluation', x: 0, y: 0, w: 1, h: 1, rules: { framework: 'startup-evaluation', sections: [{ heading: '2. Death hunt', by: 'hunter' }], verdict: { heading: '5. Verdict', by: 'judge' }, outcomes: ['PIVOT REQUIRED', 'WEAK', 'STRONG'] } },
      { id: 'empty-eval', title: 'Second evaluation', x: 0, y: 0, w: 1, h: 1, rules: { framework: 'startup-evaluation', sections: [], verdict: { heading: '5. Verdict', by: 'judge' }, outcomes: ['WEAK', 'STRONG'] } },
      { id: 'held-eval', title: 'Third evaluation', x: 0, y: 0, w: 1, h: 1, rules: { framework: 'startup-evaluation', sections: [], verdict: { heading: '5. Verdict', by: 'judge' }, outcomes: ['WEAK', 'STRONG'] } },
    ],
    cards: [...(base.stage.cards ?? []), { id: 'board-1', kind: 'board', x: 0, y: 0, w: 1, h: 1 }],
  };
  const docs: Record<string, string> = { eval: EVALUATION, 'empty-eval': '# Second evaluation\n\n## 5. Verdict\n\n',
    'held-eval': '# Third evaluation\n\n## 5. Verdict\n\nNot assessed: 4. Founder-market fit (Rohan has not written it yet)\n\nNo verdict and no score until this section is written.\n' };
  const dev: ChatMessage[] = [
    { id: 'd1', role: 'user', text: 'What is our runway?', at: at('2026-09-26T16:00') },
    { id: 'd2', role: 'assistant', text: 'Runway is $48,000. WEAK, Score: 5/10.\n\nUnsourced figures: $48,000 (not found in anything this turn read).\n\nUnconfirmed: the verdict was not written; Rohan has not written "4. Founder-market fit" yet.', at: at('2026-09-26T16:01') },
    { id: 'd0', role: 'assistant', text: 'Old.\n\nUnsourced figures: $1 (not found in anything this turn read).', at: at('2026-09-20T16:01') },
  ];
  return {
    ...base, stage, company: COMPANY,
    doc: async (id) => docs[id] ?? '',
    chat: async (roomId) => (roomId === 'dev' ? dev : await base.chat(roomId)),
    boards: async () => [
      { id: 't1', title: 'Set up the landing page', column: 'todo', createdAt: 0, detail: '', due: '2026-09-27' },
      { id: 't2', title: 'Source 3 abandoned projects', column: 'todo', createdAt: 0, detail: '', due: '2026-09-30' },
    ],
  };
}

describe('the morning thinks across the rooms', () => {
  it('reads every team verdict and its score, the flags of the last day, the Company numbers, open bets and what is due', async () => {
    const text = await gatherMorning(await acrossRooms());
    expect(text).toContain('Team verdicts:');
    expect(text).toMatch(/- Evaluation, 5\. Verdict: WEAK, score 4\/10\. .*Supply decides it/);
    expect(text).toContain('- Second evaluation, 5. Verdict: not written yet.');
    // A verdict held back says why, in the doc's own words, not "not written yet".
    expect(text).toContain('- Third evaluation, 5. Verdict: not assessed: 4. Founder-market fit (Rohan has not written it yet).');
    expect(text).toContain('Company Numbers:\nPrice: $9/month.\nRunway: $8,000.');
    expect(text).toContain('Flagged by the truth net since 2026-09-26 (figures nothing backed):\nDev (Build):\nUnsourced figures: $48,000');
    expect(text).not.toContain('Unsourced figures: $1 ');
    // Every flag the truth net writes is read as one, from the net's own list.
    expect(text).toContain('Unconfirmed: the verdict was not written; Rohan has not written "4. Founder-market fit" yet.');
    expect(text).toContain('On the board for today:\n- Set up the landing page');
    expect(text).not.toContain('- Source 3 abandoned projects');
    expect(text).toContain('- Open: Post in r/SaaS.');
  });

  it('asks for the biggest contradiction across the rooms as the risk, and for no plan step copied without why today', () => {
    expect(MORNING_ASK).toContain('the biggest contradiction or risk across the rooms today');
    expect(MORNING_ASK).toMatch(/word for word/);
    expect(MORNING_ASK).toMatch(/why it is today's/);
    // A closed bet's lesson is cited, not guessed again.
    expect(MORNING_ASK).toContain('cite its What we learned line');
  });

  it('refuses a note whose risk names no room, document or number, and takes one that does', async () => {
    const prompt = async (): Promise<ModelMessage[]> => [{ role: 'system', content: 'You are Sam, Partner.' }];
    const reply = (risk: string) => `Three moves for today:\n1. Call two sellers before the landing page.\n2. Email the replied leads.\n3. Log signups.\nRisk: ${risk}\nQuestion: q?`;
    const from = await acrossRooms();
    expect(await writeMorning({ sources: from, name: 'Sam', promptFor: prompt, ask: async () => reply('execution could slip') })).toBeNull();
    for (const risk of ['The Evaluation verdict is WEAK while the plan builds the page first', 'Dev says runway is long, the Company document says otherwise', 'supply: 0 sellers signed']) {
      expect(await writeMorning({ sources: from, name: 'Sam', promptFor: prompt, ask: async () => reply(risk) }), risk).not.toBeNull();
    }
  });
});

describe('one morning turn', () => {
  const prompt = async (): Promise<ModelMessage[]> => [{ role: 'system', content: 'You are Sam, Partner.' }];

  it('asks with the partner\'s own prompt and the facts, and hands back the note in its shape', async () => {
    let heard: ModelMessage[] = [];
    const note = await writeMorning({
      sources: await sources(), name: 'Sam', promptFor: prompt,
      ask: async (messages) => { heard = messages; return 'Three things that matter today:\n1. a\n2. b\n3. c\nRisk: Maya priced it at $9\nQuestion: q?'; },
    });
    expect(note).toEqual({ things: ['a', 'b', 'c'], risk: 'Maya priced it at $9', question: 'q?', since: [], day: '2026-09-27', at: NINE, roomId: 'p1', who: 'Sam' });
    expect(heard[0].content).toBe('You are Sam, Partner.');
    expect(heard[1].content.startsWith(MORNING_ASK)).toBe(true);
    expect(heard[1].content).toContain('Newsletter first');
  });

  it('refuses a note whose three moves only restate the Company document', async () => {
    const company = '# Company brief\n\n## Idea\n\nProduct focus: weekly curated list.\n\n## Numbers\n\nCurrent stage: pre-idea validation.\n\n## Open questions\n\n- Newsletter first or marketplace first?\n';
    const restated = 'Three moves for today:\n1. Product focus: weekly curated list.\n2. **Current stage:** pre-idea validation\n3. Newsletter first or marketplace first?\nRisk: Maya priced it at $9\nQuestion: q?';
    expect(await writeMorning({ sources: { ...await sources(), company }, name: 'Sam', promptFor: prompt, ask: async () => restated })).toBeNull();
    const moves = 'Three moves for today:\n1. Email the 5 replied leads before noon.\n2. Product focus: weekly curated list.\n3. Log signups.\nRisk: Maya priced it at $9\nQuestion: q?';
    expect(await writeMorning({ sources: { ...await sources(), company }, name: 'Sam', promptFor: prompt, ask: async () => moves })).not.toBeNull();
    expect(MORNING_ASK).toContain('three moves for today: what to do, and why');
  });

  it('keys what the note reads, so a change anywhere in it asks for a new one and the partner\'s own note does not', async () => {
    const from = await sources();
    const base = { stage: from.stage, partnerId: 'p1', decisions: await from.decisions(), bets: await from.bets(), company: '# Company', chats: { m: await from.chat('m') } };
    const key = morningInputs(base);
    expect(morningInputs(base)).toBe(key);
    expect(morningInputs({ ...base, chats: { ...base.chats, p1: [{ id: 'n', role: 'assistant', text: '**Morning**', at: 99 }] } })).toBe(key);
    expect(morningInputs({ ...base, company: '# Company\n\n- more' })).not.toBe(key);
    expect(morningInputs({ ...base, decisions: [] })).not.toBe(key);
    expect(morningInputs({ ...base, chats: { m: [...base.chats.m, { id: 'z', role: 'user', text: 'new', at: 5 }] } })).not.toBe(key);
  });

  it('runs the note through the truth net: an invented figure is flagged under it, and the note still goes out', async () => {
    const note = await writeMorning({ sources: await sources(), name: 'Sam', promptFor: prompt, ask: async () => 'Three moves for today:\n1. Chase the $36,850 in pipeline.\n2. Email the replied leads.\n3. Log signups.\nRisk: Maya priced it at $9\nQuestion: q?' });
    expect(note?.flags).toEqual([expect.stringContaining('Unsourced figures: $36,850')]);
    expect(morningMessage(note!)).toMatch(/Question: q\?\n\nUnsourced figures: \$36,850/);
    const clean = await writeMorning({ sources: await sources(), name: 'Sam', promptFor: prompt, ask: async () => 'Three moves for today:\n1. Price it at $9 as decided.\n2. b\n3. c\nRisk: Maya priced it at $9\nQuestion: q?' });
    expect(clean?.flags).toBeUndefined();
  });

  it('flags "$29/month" that neither the Company document nor the chats hold, and not a price the Company document gives', async () => {
    const withCompany = async (): Promise<ModelMessage[]> => [{ role: 'system', content: 'You are Sam, Partner.\n\n## Doc: Company brief\n\n## Numbers\n\nPrice: $19/month.' }];
    const note = (price: string) => `Three moves for today:\n1. Set the price at ${price} on the landing page.\n2. Email the replied leads.\n3. Log signups.\nRisk: Maya priced it at $9\nQuestion: q?`;
    const invented = await writeMorning({ sources: await sources(), name: 'Sam', promptFor: withCompany, ask: async () => note('$29/month') });
    expect(invented?.flags).toEqual([expect.stringMatching(/^Unsourced figures: \$29/)]);
    expect(morningMessage(invented!)).toContain('Unsourced figures: $29');
    const quoted = await writeMorning({ sources: await sources(), name: 'Sam', promptFor: withCompany, ask: async () => note('$19/month') });
    expect(quoted?.flags).toBeUndefined();
  });

  it('does not take a figure in the partner\'s own brief as a source, only the documents and what was said', async () => {
    const briefed = async (): Promise<ModelMessage[]> => [{ role: 'system', content: 'You are Sam, Partner. Push the founder toward $29/month.\n\n## Doc: Company brief\n\n## Numbers\n\nPrice: $19/month.' }];
    const note = (price: string) => `Three moves for today:\n1. Set the price at ${price} on the landing page.\n2. Email the replied leads.\n3. Log signups.\nRisk: Maya priced it at $9\nQuestion: q?`;
    const invented = await writeMorning({ sources: await sources(), name: 'Sam', promptFor: briefed, ask: async () => note('$29/month') });
    expect(invented?.flags).toEqual([expect.stringMatching(/^Unsourced figures: \$29/)]);
    const quoted = await writeMorning({ sources: await sources(), name: 'Sam', promptFor: briefed, ask: async () => note('$19/month') });
    expect(quoted?.flags).toBeUndefined();
  });

  it('does not let figures flagged in one room wipe the founder\'s own words about them from the note\'s sources', async () => {
    const chats: Record<string, ChatMessage[]> = {
      m: [{ id: 'f1', role: 'user', text: 'We charge $29 and have 40 customers.', at: at('2026-09-26T15:00') }],
      p1: [],
    };
    const stage: Stage = { ...(await sources()).stage, rooms: [...(await sources()).stage.rooms, { id: 'r', name: 'Rohan', role: 'Finance', accent: '#fff', brief: '', x: 0, y: 0, w: 1, h: 1 }] };
    chats.r = [{ id: 'r1', role: 'assistant', text: 'We are at $29 with 40 customers.\n\nUnsourced figures: $29, 40 customers (not found in anything this turn read).', at: at('2026-09-26T16:00') }];
    const from = await sources({ stage, chat: async (roomId) => chats[roomId] ?? [] });
    expect(await gatherMorning(from)).toContain('Flagged by the truth net');
    const note = await writeMorning({ sources: from, name: 'Sam', promptFor: prompt, ask: async () => 'Three moves for today:\n1. Email the 40 customers paying $29 about the pre-order.\n2. b\n3. c\nRisk: Rohan was flagged for the price\nQuestion: q?' });
    expect(note).not.toBeNull();
    expect(note?.flags).toBeUndefined();
  });

  it('leaves a failed turn out of what it reads and of what keys it', async () => {
    const failed: ChatMessage = { id: 'f', role: 'assistant', text: 'No model could answer this time (gemini down). Ask again in a minute.', at: at('2026-09-26T16:00'), failed: true };
    const from = await sources();
    const withFailure = await sources({ chat: async (roomId) => (roomId === 'm' ? [...await from.chat('m'), failed] : []) });
    expect(await gatherMorning(withFailure)).not.toContain('No model could answer');
    const base = { stage: from.stage, partnerId: 'p1', decisions: await from.decisions(), bets: await from.bets(), company: '# Company', chats: { m: await from.chat('m') } };
    expect(morningInputs({ ...base, chats: { m: [...base.chats.m, failed] } })).toBe(morningInputs(base));
  });

  it('flags a figure again when yesterday\'s note was flagged for it and today\'s repeats it', async () => {
    const note = (price: string) => `Three moves for today:\n1. Set the price at ${price} on the landing page.\n2. Email the replied leads.\n3. Log signups.\nRisk: Maya priced it at $9\nQuestion: q?`;
    const first = await writeMorning({ sources: await sources({ chat: async () => [] }), name: 'Sam', promptFor: prompt, ask: async () => note('$29/month') });
    // Maya said nothing today, so "$9" is no figure of hers: the risk that puts it on her goes.
    expect(first?.flags).toEqual([expect.stringMatching(/^Unsourced figures: \$29/), '(left out: nothing on record about $9, which Maya never gave)']);
    const posted: ChatMessage = { id: 'n1', role: 'assistant', text: morningMessage(first!), at: at('2026-09-26T09:00') };
    const second = await writeMorning({ sources: await sources({ chat: async (roomId) => (roomId === 'p1' ? [posted] : []) }), name: 'Sam', promptFor: prompt, ask: async () => note('$29/month') });
    expect(second?.flags).toEqual([expect.stringMatching(/^Unsourced figures: \$29/), '(left out: nothing on record about $9, which Maya never gave)']);
  });

  it('checks the note as it is posted, not the words around it the reshaping drops', async () => {
    const note = await writeMorning({ sources: await sources(), name: 'Sam', promptFor: prompt, ask: async () => 'Good morning! We are at $44,000 of runway.\nThree moves for today:\n1. Email the replied leads.\n2. b\n3. c\nRisk: Maya priced it at $9\nQuestion: q?\nMy call: sell $12,500 of ads.' });
    expect(note).not.toBeNull();
    expect(note?.flags).toBeUndefined();
  });

  it('keeps which model wrote the note, when the ask says', async () => {
    const note = await writeMorning({ sources: await sources(), name: 'Sam', promptFor: async () => [{ role: 'system', content: 'You are Sam.' }],
      ask: async () => ({ text: 'Three moves for today:\n1. a\n2. b\n3. c\nRisk: Maya priced it at $9\nQuestion: q?', provider: 'gemini', model: 'gemini-3.5-flash-lite' }) });
    expect(note).toMatchObject({ things: ['a', 'b', 'c'], provider: 'gemini', model: 'gemini-3.5-flash-lite' });
  });

  // The review: a vague note used to burn a try and come back half an hour later to the same prompt, three times.
  it('asks once more in the same try with the reason, and takes the second answer when it holds', async () => {
    const heard: ModelMessage[][] = [];
    const replies = ['Three moves for today:\n1. a\n2. b\n3. c\nRisk: execution could slip\nQuestion: q?', 'Three moves for today:\n1. a\n2. b\n3. c\nRisk: Maya priced it at $9\nQuestion: q?'];
    const note = await writeMorning({ sources: await sources(), name: 'Sam', promptFor: async () => [{ role: 'system', content: 'You are Sam.' }], ask: async (messages) => { heard.push(messages); return replies[heard.length - 1]; } });
    expect(heard).toHaveLength(2);
    expect(heard[1].at(-1)?.content).toMatch(/^The risk names no room, document or number/);
    expect(heard[1].at(-2)).toEqual({ role: 'assistant', content: replies[0] });
    expect(note).toMatchObject({ risk: 'Maya priced it at $9' });
    expect(note?.flags).toBeUndefined();
  });

  it('gives nothing when it is still at fault on an early try, and posts it with a line saying so on the last', async () => {
    const vague = 'Three moves for today:\n1. a\n2. b\n3. c\nRisk: execution could slip\nQuestion: q?';
    const prompt = async (): Promise<ModelMessage[]> => [{ role: 'system', content: 'You are Sam.' }];
    let asked = 0;
    expect(await writeMorning({ sources: await sources(), name: 'Sam', promptFor: prompt, ask: async () => { asked += 1; return vague; } })).toBeNull();
    expect(asked).toBe(2);
    const last = await writeMorning({ sources: await sources(), name: 'Sam', promptFor: prompt, last: true, ask: async () => vague });
    expect(last?.risk).toBe('execution could slip');
    expect(last?.flags).toEqual(['Note check: the risk names no room, document or number, even when asked again.']);
    expect(morningMessage(last!)).toContain('Note check: the risk names no room');
    // A reply with no shape at all has nothing to post, last try or not.
    expect(await writeMorning({ sources: await sources(), name: 'Sam', promptFor: prompt, last: true, ask: async () => 'Good morning!' })).toBeNull();
  });

  it('gives back nothing when the reply lost the shape', async () => {
    expect(await writeMorning({ sources: await sources(), name: 'Sam', promptFor: prompt, ask: async () => 'Good morning!' })).toBeNull();
  });
});

describe('the day-2 note leads with what changed since yesterday', () => {
  const prompt = async (): Promise<ModelMessage[]> => [{ role: 'system', content: 'You are Sam, Partner.' }];
  const reply = 'Three moves for today:\n1. Call the five beta users before noon.\n2. b\n3. c\nRisk: Maya priced it at $9\nQuestion: q?';
  const promise = (extra: Partial<FounderPromise>): FounderPromise => ({ id: 'promise-1', what: 'call 5 beta users', due: '2026-09-26', said: '2026-09-26', at: at('2026-09-24T10:00'), status: 'open', ...extra });

  it('puts a slipped promise first, in the note, its message and the facts the model reads', async () => {
    let heard: ModelMessage[] = [];
    const note = await writeMorning({
      sources: await sources({ promises: async () => [promise({})] }), name: 'Sam', promptFor: prompt,
      ask: async (messages) => { heard = messages; return reply; },
    });
    expect(note!.since).toEqual(['Slipped: you said you would call 5 beta users (due 2026-09-26), now 1 day late.']);
    const lines = morningMessage(note!).split('\n').filter(Boolean);
    expect(lines.slice(0, 3)).toEqual(['**Morning, Sunday 27 September**', '**Since yesterday**', '- Slipped: you said you would call 5 beta users (due 2026-09-26), now 1 day late.']);
    expect(morningMessage(note!).indexOf('Slipped')).toBeLessThan(morningMessage(note!).indexOf('Three moves for today'));
    expect(heard[1].content).toContain('- Slipped: you said you would call 5 beta users (due 2026-09-26)');
  });

  it('says in one honest line when nothing changed', async () => {
    const note = await writeMorning({ sources: await sources({ promises: async () => [promise({ due: '2026-09-30' })] }), name: 'Sam', promptFor: prompt, ask: async () => reply });
    expect(note!.since).toEqual([]);
    expect(morningMessage(note!).split('\n\n')[1]).toBe(NOTHING_CHANGED);
  });

  it('reads the clock it is handed, not the machine\'s: the same promise is on time the day before', async () => {
    const day1 = await writeMorning({ sources: await sources({ now: at('2026-09-26T09:00'), promises: async () => [promise({})] }), name: 'Sam', promptFor: prompt, ask: async () => reply });
    expect(day1!.since).toEqual([]);
  });
});

// Journey 14's note: "Update the Company document ... to reflect the confirmed 4.4-month runway calculated by Ops."
// Ops had 4.99; 4.4 was the partner's own sum on the gross burn.
describe('the morning note\'s numbers', () => {
  const company = '# Company brief\n\n## Numbers\n\n- Price: €49 per practice per month\n- Paying practices: 2\n- Cash in the bank: €4,000\n- Monthly burn: €900\n';
  const prompt = async (): Promise<ModelMessage[]> => [{ role: 'system', content: 'You are Iris, Partner.' }];
  it('gives the model the calc working, and posts runway from calc with "confirmed" only beside what a read backs', async () => {
    let heard = '';
    const note = await writeMorning({
      sources: { ...await sources(), company }, name: 'Iris', promptFor: prompt,
      ask: async (messages) => { heard = String(messages.at(-1)?.content); return 'Three moves for today:\n1. Convert the 3 pilots.\n2. Update the Company document to reflect the confirmed 4.4-month runway calculated by Ops.\n3. Rosa confirmed 12 demos booked; follow up.\nRisk: runway is 4.4 months at the gross burn of €900\nQuestion: q?'; },
    });
    expect(heard).toContain('Worked with calc from the Company Numbers (the only runway and break-even to use; a figure said in a room is not one):\n- Break-even: ceil(900 / 49) = 19');
    expect(heard).toContain('- Runway: round(4000 / (900 - 2 * 49), 1) = 5 months at the net burn');
    // A move is a plan, never taken out (journey 17): the 3 pilots and the 12 demos nothing read gives are marked.
    expect(note!.things).toEqual(['Convert the 3 pilots.', 'Update the Company document to reflect the confirmed 5-month runway calculated by Ops.', 'Rosa said 12 demos booked; follow up. (not on record: 12 demos booked)']);
    expect(note!.risk).toBe('runway is 5 months at the gross burn of €900');
    expect(note!.flags?.some((one) => one.startsWith('(left out'))).toBeFalsy();
  });

  it('drops "confirmed" with no figure a read gives', () => {
    expect(confirmedFix('Use the confirmed 4.4-month runway.', ['- Cash: €4,000', 'round(4000 / 802, 1) = 5'])).toBe('Use the 4.4-month runway.');
    expect(confirmedFix('Otto confirmed 5 months of runway.', ['round(4000 / 802, 1) = 5'])).toBe('Otto confirmed 5 months of runway.');
    expect(confirmedFix('Dentists confirmed they want it.', [])).toBe('Dentists said they want it.');
  });
});

// Journey 15: the founder said no cold outreach at day 3, and the day-4 note said "Reach out to 10 more makers".
describe('the morning note and the founder\'s no', () => {
  const prompt = async (): Promise<ModelMessage[]> => [{ role: 'system', content: 'You are Sam, Partner.' }];
  it('asks again once for a move the founder ruled out, then drops it and says which no it kept to', async () => {
    const from = await sources();
    await saidNoFor(from.workspace, () => NINE - 3_600_000).record({ tool: 'chat', subject: 'cold outreach to more makers', reason: 'we are at 9 jobs' });
    const asked: ModelMessage[][] = [];
    const note = 'Three moves for today:\n1. Reach out to 10 more makers.\n2. Close the last print job without cold outreach.\n3. Update the Company brief with the jobs done.\nRisk: Maya priced it at $9\nQuestion: q?';
    const made = await writeMorning({ sources: from, name: 'Sam', promptFor: prompt, ask: async (messages) => { asked.push(messages); return note; } });
    expect(asked).toHaveLength(2);
    expect(String(asked[1].at(-1)!.content)).toMatch(/^You ruled out cold outreach to more makers on \d{1,2} \w{3,4} \('we are at 9 jobs'\), and a move proposes it/);
    expect(made!.things).toEqual(['Close the last print job without cold outreach.', 'Update the Company brief with the jobs done.']);
    expect(made!.flags).toContainEqual(expect.stringMatching(/^You ruled out cold outreach to more makers on \d{1,2} \w{3,4} \('we are at 9 jobs'\), so a move that proposed it was dropped\.$/));
  });
});

// Journey 17: ShiftMeals, four days.
describe('journey 17\'s morning notes', () => {
  const company = '# ShiftMeals\n\n## Numbers\n\n- Subscribers: 14\n- Paying subscribers: 11\n- Price: €59 per week\n- Cash: €6,000\n- Burn: €1,900 a month\n- Nurses contacted: 120\n- Goal: 30 paying subscribers by 2026-10-17\n';
  const prompt = async (): Promise<ModelMessage[]> => [{ role: 'system', content: 'You are Sam, Partner.' }];
  const RUNWAY = '# Runway\n\n- MRR: €2,812.33 (calc)\n- Net burn: -€912.33 a month (calc)\n- Gross runway: 3.16 months (calc)\n- Break-even: 8 paying subscribers (calc)\n';
  const stage: Stage = {
    rooms: [{ id: 'p1', name: 'Sam', role: 'Partner', accent: '#fff', brief: '', partner: true, x: 0, y: 0, w: 1, h: 1 }, { id: 'o', name: 'Otto', role: 'Finance', accent: '#fff', brief: '', x: 0, y: 0, w: 1, h: 1 }],
    docs: [{ id: 'runway', title: 'Runway', x: 0, y: 0, w: 1, h: 1 }], wires: [], cards: [],
  };
  const chats: Record<string, ChatMessage[]> = {
    o: [{ id: 'o1', role: 'assistant', text: 'Runway is written, every figure with calc.', at: at('2026-10-06T22:30'), tools: [{ id: 't1', name: 'create_doc', args: {}, ok: true, result: 'Created "Runway".', effect: { kind: 'doc-created', id: 'runway' } as never }] }],
    p1: [{ id: 's1', role: 'assistant', text: 'Ten more paying would add €2,556.67 a month.', at: at('2026-10-06T22:20') }],
  };
  const j17 = async (now: string): Promise<MorningSources> => ({
    ...await sources(), stage, company, now: at(now), chat: async (roomId) => chats[roomId] ?? [], doc: async (id) => (id === 'runway' ? RUNWAY : ''),
  });

  it('day 3: keeps all three moves, plans and not claims, with no "(left out …)" line and an empty heading', async () => {
    const note = await writeMorning({ sources: await j17('2026-10-08T06:30'), name: 'Sam', promptFor: prompt, ask: async () => 'Three moves for today:\n1. Follow up with the 120 nurses contacted to turn 2 New leads into trials.\n2. Prepare for the 1 Meeting lead with Anna Kowalski today.\n3. Watch paying subscribers: from 11 to 9.5 puts us near the 9 threshold.\nRisk: Paying subscribers fell from 11 to 9.5, nearing the kill line of 9 in Metrics\nQuestion: Is the drop to 9.5 one bad day, or churn?' });
    expect(note!.things).toHaveLength(3);
    // A plan that cites the brief's figures is kept as written, with nothing marked.
    expect(note!.things).toEqual(['Follow up with the 120 nurses contacted to turn 2 New leads into trials.', 'Prepare for the 1 Meeting lead with Anna Kowalski today.', 'Watch paying subscribers: from 11 to 9.5 puts us near the 9 threshold.']);
    expect(note!.risk).toMatch(/^Paying subscribers fell from 11 to 9\.5/);
    expect(note!.flags?.some((one) => one.startsWith('(left out'))).toBeFalsy();
    expect(morningMessage(note!)).toMatch(/Three moves for today:\n1\. Follow up/);
  });

  it('day 4: a risk that names a fact nothing backs stays the partner\'s view, never "Nothing on record"', async () => {
    const note = await writeMorning({ sources: await j17('2026-10-09T06:30'), name: 'Sam', promptFor: prompt, ask: async () => 'Three moves for today:\n1. Call Anna about Thursday delivery.\n2. Log the meeting.\n3. Rebuild Runway at the new price.\nRisk: 3 nurses cancelled last week, so churn may be rising\nQuestion: Which count is right, 11 or 12.5?' });
    expect(note!.risk).toBe('3 nurses cancelled last week, so churn may be rising (view)');
    expect(morningText(note!)).not.toContain('Nothing on record');
  });

  it('never ships an empty section: no moves is said in words, an empty risk or question is left out', () => {
    expect(morningText({ things: [], risk: '', question: 'Which count is right?' })).toBe('No moves today.\n\nQuestion: Which count is right?');
    expect(morningText({ things: ['Call Anna.'], risk: 'r', question: '' })).toBe('Three moves for today:\n1. Call Anna.\n\nRisk: r');
  });

  it('day 2: never puts the partner\'s own €2,556.67 on Otto, whose Runway never had it', async () => {
    const note = await writeMorning({ sources: await j17('2026-10-07T06:30'), name: 'Sam', promptFor: prompt, ask: async () => 'Three moves for today:\n1. Send the email to Anna.\n2. Read Otto\'s Runway: net burn is -€912.33 a month.\n3. Ask Pia for the spec.\nRisk: Otto\'s Runway doc listed unsourced figures (€2,556.67)\nQuestion: Otto, why did you save unsourced figures like €2,556.67?' });
    expect(note!.things[1]).toBe('Read Otto\'s Runway: net burn is -€912.33 a month.');
    expect(note!.risk).toBe('');
    expect(note!.question).toBe('');
    expect(note!.flags).toContain('(left out: nothing on record about €2,556.67, which Otto never gave)');
    expect(morningText(note!)).not.toContain('2,556.67');
  });

  it('says "(calc)" or "(from the brief)" for a figure beside a colleague\'s name that came from neither of their own', () => {
    const otto = [{ name: 'Otto', text: RUNWAY }];
    expect(attributed('Otto has break-even at 8 and runway at 3.16 months.', otto, { brief: company, worked: [] }).text).toBe('Otto has break-even at 8 and runway at 3.16 months.');
    expect(attributed('Otto says the cash is €6,000.', [{ name: 'Otto', text: '' }], { brief: company, worked: [] }).text).toBe('Otto says the cash is €6,000 (from the brief).');
    expect(attributed('Otto put MRR at €2,812.33.', [{ name: 'Otto', text: '' }], { brief: company, worked: [2812.333333] }).text).toBe('Otto put MRR at €2,812.33 (calc).');
    expect(attributed('Otto put MRR at €2,556.67.', [{ name: 'Otto', text: '' }], { brief: company, worked: [2812.333333] })).toEqual({ text: '', left: ['€2,556.67, which Otto never gave'] });
  });
});

// Journey 18: "Unconfirmed ... (contacted)" under every note, for a row of the brief and for a lead whose email was opened.
describe('outreach in the note', () => {
  const FLAG = 'Unconfirmed: this reply claims an action no tool confirmed (contacted).';
  const tom = { person: { name: 'Tom Becker' }, thread: [{ kind: 'sent' as const, at: new Date('2026-10-07T09:00').getTime() }, { kind: 'opened' as const, at: new Date('2026-10-07T15:00').getTime() }] };
  it('drops the flag for a count the brief gives, says a lead\'s outreach as its thread has it, and keeps any other', () => {
    expect(reachedFlags([FLAG], '1. Follow up the 80 plumbers contacted so far.', '- Plumbers contacted: 80', [])).toEqual([]);
    expect(reachedFlags([FLAG], '1. Tom Becker was contacted, so call him.', '', [tom])).toEqual(['Tom Becker: Contacted (opened in Gmail, 7 Oct).']);
    expect(reachedFlags([FLAG, 'Unsourced figures: 5'], '1. 120 plumbers contacted this week.', '- Plumbers contacted: 80', [])).toEqual([FLAG, 'Unsourced figures: 5']);
    expect(reachedFlags(['Unconfirmed: this reply claims an action no tool confirmed (sent, contacted).'], '1. I sent it. 80 plumbers contacted.', '- Plumbers contacted: 80', [])).toEqual(['Unconfirmed: this reply claims an action no tool confirmed (sent).']);
  });
});

// Journey 19: the price went from €29 to €33.35 one evening, and the next morning's note never said so.
describe('what moved in the brief since the last note', () => {
  const brief = (price: string, cash = '€3,200') => `- Price: ${price} a month per plumber\n- Trial users: 22\n- Paying plumbers: 14\n- Cash: ${cash}\n- Burn: €1,100 a month`;
  it('lists each input that moved, old → new, and a count a Metrics line already said is not said twice', () => {
    const seen = stateOf(brief('€29')).snapshot();
    expect(briefMoves(seen, stateOf(brief('€33.35', '€4,000')))).toEqual(['In the brief: price €29 a month → €33.35 a month.', 'In the brief: cash €3,200 → €4,000.']);
    expect(briefMoves(seen, stateOf(brief('€29')))).toEqual([]);
    expect(briefMoves(undefined, stateOf(brief('€33.35')))).toEqual([]);
    const fewer = stateOf(brief('€29').replace('Paying plumbers: 14', 'Paying plumbers: 12'));
    expect(briefMoves(seen, fewer)).toEqual(['In the brief: paying plumbers 14 → 12.']);
    expect(briefMoves(seen, fewer, ['Moved: Paying plumbers went from 14 to 12 (worse).'])).toEqual([]);
  });
  it('heads the next note and keeps the snapshot for the one after', async () => {
    const note = await writeMorning({
      sources: await sources({ seen: stateOf(brief('€29')).snapshot(), economics: async () => stateOf(brief('€33.35')) }), name: 'Sam', promptFor: async () => [{ role: 'system', content: 'You are Sam.' }],
      ask: async () => 'Three things that matter today:\n1. a\n2. b\n3. c\nRisk: Maya priced it at $9\nQuestion: q?',
    });
    expect(note?.since?.[0]).toBe('In the brief: price €29 a month → €33.35 a month.');
    expect(note?.snapshot?.price).toEqual({ value: 33.35, period: 'month' });
  });
});
