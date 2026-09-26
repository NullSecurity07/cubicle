import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChatMessage, Stage } from '../../shared/model.ts';
import type { Bet } from '../../shared/partner.ts';
import type { ModelMessage } from '../prompt.ts';
import { gatherMorning, MORNING_ASK, morningDue, morningInputs, MOST_TRIES, RETRY_AFTER, writeMorning, type MorningSources } from './morning.ts';

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
    expect(text).toContain('- Open: Post in r/SaaS. Bet: founders sign up. signups to 20 by 2026-10-03.');
    expect(text).toContain('- Closed 2026-09-20: Cold email 30. Did not work; leads:replied was 1 against 5.');
    expect(text).not.toContain('Proposed only');
  });
});

describe('one morning turn', () => {
  const prompt = async (): Promise<ModelMessage[]> => [{ role: 'system', content: 'You are Sam, Partner.' }];

  it('asks with the partner\'s own prompt and the facts, and hands back the note in its shape', async () => {
    let heard: ModelMessage[] = [];
    const note = await writeMorning({
      sources: await sources(), name: 'Sam', promptFor: prompt,
      ask: async (messages) => { heard = messages; return 'Three things that matter today:\n1. a\n2. b\n3. c\nRisk: r\nQuestion: q?'; },
    });
    expect(note).toEqual({ things: ['a', 'b', 'c'], risk: 'r', question: 'q?', day: '2026-09-27', at: NINE, roomId: 'p1', who: 'Sam' });
    expect(heard[0].content).toBe('You are Sam, Partner.');
    expect(heard[1].content.startsWith(MORNING_ASK)).toBe(true);
    expect(heard[1].content).toContain('Newsletter first');
  });

  it('refuses a note whose three moves only restate the Company document', async () => {
    const company = '# Company brief\n\n## Idea\n\nProduct focus: weekly curated list.\n\n## Numbers\n\nCurrent stage: pre-idea validation.\n\n## Open questions\n\n- Newsletter first or marketplace first?\n';
    const restated = 'Three moves for today:\n1. Product focus: weekly curated list.\n2. **Current stage:** pre-idea validation\n3. Newsletter first or marketplace first?\nRisk: r\nQuestion: q?';
    expect(await writeMorning({ sources: { ...await sources(), company }, name: 'Sam', promptFor: prompt, ask: async () => restated })).toBeNull();
    const moves = 'Three moves for today:\n1. Email the 5 replied leads before noon.\n2. Product focus: weekly curated list.\n3. Log signups.\nRisk: r\nQuestion: q?';
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

  it('gives back nothing when the reply lost the shape', async () => {
    expect(await writeMorning({ sources: await sources(), name: 'Sam', promptFor: prompt, ask: async () => 'Good morning!' })).toBeNull();
  });
});
