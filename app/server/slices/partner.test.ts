import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Room, Stage } from '../../shared/model.ts';
import type { Deps, Installed } from '../install.ts';
import { companyDocOf } from '../partner/company.ts';
import { stubDeps } from '../slice-stubs.ts';
import { decisionAttention } from '../decisions.ts';
import { todayFive } from '../today/rank.ts';
import partner, { createPartner, type PartnerOptions } from './partner.ts';

const ROOT = resolve(import.meta.dirname, '../../..');
const room = (id: string, name: string, extra: Partial<Room> = {}): Room => ({ id, name, role: 'x', accent: '#fff', brief: '', x: 0, y: 0, w: 1, h: 1, ...extra });

// A throwaway workspace with the real stores, and the slice installed on it. `fake: false` is a real run's start.
async function installed(extra: Partial<Deps> = {}, options?: PartnerOptions) {
  const workspace = await mkdtemp(join(tmpdir(), 'partner-'));
  const deps = { ...stubDeps(workspace, ROOT), fake: false, ...extra } as Deps;
  const part = (await (options ? createPartner(options) : partner.install)(deps)) as Installed;
  return { deps, part, workspace };
}
const withRooms = async (deps: Deps, rooms: Room[]) => { const stage = await deps.store.loadStage(); await deps.store.saveStage({ ...stage, rooms: [...stage.rooms, ...rooms] } as Stage); };

describe('the partner slice: the Company document', () => {
  it('puts the Company document on the stage at start, pinned, and writes decided decisions into it once', async () => {
    const { deps, part } = await installed();
    const doc = companyDocOf(await deps.store.loadStage())!;
    expect(doc.pinned).toBe(true);
    await deps.decisions.record({ title: 'Newsletter first', chosen: 'A weekly curated newsletter' });
    await deps.decisions.propose({ title: 'Raise now?', options: ['yes', 'no'] });
    await part.tick!();
    await part.tick!();
    const text = await deps.store.readDoc(doc.id);
    expect(text.match(/Newsletter first: A weekly curated newsletter/g)).toHaveLength(1);
    expect(text).not.toContain('Raise now?');
    await part.close!();
  });

  it('leaves the stage alone at start in fake mode, and makes the document once a partner is on it, wired to them', async () => {
    const { deps, part } = await installed({ fake: true });
    expect(companyDocOf(await deps.store.loadStage())).toBeUndefined();
    await part.tick!();
    expect(companyDocOf(await deps.store.loadStage())).toBeUndefined();
    await withRooms(deps, [room('p1', 'Sam', { partner: true })]);
    await part.tick!();
    const stage = await deps.store.loadStage();
    const doc = companyDocOf(stage)!;
    expect(stage.wires.filter((wire) => wire.from === 'p1' && wire.to === doc.id)).toHaveLength(1);
    await part.tick!();
    expect((await deps.store.loadStage()).wires.filter((wire) => wire.from === 'p1')).toHaveLength(1);
    await part.close!();
  });
});

const NINE = new Date('2026-09-27T09:00').getTime();
const SHAPED = 'Three things that matter today:\n1. Ship the landing page.\n2. Email the five replied leads.\n3. Log the signups.\nRisk: pre-orders are 3 of 17.\nQuestion: Keep $9?';

describe('the partner slice: the morning note', () => {
  it('writes the note once a day on the tick, into the partner\'s chat, Needs you and first in Today\'s five', async () => {
    let clock = NINE;
    let asked = 0;
    const answers: [number, unknown][] = [];
    const { deps, part } = await installed({ json: (_res, status, body) => { answers.push([status, body]); } }, { now: () => clock, ask: async () => { asked += 1; return SHAPED; } });
    await withRooms(deps, [room('p1', 'Sam', { partner: true })]);
    deps.attention.source(decisionAttention(deps.decisions));
    await deps.decisions.propose({ title: 'Raise now?', options: ['yes', 'no'] });
    await part.tick!();
    await part.tick!();
    expect(asked).toBe(1);
    const chat = await deps.store.readChat('p1');
    expect(chat).toHaveLength(1);
    expect(chat[0].text).toContain('Three things that matter today:\n1. Ship the landing page.');
    const needs = (await deps.attention.list()).find((one) => one.kind === 'morning-note')!;
    expect(needs).toMatchObject({ id: 'morning-note:2026-09-27', who: 'Sam', roomId: 'p1', title: 'Morning note: Ship the landing page.' });
    const five = await todayFive(deps, clock);
    expect(five[0]).toMatchObject({ kind: 'morning-note', reason: expect.stringContaining('From your partner') });
    expect(five.some((one) => one.kind === 'proposed-decision')).toBe(true);
    // Read: it leaves Needs you. The next day brings the next one.
    await part.route!({ method: 'POST' } as never, {} as never, '/api/partner/morning/done');
    expect((await deps.attention.list()).some((one) => one.kind === 'morning-note')).toBe(false);
    clock = NINE + 86_400_000;
    await part.tick!();
    expect(asked).toBe(2);
    await part.close!();
  });

  it('posts nothing when the reply loses its shape, and waits before it tries again', async () => {
    let asked = 0;
    const { deps, part } = await installed({}, { now: () => NINE, ask: async () => { asked += 1; return 'Good morning!'; } });
    await withRooms(deps, [room('p1', 'Sam', { partner: true })]);
    await part.tick!();
    await part.tick!();
    expect(asked).toBe(1);
    expect(await deps.store.readChat('p1')).toEqual([]);
    expect((await deps.attention.list()).some((one) => one.kind === 'morning-note')).toBe(false);
    await part.close!();
  });

  it('never runs on the tick of a fake run unless asked, and writes when the founder asks for it', async () => {
    let asked = 0;
    const answers: [number, unknown][] = [];
    const { deps, part } = await installed({ fake: true, json: (_res, status, body) => { answers.push([status, body]); } }, { now: () => NINE, ask: async () => { asked += 1; return SHAPED; } });
    await part.route!({ method: 'POST' } as never, {} as never, '/api/partner/morning');
    expect(answers.at(-1)?.[0]).toBe(409);
    await withRooms(deps, [room('p1', 'Sam', { partner: true })]);
    await part.tick!();
    expect(asked).toBe(0);
    await part.route!({ method: 'POST' } as never, {} as never, '/api/partner/morning');
    expect(asked).toBe(1);
    expect(answers.at(-1)).toEqual([200, expect.objectContaining({ day: '2026-09-27', things: ['Ship the landing page.', 'Email the five replied leads.', 'Log the signups.'] })]);
    await part.close!();
  });

  it('has no partner, no note', async () => {
    let asked = 0;
    const { part } = await installed({}, { now: () => NINE, ask: async () => { asked += 1; return SHAPED; } });
    await part.tick!();
    expect(asked).toBe(0);
    await part.close!();
  });
});

describe('the partner slice: the bets ledger', () => {
  it('takes a proposed bet through Needs you onto the Company document, and lets only the partner close it on its day', async () => {
    let clock = new Date('2026-09-26T10:00').getTime();
    const told: string[] = [];
    const answers: [number, unknown][] = [];
    const { deps, part, workspace } = await installed({ notify: (title) => { told.push(title); }, json: (_res, status, body) => { answers.push([status, body]); } }, { now: () => clock, ask: async () => SHAPED });
    await mkdir(join(workspace, 'metrics'), { recursive: true });
    await writeFile(join(workspace, 'metrics', 'metrics-1.json'), JSON.stringify({ updatedAt: 0, metrics: [{ key: 'signups', label: 'Signups', unit: '', better: 'up', points: [{ at: '2026-09-20', value: 4, from: 'founder' }] }] }));
    const stage = await deps.store.loadStage();
    await deps.store.saveStage({ ...stage, rooms: [...stage.rooms, room('p1', 'Sam', { partner: true })], cards: [{ id: 'metrics-1', kind: 'metrics', x: 0, y: 0, w: 1, h: 1 }] });
    const tool = (name: string) => part.tools!.find((one) => one.name === name)!;
    const as = async (roomId: string) => ({ stage: await deps.store.loadStage(), roomId, store: deps.store, granted: new Map() }) as never;

    await expect(tool('propose_bet').run({ what: 'Post in r/SaaS', hypothesis: 'founders sign up', metric: 'mrr', target: 20, check_date: '2026-10-03' }, await as('marketing'))).rejects.toThrow('Measure it by one of: signups');
    await expect(tool('propose_bet').run({ what: 'x', hypothesis: 'y', metric: 'signups', target: 20, check_date: '2026-09-01' }, await as('marketing'))).rejects.toThrow('before today');
    const said = await tool('propose_bet').run({ what: 'Post in r/SaaS', hypothesis: 'founders sign up', metric: 'signups', target: 20, check_date: '2026-10-03' }, await as('marketing'));
    expect(said.text).toContain('It waits in Needs you');
    const proposal = (await deps.attention.list()).find((one) => one.kind === 'proposed-bet')!;
    expect(proposal).toMatchObject({ who: 'Maya', title: 'Post in r/SaaS' });

    // Answered as the window does, with accept.
    deps.body = async () => ({ accept: true });
    await part.route!({ method: 'POST' } as never, {} as never, `/api/partner/bets/${proposal.id.split(':')[1]}`);
    const company = companyDocOf(await deps.store.loadStage())!;
    expect(await deps.store.readDoc(company.id)).toContain('## Bets\n\n- Open: Post in r/SaaS. signups to 20 by 2026-10-03');

    // Staff are never offered close_bet; the partner is, and cannot use it before the day.
    const names = (roomId: string) => part.offer!(part.tools!, { rooms: [room('p1', 'Sam', { partner: true }), room('marketing', 'Maya')], docs: [], wires: [] }, roomId).map((one) => one.name);
    expect(names('marketing')).toEqual(['propose_bet']);
    expect(names('p1')).toEqual(['propose_bet', 'close_bet']);
    await expect(tool('close_bet').run({ bet: 'Post in r/SaaS', verdict: 'worked' }, await as('marketing'))).rejects.toThrow('only the founder or the partner');
    await expect(tool('close_bet').run({ bet: 'Post in r/SaaS', verdict: 'worked' }, await as('p1'))).rejects.toThrow('checked on 2026-10-03');

    // The day comes: the tick says so once, Needs you shows the number read from the card.
    await part.tick!();
    clock = new Date('2026-10-03T10:00').getTime();
    await part.tick!();
    await part.tick!();
    expect(told.filter((one) => one === 'A bet is due for a check')).toHaveLength(1);
    expect((await deps.attention.list()).find((one) => one.kind === 'bet-check')?.detail).toBe('The target was 20 by 2026-10-03. Now: Signups is 4 (2026-09-20), read from the Metrics card.');
    const closed = await tool('close_bet').run({ bet: 'r/saas', verdict: 'did-not', note: 'only 4 came' }, await as('p1'));
    expect(closed.text).toBe('Closed "Post in r/SaaS": it did not work; signups was 4 against 20. (Signups is 4 (2026-09-20), read from the Metrics card.)');
    expect((await deps.attention.list()).some((one) => one.kind === 'bet-check')).toBe(false);
    expect(await deps.store.readDoc(company.id)).toContain('- Did not work: Post in r/SaaS. signups was 4 against 20 (checked 2026-10-03). only 4 came');
    await part.close!();
  });

  it('lets the founder say how a due bet went from Needs you', async () => {
    const answers: [number, unknown][] = [];
    const { deps, part } = await installed({ json: (_res, status, body) => { answers.push([status, body]); } }, { now: () => new Date('2026-10-05T10:00').getTime(), ask: async () => SHAPED });
    const stage = await deps.store.loadStage();
    await deps.store.saveStage({ ...stage, cards: [{ id: 'leads-1', kind: 'leads', x: 0, y: 0, w: 1, h: 1 }] });
    const bet = await part.tools!.find((one) => one.name === 'propose_bet')!.run({ what: 'Cold email 30', hypothesis: 'five reply', metric: 'leads:replied', target: 5, check_date: '2026-10-05' }, { stage: await deps.store.loadStage(), roomId: 'marketing', store: deps.store, granted: new Map() } as never);
    expect(bet.text).toContain('Cold email 30');
    const id = (await deps.attention.list()).find((one) => one.kind === 'proposed-bet')!.id.split(':')[1];
    deps.body = async () => ({ accept: true });
    await part.route!({ method: 'POST' } as never, {} as never, `/api/partner/bets/${id}`);
    deps.body = async () => ({ verdict: 'worked' });
    await part.route!({ method: 'POST' } as never, {} as never, `/api/partner/bets/${id}/close`);
    expect(answers.at(-1)).toEqual([200, expect.objectContaining({ status: 'closed', result: expect.objectContaining({ verdict: 'worked', value: 0, by: 'Founder' }) })]);
    await part.close!();
  });
});
