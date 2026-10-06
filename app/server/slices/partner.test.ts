import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Room, Stage } from '../../shared/model.ts';
import { COMPANY_LINE, companyLine } from '../../shared/partner.ts';
import type { Deps, Installed } from '../install.ts';
import { companyDocOf } from '../partner/company.ts';
import { partnerState } from '../partner/state.ts';
import { promisesAttention, promisesBook } from '../partner/promises.ts';
import { stubDeps } from '../slice-stubs.ts';
import { decisionAttention } from '../decisions.ts';
import { hub } from '../events.ts';
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

  it('leaves the stage alone at start in fake mode, and adopts the Company brief once a partner is on it, wired once', async () => {
    const { deps, part } = await installed({ fake: true });
    await deps.store.loadStage();
    const brief = await deps.store.readDoc('company-brief');
    await part.tick!();
    expect(await deps.store.readDoc('company-brief')).toBe(brief);
    await withRooms(deps, [room('p1', 'Sam', { partner: true })]);
    await part.tick!();
    const stage = await deps.store.loadStage();
    expect(stage.docs.filter((doc) => doc.pinned).map((doc) => doc.id)).toEqual(['company-brief']);
    expect(await deps.store.readDoc('company-brief')).toContain('## Open questions');
    expect(stage.wires.filter((wire) => wire.from === 'p1' && wire.to === 'company-brief')).toHaveLength(1);
    // The founder takes the wire away: it is not drawn again.
    await deps.store.saveStage({ ...stage, wires: stage.wires.filter((wire) => wire.from !== 'p1') });
    await part.tick!();
    await part.tick!();
    expect((await deps.store.loadStage()).wires.filter((wire) => wire.from === 'p1')).toHaveLength(0);
    await part.close!();
  });

  it('keeps finding the document by its id after a rename, and does not make it again once the founder removed it', async () => {
    const { deps, part } = await installed();
    await deps.store.patchStage((stage) => { stage.docs.find((doc) => doc.id === 'company-brief')!.title = 'Flipside'; });
    await withRooms(deps, [room('p1', 'Sam', { partner: true })]);
    await deps.decisions.record({ title: 'Newsletter first', chosen: 'Weekly' });
    await part.tick!();
    expect(await deps.store.readDoc('company-brief')).toContain('Newsletter first: Weekly');
    expect((await deps.store.loadStage()).docs.filter((doc) => doc.pinned)).toHaveLength(1);
    // Removed: not made again by the tick, nor by a new start.
    await deps.store.patchStage((stage) => { stage.docs = stage.docs.filter((doc) => doc.id !== 'company-brief'); stage.wires = stage.wires.filter((wire) => wire.to !== 'company-brief'); });
    await part.tick!();
    await part.close!();
    const again = (await partner.install(deps)) as Installed;
    await again.tick!();
    expect((await deps.store.loadStage()).docs.filter((doc) => doc.pinned)).toHaveLength(0);
    // "add partner" asks for it outright: then it is made again.
    await again.route!({ method: 'POST' } as never, {} as never, '/api/partner/company');
    expect(companyDocOf(await deps.store.loadStage())).toMatchObject({ title: 'Company', pinned: true });
    await again.close!();
  });

  it('keeps the company line in the prompt for a renamed document, found by its recorded id', async () => {
    const { deps, part } = await installed();
    await deps.store.patchStage((stage) => { stage.docs.find((doc) => doc.id === 'company-brief')!.title = 'Flipside'; });
    const turn = (content: string) => deps.seams.run('turn:before', { roomId: 'marketing', source: 'chat', query: 'hi', messages: [{ role: 'system', content }] });
    expect((await turn('You are Maya.')).messages[0].content).toBe(`You are Maya.\n\n${companyLine('Flipside')}`);
    expect(companyLine('Flipside')).toBe('The "Flipside" document is the shared record; when the chat and it disagree, say so.');
    expect((await turn(`You are Maya.\n\n${COMPANY_LINE}`)).messages[0].content).toBe(`You are Maya.\n\n${COMPANY_LINE}`);
    await deps.store.patchStage((stage) => { stage.docs = stage.docs.filter((doc) => doc.id !== 'company-brief'); });
    expect((await turn('You are Maya.')).messages[0].content).toBe('You are Maya.');
    await part.close!();
  });

  it('puts back a decision line a window saved its old text over, and forgets the recorded doc once partner.json is gone', async () => {
    const { deps, part, workspace } = await installed();
    await deps.decisions.record({ title: 'Price', chosen: 'Nine dollars' });
    await part.tick!();
    const written = await deps.store.readDoc('company-brief');
    expect(written).toContain('Price: Nine dollars');
    await deps.store.writeDoc('company-brief', written.replace(/^- .*Price: Nine dollars$/m, ''));
    await part.tick!();
    expect((await deps.store.readDoc('company-brief')).match(/Price: Nine dollars/g)).toHaveLength(1);
    // A clean-up takes partner.json away: the next look finds nothing recorded, as on a first run.
    await rm(join(workspace, 'partner.json'));
    await deps.store.patchStage((stage) => { stage.docs.find((doc) => doc.id === 'company-brief')!.pinned = false; });
    await part.tick!();
    expect(await readFile(join(workspace, 'partner.json'), 'utf8').then((text) => JSON.parse(text).companyId).catch(() => undefined)).toBeUndefined();
    await part.close!();
  });

  it('keeps the state it holds in a fresh workspace until a file that existed is taken away', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'partner-state-'));
    const book = partnerState(workspace);
    const first = await book.read();
    first.decided.push('held in memory');
    expect(await book.read()).toBe(first);
    await book.change((held) => { held.companyId = 'company-brief'; });
    expect((await book.read()).decided).toEqual(['held in memory']);
    await rm(join(workspace, 'partner.json'));
    expect(await book.read()).toEqual({ decided: [], plans: [] });
  });

  it('tells the window each time the app writes into the document', async () => {
    const said: [string, unknown][] = [];
    const before = hub.say;
    hub.say = (channel, data) => { said.push([channel, data]); };
    try {
      const { deps, part } = await installed();
      expect(said).toEqual([['partner', { docChanged: 'company-brief' }]]);
      await deps.decisions.record({ title: 'Price', chosen: 'Nine dollars' });
      await part.tick!();
      expect(said.at(-1)).toEqual(['partner', { docChanged: 'company-brief' }]);
      expect(said).toHaveLength(2);
      await part.close!();
    } finally { hub.say = before; }
  });

  it('gives the Company doc the window put down its sections, when the window asks', async () => {
    const answers: [number, unknown][] = [];
    const { deps, part } = await installed({ fake: true, json: (_res, status, body) => { answers.push([status, body]); } });
    const stage = await deps.store.loadStage();
    await deps.store.saveStage({ ...stage, docs: [...stage.docs.filter((doc) => !doc.pinned), { id: 'doc-x1', title: 'Company', pinned: true, x: 0, y: 0, w: 1, h: 1 }] });
    deps.body = async () => ({ id: 'doc-x1' });
    await part.route!({ method: 'POST' } as never, {} as never, '/api/partner/company');
    expect(answers.at(-1)).toEqual([200, { id: 'doc-x1', created: false, hasIdea: false }]);
    await deps.store.writeDoc('doc-x1', `${await deps.store.readDoc('doc-x1')}\nA weekly paid list of abandoned side projects under five thousand dollars.\n`);
    await part.route!({ method: 'POST' } as never, {} as never, '/api/partner/company');
    expect(answers.at(-1)).toEqual([200, { id: 'doc-x1', created: false, hasIdea: true }]);
    expect(await deps.store.readDoc('doc-x1')).toContain('## Idea');
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
    // The partner arrived yesterday: no note on the day they arrive.
    clock -= 86_400_000; await part.tick!(); clock += 86_400_000;
    deps.attention.source(decisionAttention(deps.decisions));
    await deps.decisions.propose({ title: 'Raise now?', options: ['yes', 'no'] });
    await part.tick!();
    await part.tick!();
    expect(asked).toBe(1);
    const chat = await deps.store.readChat('p1');
    expect(chat).toHaveLength(1);
    expect(chat[0].text).toContain('Three moves for today:\n1. Ship the landing page.');
    const needs = (await deps.attention.list()).find((one) => one.kind === 'morning-note')!;
    expect(needs).toMatchObject({ id: 'morning-note:2026-09-27', who: 'Sam', roomId: 'p1', title: 'Morning note: Ship the landing page.' });
    // All three moves in the row, not the first one only.
    expect(needs.detail).toBe('2. Email the five replied leads. 3. Log the signups. Risk: pre-orders are 3 of 17. Question: Keep $9?');
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
    let clock = NINE;
    const { deps, part } = await installed({}, { now: () => clock, ask: async () => { asked += 1; return 'Good morning!'; } });
    await withRooms(deps, [room('p1', 'Sam', { partner: true })]);
    // The partner arrived yesterday: no note on the day they arrive.
    clock -= 86_400_000; await part.tick!(); clock += 86_400_000;
    await part.tick!();
    await part.tick!();
    // One try is the ask and one ask again with the reason, then the wait.
    expect(asked).toBe(2);
    expect(await deps.store.readChat('p1')).toEqual([]);
    expect((await deps.attention.list()).some((one) => one.kind === 'morning-note')).toBe(false);
    await part.close!();
  });

  it('asks for the morning note the way a turn does: a refused key is rested and the next model writes it', async () => {
    let refusedAsked = 0;
    const client = (name: string, step: () => Promise<string>) => ({ name, model: `${name}-1`, maxPromptChars: Infinity, tools: true, limits: {},
      async step(_messages: unknown, { onToken }: { onToken: (token: string) => void }) { onToken(await step()); return { text: '', calls: [] }; } });
    const refused = client('refused', async () => { refusedAsked += 1; throw Object.assign(new Error('401 invalid key'), { status: 401 }); });
    let clock = NINE;
    const { deps, part } = await installed({ clients: [refused, client('good', async () => SHAPED)] as Deps['clients'] }, { now: () => clock });
    await withRooms(deps, [room('p1', 'Sam', { partner: true })]);
    // The partner arrived yesterday: no note on the day they arrive.
    clock -= 86_400_000; await part.tick!(); clock += 86_400_000;
    await part.tick!();
    expect(refusedAsked).toBe(1);
    expect(deps.usage.dead('refused')).toBe(true);
    expect((await deps.store.readChat('p1')).at(-1)?.text).toContain('Ship the landing page');
    // Stamped with the model that wrote it, as a chat reply is.
    expect((await deps.store.readChat('p1')).at(-1)).toMatchObject({ provider: 'good', model: 'good-1' });
    await part.close!();
  });

  it('writes the morning note on the next model when the first breaks off part way, and leaves no broken words in it', async () => {
    const broken = { name: 'broken', model: 'broken-1', maxPromptChars: Infinity, tools: true, limits: {},
      async step(_messages: unknown, { onToken }: { onToken: (token: string) => void }) { onToken('Three moves for'); throw Object.assign(new Error("400 Failed to call a function. See 'failed_generation'."), { status: 400 }); } };
    const good = { name: 'good', model: 'good-1', maxPromptChars: Infinity, tools: true, limits: {},
      async step(_messages: unknown, { onToken }: { onToken: (token: string) => void }) { onToken(SHAPED); return { text: '', calls: [] }; } };
    let clock = NINE;
    const { deps, part } = await installed({ clients: [broken, good] as Deps['clients'] }, { now: () => clock });
    await withRooms(deps, [room('p1', 'Sam', { partner: true })]);
    clock -= 86_400_000; await part.tick!(); clock += 86_400_000;
    await part.tick!();
    expect((await deps.store.readChat('p1')).at(-1)).toMatchObject({ provider: 'good', model: 'good-1' });
    await part.close!();
  });

  it('waits half an hour after a model call that throws, and stops after three in a day', async () => {
    let clock = NINE;
    let asked = 0;
    const { deps, part } = await installed({}, { now: () => clock, ask: async () => { asked += 1; throw new Error('429 too many requests'); } });
    await withRooms(deps, [room('p1', 'Sam', { partner: true })]);
    // The partner arrived yesterday: no note on the day they arrive.
    clock -= 86_400_000; await part.tick!(); clock += 86_400_000;
    for (let tick = 0; tick < 4; tick += 1) { await part.tick!(); clock += 30_000; }
    expect(asked).toBe(1);
    clock = NINE + 30 * 60_000;
    await part.tick!();
    clock = NINE + 60 * 60_000;
    await part.tick!();
    clock = NINE + 5 * 60 * 60_000;
    await part.tick!();
    expect(asked).toBe(3);
    expect(await deps.store.readChat('p1')).toEqual([]);
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

  it('writes nothing on the day the partner arrives, and the command writes again only when something it reads changed', async () => {
    let asked = 0;
    const answers: [number, unknown][] = [];
    const { deps, part } = await installed({ json: (_res, status, body) => { answers.push([status, body]); } }, { now: () => NINE, ask: async () => { asked += 1; return SHAPED; } });
    await withRooms(deps, [room('p1', 'Sam', { partner: true })]);
    await part.tick!();
    await part.tick!();
    expect(asked).toBe(0);
    expect(await deps.store.readChat('p1')).toEqual([]);
    const command = () => part.route!({ method: 'POST' } as never, {} as never, '/api/partner/morning');
    await command();
    expect(asked).toBe(1);
    await command();
    expect(asked).toBe(1);
    expect(answers.at(-1)).toEqual([200, expect.objectContaining({ unchanged: true, things: expect.any(Array) })]);
    await deps.decisions.record({ title: 'Newsletter first', chosen: 'Weekly' });
    await part.tick!();
    await command();
    expect(asked).toBe(2);
    expect((answers.at(-1)![1] as { unchanged?: true }).unchanged).toBeUndefined();
    expect((await deps.store.readChat('p1')).filter((one) => one.role === 'assistant')).toHaveLength(2);
    await part.close!();
  });

  it('posts a note with an unsourced figure all the same, with the flag line under it in the partner\'s chat', async () => {
    const { deps, part } = await installed({}, { now: () => NINE, ask: async () => 'Three moves for today:\n1. Charge $29/month from Monday.\n2. Email the replied leads.\n3. Log signups.\nRisk: the Company document holds no price\nQuestion: q?' });
    await withRooms(deps, [room('p1', 'Sam', { partner: true })]);
    await part.route!({ method: 'POST' } as never, {} as never, '/api/partner/morning');
    const said = (await deps.store.readChat('p1')).at(-1)!.text;
    expect(said).toContain('1. Charge $29/month from Monday.');
    expect(said).toMatch(/\n\nUnsourced figures: \$29/);
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

    await expect(tool('propose_bet').run({ what: 'Post in r/SaaS', hypothesis: 'founders sign up', metric: 'mrr', target: 20, check_date: '2026-10-03' }, await as('marketing'))).rejects.toThrow('the Metrics card has no "mrr" row. Ask the founder to add one');
    await expect(tool('propose_bet').run({ what: 'x', hypothesis: 'y', metric: 'signups', target: 20, check_date: '2026-09-01' }, await as('marketing'))).rejects.toThrow('before today');
    // The ask counts signups: a first pick of leads is refused with the row the ask names, not the Leads card.
    const asking = async (query: string) => ({ ...(await as('p1') as object), query }) as never;
    const leadsPick = tool('propose_bet').run({ what: 'Newsletter', hypothesis: 'h', metric: 'leads:replied', target: 50, check_date: '2026-10-10' }, await asking('Propose a bet: 50 newsletter signups by Oct 10'));
    await expect(leadsPick).rejects.toThrow('The founder\'s ask counts signups: propose it again measured by "signups"');
    await expect(tool('propose_bet').run({ what: 'Newsletter', hypothesis: 'h', metric: 'visitors', target: 50, check_date: '2026-10-10' }, await asking('Propose a bet: 500 visitors by Oct 10'))).rejects.toThrow('the Metrics card has no "visitors" row. Ask the founder to add one');
    await expect(tool('propose_bet').run({ what: 'Newsletter', hypothesis: 'h', metric: 'leads', target: 500, check_date: '2026-10-10' }, await asking('Propose a bet: 500 visitors by Oct 10'))).rejects.toThrow('The founder\'s ask counts visitors: propose it again measured by "visitors". The Metrics card has no "visitors" row');
    const said = await tool('propose_bet').run({ what: 'Post in r/SaaS', hypothesis: 'founders sign up', metric: 'signups', target: 20, check_date: '2026-10-03' }, await as('marketing'));
    expect(said.text).toContain('It waits in Needs you');
    const proposal = (await deps.attention.list()).find((one) => one.kind === 'proposed-bet')!;
    expect(proposal).toMatchObject({ who: 'Maya', title: 'Post in r/SaaS' });

    // Answered as the window does, with accept.
    deps.body = async () => ({ accept: true });
    await part.route!({ method: 'POST' } as never, {} as never, `/api/partner/bets/${proposal.id.split(':')[1]}`);
    const company = companyDocOf(await deps.store.loadStage())!;
    expect(await deps.store.readDoc(company.id)).toContain('## Bets\n\n- Open: Post in r/SaaS. Measured by "signups" on the Metrics card: 20 by 2026-10-03');

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
    expect(await deps.store.readDoc(company.id)).toContain('- Did not work: Post in r/SaaS. Measured by "signups" on the Metrics card: was 4 against 20 (checked 2026-10-03). only 4 came');
    await part.close!();
  });

  // Journey 9: "there is no Metrics card with a 'paying users' row", while the brief held "Paying users: 2". The founder
  // had to add a card, paste a CSV and drag a wire before the partner could bet.
  it('offers a bet on a number only the Company brief holds, and taking it adds a Metrics card from the brief, wired to the partner', async () => {
    const answers: [number, unknown][] = [];
    const { deps, part, workspace } = await installed({ json: (_res, status, body) => { answers.push([status, body]); } }, { now: () => new Date('2026-09-27T10:00').getTime(), ask: async () => SHAPED });
    const stage = await deps.store.loadStage();
    await deps.store.saveStage({ ...stage, rooms: [...stage.rooms, room('p1', 'Sam', { partner: true })] });
    const company = companyDocOf(await deps.store.loadStage())!;
    const brief = await deps.store.readDoc(company.id);
    await deps.store.writeDoc(company.id, brief.replace('## Numbers', '## Numbers\n\n- Cash: €9,800 (founder, 2026-09-27)\n- Beta users: 12 (founder, 2026-09-27)\n- Paying users: 2 (founder, 2026-09-27)'));
    const propose = async (metric: string, target: number, query = 'Take a bet: 2 to 6 paying users by 11 October') => part.tools!.find((one) => one.name === 'propose_bet')!.run({ what: 'Email the 12 beta users a €19 offer', hypothesis: 'hobby hosts convert at the lower tier', metric, target, check_date: '2026-10-11' }, { stage: await deps.store.loadStage(), roomId: 'p1', store: deps.store, granted: new Map(), query } as never);
    // Still held to a target that can lose, read from the brief.
    await expect(propose('paying users', 2)).rejects.toThrow('"paying users" is 2 now, read from the Company brief: a target of 2 cannot lose');
    // A number the brief does not hold either is still the founder's to add.
    await expect(propose('signups', 6, 'Take a bet: 6 signups by 11 October')).rejects.toThrow('there is no Metrics card with a "signups" row');
    const said = await propose('paying users', 6);
    expect(said.text).toContain('No Metrics card holds "paying users" yet: taking the bet adds one from the Company brief (Paying users 2), wired to Sam.');
    const row = (await deps.attention.list()).find((one) => one.kind === 'proposed-bet')!;
    expect(row.detail).toContain('Add a Metrics card from the brief and take the bet: taking it adds a Metrics card with Paying users at 2, wired to Sam.');

    deps.body = async () => ({ accept: true });
    // Two quick yeses add one card: the second finds it by the metric's key.
    const url = `/api/partner/bets/${row.id.split(':')[1]}`;
    await Promise.allSettled([part.route!({ method: 'POST' } as never, {} as never, url), part.route!({ method: 'POST' } as never, {} as never, url)]);
    const after = await deps.store.loadStage();
    expect((after.cards ?? []).filter((one) => one.kind === 'metrics')).toHaveLength(1);
    const data = JSON.parse(await readFile(join(workspace, 'metrics', `${(after.cards ?? []).find((one) => one.kind === 'metrics')!.id}.json`), 'utf8'));
    // A card of that key left on the stage without its wire still gets the partner's wire.
    await deps.store.patchStage((draft) => { draft.wires = draft.wires.filter((wire) => !wire.to.startsWith('metrics-')); });
    const { metricsFromBrief } = await import('./partner.ts');
    await metricsFromBrief(workspace, deps.store, { label: 'Paying users', value: 2 }, 'p1', new Date('2026-09-27T10:00').getTime());
    const rewired = await deps.store.loadStage();
    expect((rewired.cards ?? []).filter((one) => one.kind === 'metrics')).toHaveLength(1);
    expect(rewired.wires.filter((wire) => wire.from === 'p1' && wire.to.startsWith('metrics-'))).toHaveLength(1);
    const card = (after.cards ?? []).find((one) => one.kind === 'metrics')!;
    expect(card).toMatchObject({ kind: 'metrics', title: 'Numbers' });
    expect(after.wires.filter((wire) => wire.from === 'p1' && wire.to === card.id)).toHaveLength(1);
    // Journey 13: the card said "Set a target" beside a bet with one; the bet's number and day are the row's target.
    expect(data.metrics).toEqual([{ key: 'paying-users', label: 'Paying users', better: 'up', points: [{ at: '2026-09-27', value: 2, from: 'the Company brief' }], target: { value: 6, by: '2026-10-11' } }]);
    expect(await deps.store.readDoc(company.id)).toContain('- Open: Email the 12 beta users a €19 offer. Measured by "paying users" on the Metrics card: 6 by 2026-10-11');
    // Taken once: a second yes adds no second card.
    expect((await part.tools!.find((one) => one.name === 'propose_bet')!.run({ what: 'Second', hypothesis: 'h', metric: 'paying users', target: 7, check_date: '2026-10-11' }, { stage: await deps.store.loadStage(), roomId: 'p1', store: deps.store, granted: new Map(), query: 'bet on 7 paying users' } as never)).text).not.toContain('No Metrics card');
    await part.close!();
  });

  // Journey 5: with paying users at 3, the partner proposed a bet with target 3, one that could not lose.
  it('refuses a bet whose target does not beat the number as it stands, the right way for that number', async () => {
    const { deps, part, workspace } = await installed({}, { now: () => new Date('2026-09-27T10:00').getTime(), ask: async () => SHAPED });
    await mkdir(join(workspace, 'metrics'), { recursive: true });
    await writeFile(join(workspace, 'metrics', 'metrics-1.json'), JSON.stringify({ updatedAt: 0, metrics: [
      { key: 'paying_users', label: 'paying_users', unit: '', better: 'up', points: [{ at: '2026-09-25', value: 2, from: 'founder' }, { at: '2026-09-27', value: 3, from: 'founder' }] },
      { key: 'churn', label: 'Churn', unit: '%', better: 'down', points: [{ at: '2026-09-27', value: 8, from: 'founder' }] },
    ] }));
    const stage = await deps.store.loadStage();
    await deps.store.saveStage({ ...stage, rooms: [...stage.rooms, room('p1', 'Sam', { partner: true })], cards: [{ id: 'metrics-1', kind: 'metrics', x: 0, y: 0, w: 1, h: 1 }] });
    const propose = async (metric: string, target: number) => part.tools!.find((one) => one.name === 'propose_bet')!.run({ what: 'Ship PDF invoices to the beta users', hypothesis: 'they stay and pay', metric, target, check_date: '2026-10-11' }, { stage: await deps.store.loadStage(), roomId: 'p1', store: deps.store, granted: new Map(), query: 'make the 2-week bet' } as never);
    await expect(propose('paying_users', 3)).rejects.toThrow('"paying_users" is 3 now, read from the Metrics card: a target of 3 cannot lose. Propose a target above 3');
    await expect(propose('paying_users', 2)).rejects.toThrow('a target of 2 cannot lose');
    await expect(propose('churn', 9)).rejects.toThrow('"churn" is 8 now, read from the Metrics card: a target of 9 cannot lose. Churn is better lower: propose a target below 8');
    expect((await propose('paying_users', 5)).text).toContain('(paying_users to 5 by 2026-10-11)');
    expect((await propose('churn', 5)).text).toContain('(churn to 5 by 2026-10-11)');
    await part.close!();
  });

  // Program 6: a bet ran end to end only on paper. On its day the check is posted in the partner's room with the
  // number read in code, once, even across a restart; a close lands in Bets and What we learned, and the partner's
  // standing facts and morning note carry the lesson.
  it('posts the check with its number once on the day, and a close reaches Bets, What we learned, the standing facts and the morning note', async () => {
    let clock = new Date('2026-09-26T10:00').getTime();
    const asked: string[] = [];
    const options: PartnerOptions = { now: () => clock, ask: async (messages) => { asked.push(String(messages.at(-1)!.content)); return SHAPED; } };
    const { deps, part, workspace } = await installed({ json: () => {} }, options);
    await mkdir(join(workspace, 'metrics'), { recursive: true });
    await writeFile(join(workspace, 'metrics', 'metrics-1.json'), JSON.stringify({ updatedAt: 0, metrics: [{ key: 'signups', label: 'Signups', unit: '', better: 'up', points: [{ at: '2026-09-20', value: 4, from: 'founder' }] }] }));
    const stage = await deps.store.loadStage();
    await deps.store.saveStage({ ...stage, rooms: [...stage.rooms, room('p1', 'Sam', { partner: true })], cards: [{ id: 'metrics-1', kind: 'metrics', x: 0, y: 0, w: 1, h: 1 }] });
    await part.tools!.find((one) => one.name === 'propose_bet')!.run({ what: 'Post in r/SaaS', hypothesis: 'founders sign up', metric: 'signups', target: 20, check_date: '2026-10-03' }, { stage: await deps.store.loadStage(), roomId: 'marketing', store: deps.store, granted: new Map() } as never);
    const id = (await deps.attention.list()).find((one) => one.kind === 'proposed-bet')!.id.split(':')[1];
    deps.body = async () => ({ accept: true });
    await part.route!({ method: 'POST' } as never, {} as never, `/api/partner/bets/${id}`);
    const checks = async () => (await deps.store.readChat('p1')).filter((one) => one.text.startsWith('**Check the bet:**'));
    await part.tick!();
    expect(await checks()).toHaveLength(0);

    clock = new Date('2026-10-03T10:00').getTime();
    await part.tick!();
    await part.tick!();
    expect((await checks()).map((one) => one.text)).toEqual(['**Check the bet:** Post in r/SaaS. The target was 20 by 2026-10-03; now Signups is 4 (2026-09-20), read from the Metrics card. Did it work? Say so here, or in Needs you.']);
    await part.close!();
    const again = (await createPartner(options)(deps)) as Installed;
    await again.tick!();
    expect(await checks()).toHaveLength(1);

    deps.body = async () => ({ verdict: 'did-not', note: 'only 4 came' });
    await again.route!({ method: 'POST' } as never, {} as never, `/api/partner/bets/${id}/close`);
    const company = await deps.store.readDoc(companyDocOf(await deps.store.loadStage())!.id);
    const LEARNED = '- 2026-10-03: Post in r/SaaS did not work; "signups" was 4 against 20. only 4 came.';
    expect(company).toContain('- Did not work: Post in r/SaaS. Measured by "signups" on the Metrics card: was 4 against 20 (checked 2026-10-03). only 4 came.');
    expect(company).toContain(`## What we learned\n\n${LEARNED}`);
    const system = (await deps.seams.run('turn:before', { roomId: 'p1', source: 'chat', query: 'what now?', messages: [{ role: 'system', content: 'You are Sam.' }] })).messages[0].content as string;
    expect(system).toContain(`What we learned (closed bets; cite the line when advice rests on it):\n${LEARNED}`);
    await again.route!({ method: 'POST' } as never, {} as never, '/api/partner/morning');
    expect(asked.at(-1)).toContain(`What we learned (closed bets):\n${LEARNED}`);
    await again.close!();
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

// Journey 5: the verdict reached the morning note only; minutes later the partner's answers said "ship invoicing" and
// "approve the tasks waiting in Needs you" after they had been approved.
describe('the partner slice: standing facts in every partner turn', () => {
  const EVAL = '# Evaluation\n\n## 4. Founder-market fit\n\nFit 8.\n\n## 6. Verdict\n\nVerdict: WEAK\nScore: 5/10\nNext 7-day action: conduct 10 discovery conversations before writing further code.\n';
  async function setUp() {
    const { deps, part, workspace } = await installed({}, { now: () => new Date('2026-09-27T10:00').getTime(), ask: async () => SHAPED });
    await mkdir(join(workspace, 'metrics'), { recursive: true });
    await writeFile(join(workspace, 'metrics', 'metrics-1.json'), JSON.stringify({ updatedAt: 0, metrics: [{ key: 'paying_users', label: 'paying_users', unit: '', better: 'up', points: [{ at: '2026-09-27', value: 3, from: 'founder' }] }] }));
    const stage = await deps.store.loadStage();
    await deps.store.saveStage({ ...stage, rooms: [...stage.rooms, room('p1', 'Sam', { partner: true })], cards: [{ id: 'metrics-1', kind: 'metrics', x: 0, y: 0, w: 1, h: 1 }],
      docs: [...stage.docs, { id: 'eval', title: 'Evaluation', x: 0, y: 0, w: 1, h: 1, rules: { framework: 'startup-evaluation', sections: [{ heading: '4. Founder-market fit', by: 'fit' }], verdict: { heading: '6. Verdict', by: 'judge' }, outcomes: ['PIVOT REQUIRED', 'WEAK', 'STRONG'] } }] } as Stage);
    await deps.store.writeDoc('eval', EVAL);
    await part.tick!();
    const system = async (roomId: string, query = 'what do I do now?') => (await deps.seams.run('turn:before', { roomId, source: 'chat', query, messages: [{ role: 'system', content: 'You are someone.' }] })).messages[0].content as string;
    return { deps, part, system };
  }

  it('carries the team verdict into a partner turn, and not into a staff turn', async () => {
    const { part, system } = await setUp();
    const said = await system('p1');
    expect(said).toContain('Standing facts, read in code from every room just now. When one contradicts the founder\'s ask or your own advice, say so first:');
    expect(said).toMatch(/- Evaluation, 6\. Verdict: WEAK, score 5\/10\. .*before writing further code/);
    expect(said).toContain('Waiting in Needs you: nothing.');
    expect(await system('marketing')).not.toContain('Standing facts');
    await part.close!();
  });

  it('lists what waits in Needs you by kind and count, and drops it the moment it is answered', async () => {
    const { deps, part, system } = await setUp();
    await part.tools!.find((one) => one.name === 'propose_bet')!.run({ what: 'Five paying users', hypothesis: 'invoices bring two more', metric: 'paying_users', target: 5, check_date: '2026-10-11' }, { stage: await deps.store.loadStage(), roomId: 'p1', store: deps.store, granted: new Map() } as never);
    await deps.decisions.propose({ title: 'Raise the price?', options: ['$29', '$49'] });
    deps.attention.source(decisionAttention(deps.decisions));
    const before = await system('p1');
    expect(before).toContain('1 bet to take or leave ("Five paying users")');
    expect(before).toContain('1 decision to make ("Raise the price?")');
    deps.body = async () => ({ accept: true });
    const id = (await deps.attention.list()).find((one) => one.kind === 'proposed-bet')!.id.split(':')[1];
    await part.route!({ method: 'POST' } as never, {} as never, `/api/partner/bets/${id}`);
    const after = await system('p1');
    expect(after).not.toContain('bet to take');
    expect(after).toContain('Waiting in Needs you: 1 decision to make ("Raise the price?"). Nothing else waits there');
    expect(after).toMatch(/Bets on record \(the founder took each; none waits in Needs you\):\n- Open: Five paying users\./);
    await part.close!();
  });

  it('keeps a taken bet on record and out of what waits, with a second bet waiting and a stale row for the first (journey 10)', async () => {
    const { deps, part, system } = await setUp();
    const propose = async (what: string, target: number) => part.tools!.find((one) => one.name === 'propose_bet')!.run({ what, hypothesis: 'offers convert', metric: 'paying_users', target, check_date: '2026-10-31' }, { stage: await deps.store.loadStage(), roomId: 'p1', store: deps.store, granted: new Map() } as never);
    await propose('Convert 4 more beta users', 6);
    const first = (await deps.attention.list()).find((one) => one.kind === 'proposed-bet')!;
    deps.body = async () => ({ accept: true });
    await part.route!({ method: 'POST' } as never, {} as never, `/api/partner/bets/${first.id.split(':')[1]}`);
    await propose('Convert 8 more beta users', 10);
    // A Needs you row for the first bet that outlived its take: bets.json says it is taken, so it is not waiting.
    deps.attention.source(async () => [first]);
    const said = await system('p1');
    expect(said).toContain('Waiting in Needs you: 1 bet to take or leave ("Convert 8 more beta users"). Nothing else waits there');
    expect(said).toMatch(/Bets on record \(the founder took each; none waits in Needs you\):\n- Open: Convert 4 more beta users\./);
    expect(said).not.toMatch(/- Open: Convert 8 more/);
    await part.close!();
  });
});

// Program 6: "what do I do now?" was answered from one room; the reply is held to the standing facts in code.
describe('the partner slice: "what now" held to the standing facts', () => {
  it('asks the partner once more with the facts quoted when the reply names fewer than two, and labels a second miss', async () => {
    const { deps, part, workspace } = await installed({}, { now: () => new Date('2026-09-27T10:00').getTime(), ask: async () => SHAPED });
    await mkdir(join(workspace, 'metrics'), { recursive: true });
    const stage = await deps.store.loadStage();
    await deps.store.saveStage({ ...stage, rooms: [...stage.rooms, room('p1', 'Sam', { partner: true })],
      docs: [...stage.docs, { id: 'eval', title: 'Evaluation', x: 0, y: 0, w: 1, h: 1, rules: { framework: 'startup-evaluation', sections: [], verdict: { heading: '6. Verdict', by: 'judge' }, outcomes: ['PIVOT REQUIRED', 'WEAK', 'STRONG'] } }] } as Stage);
    await deps.store.writeDoc('eval', '# Evaluation\n\n## 6. Verdict\n\nVerdict: PIVOT REQUIRED\nScore: 6/10\nInterview 10 more consultants before writing further code.\n');
    const company = companyDocOf(await deps.store.loadStage())!;
    await deps.store.writeDoc(company.id, `${await deps.store.readDoc(company.id)}`.replace('## Numbers', '## Numbers\n\n- Cash: €4,200\n- Monthly burn: €1,100'));
    await part.tick!();
    const base = { tools: [], provider: 'p', model: 'm', usage: { input: 1, output: 1 }, stopped: false };
    const nudges: string[] = [];
    const reply = async (query: string, first: string, second: string, lookedAgain = false) => (await deps.seams.run('turn:reply', {
      roomId: 'p1', query, reply: { ...base, text: first }, lookedAgain,
      again: async (_first, nudge) => { nudges.push(nudge); return { ...base, text: second }; },
    })).reply.text;
    const GOOD = 'The PIVOT REQUIRED verdict comes first, and €4,200 cash buys under four months.\n\nMy call: book five interviews today.';
    expect(await reply('so what do I do right now?', 'My call: build the PDF invoicing today.', GOOD)).toBe(GOOD);
    expect(nudges).toHaveLength(1);
    expect(nudges[0]).toContain('Take another look before this goes to the founder: they asked what to do next.');
    expect(nudges[0]).toMatch(/- Evaluation, 6\. Verdict: PIVOT REQUIRED, score 6\/10/);
    expect(nudges[0]).toContain('- Cash: €4,200');
    expect(await reply('what\'s next?', 'My call: build it.', 'My call: build it now.')).toBe('My call: build it now.\n\n*Not tied to the standing facts.*');
    expect(await reply('what\'s next?', 'My call: build it.', GOOD, true)).toBe('My call: build it.\n\n*Not tied to the standing facts.*');
    expect(await reply('Write the beta update', 'Hi all.', GOOD)).toBe('Hi all.');
    expect(nudges).toHaveLength(2);
    await part.close!();
  });
});

// Journey 5: after a week, Idea, Customer and Numbers were still empty, so a new person knew neither the name nor the cash.
describe('the partner slice: the founder\'s facts kept in the Company document', () => {
  const DAY_ONE = "I'm building Ledgerly: $29/month bookkeeping for EU solo consultants that drafts VAT returns from bank feeds. "
    + 'We have 3 paying beta users; two of them asked for invoicing. I have €4,200 in the bank and burn €1,100/month. I\'m a solo technical founder. Tear it apart.';
  const reply = (text: string) => ({ text, tools: [], provider: 'p', model: 'm', usage: { input: 1, output: 1 }, stopped: false });

  it('writes the Day-1 facts into Numbers, Idea and Customer, with a receipt under the partner\'s reply', async () => {
    const { deps, part } = await installed({}, { now: () => new Date('2026-09-27T10:00').getTime(), ask: async () => SHAPED });
    await withRooms(deps, [room('p1', 'Sam', { partner: true })]);
    await part.tick!();
    const out = await deps.seams.run('turn:reply', { roomId: 'p1', query: DAY_ONE, reply: reply('Runway is short.\n\nMy call: call the three users.') });
    const doc = await deps.store.readDoc(companyDocOf(await deps.store.loadStage())!.id);
    expect(doc).toMatch(/## Idea\n\n- I'm building Ledgerly: \$29\/month bookkeeping/);
    expect(doc).toContain('- Price: $29/month (founder, 2026-09-27)');
    expect(doc).toContain('- Cash: €4,200 (founder, 2026-09-27)');
    expect(doc).toContain('- Burn: €1,100/month (founder, 2026-09-27)');
    expect(doc).toContain('- Paying beta users: 3 (founder, 2026-09-27)');
    expect(out.reply.text).toBe('Runway is short.\n\nMy call: call the three users.\n\n*Kept in the Company document: Numbers (Price $29/month, Paying beta users 3, Cash €4,200, Burn €1,100/month), Idea, Customer.*');
    // Said again, nothing new: no second write, no receipt. A staff room never writes it.
    expect((await deps.seams.run('turn:reply', { roomId: 'p1', query: DAY_ONE, reply: reply('Ok.') })).reply.text).toBe('Ok.');
    expect((await deps.seams.run('turn:reply', { roomId: 'marketing', query: 'We have 9 paying users.', reply: reply('Ok.') })).reply.text).toBe('Ok.');
    await part.close!();
  });

  it('puts a runway rounded up right against the Company numbers, in a reply and in the morning note', async () => {
    const note = 'Three moves for today:\n1. Call the three beta users.\n2. Pause the invoicing code.\n3. Log paying users.\nRisk: remaining 4 months of runway against the Evaluation verdict.\nQuestion: Will you pause coding today?';
    const { deps, part } = await installed({}, { now: () => new Date('2026-09-27T10:00').getTime(), ask: async () => note });
    await withRooms(deps, [room('p1', 'Sam', { partner: true })]);
    await part.tick!();
    await deps.seams.run('turn:reply', { roomId: 'p1', query: DAY_ONE, reply: reply('Ok.') });
    const out = await deps.seams.run('turn:reply', { roomId: 'p1', query: 'How much runway do I have?', reply: reply('You have **4 months** of runway.') });
    expect(out.reply.text).toBe('You have **4 months (3.8 months)** of runway.');
    await part.route!({ method: 'POST' } as never, {} as never, '/api/partner/morning');
    expect((await deps.store.readChat('p1')).at(-1)!.text).toContain('Risk: remaining 4 months (3.8 months) of runway against the Evaluation verdict.');
    await part.close!();
  });

  it('holds a beta-user update to what customers may read, and tells the partner so before it writes', async () => {
    const { deps, part } = await installed({}, { now: () => new Date('2026-09-27T10:00').getTime(), ask: async () => SHAPED });
    await withRooms(deps, [room('p1', 'Sam', { partner: true })]);
    await part.tick!();
    await deps.seams.run('turn:reply', { roomId: 'p1', query: DAY_ONE, reply: reply('Ok.') });
    const ask = 'Draft a short update for our 3 beta users about what we are building';
    const system = (await deps.seams.run('turn:before', { roomId: 'p1', source: 'chat', query: ask, messages: [{ role: 'system', content: 'You are Sam.' }] })).messages[0].content as string;
    expect(system).toContain('This is for the company\'s customers to read, not for investors');
    const draft = 'Hi all,\n\nWe are building PDF invoicing first [Decisions].\n\n### Numbers\n- We have €4,200 in the bank.\n\n### Asks\n- (founder to add)\n\nReady to send.';
    const out = await deps.seams.run('turn:reply', { roomId: 'p1', query: ask, reply: reply(draft) });
    expect(out.reply.text).toBe('Hi all,\n\nWe are building PDF invoicing first.\n\n### Numbers\n- We have €4,200 in the bank.\n\nNot for customers: cash. Take them out before this goes to anyone outside the company.');
    // An investor update is left as the partner wrote it.
    const investor = await deps.seams.run('turn:reply', { roomId: 'p1', query: 'help me write an investor update', reply: reply(draft) });
    expect(investor.reply.text).toBe(draft);
    await part.close!();
  });

  it('says nothing is waiting under a reply that sends the founder to an empty Needs you', async () => {
    const { deps, part } = await installed({}, { now: () => new Date('2026-09-27T10:00').getTime(), ask: async () => SHAPED });
    await withRooms(deps, [room('p1', 'Sam', { partner: true })]);
    await part.tick!();
    const out = await deps.seams.run('turn:reply', { roomId: 'p1', query: 'so what do I do right now?', reply: reply('1. Approve the task board: check your Needs you list.\n\nMy call: call the users.') });
    expect(out.reply.text).toBe('1. Approve the task board: check your Needs you list.\n\nMy call: call the users.\n\n(Nothing is waiting in Needs you.)');
    await part.close!();
  });

  it('writes nothing when the founder took the partner\'s wire to it away, and says so', async () => {
    const { deps, part } = await installed({}, { now: () => new Date('2026-09-27T10:00').getTime(), ask: async () => SHAPED });
    await withRooms(deps, [room('p1', 'Sam', { partner: true })]);
    await part.tick!();
    await deps.store.patchStage((stage) => { stage.wires = stage.wires.filter((wire) => wire.from !== 'p1'); });
    const out = await deps.seams.run('turn:reply', { roomId: 'p1', query: DAY_ONE, reply: reply('Ok.') });
    expect(out.reply.text).toBe('Ok.\n\n*Not kept: the "Company brief" document is not wired to Sam, so Numbers (Price $29/month, Paying beta users 3, Cash €4,200, Burn €1,100/month), Idea, Customer are not in it. Wire it to Sam to keep it current.*');
    expect(await deps.store.readDoc(companyDocOf(await deps.store.loadStage())!.id)).not.toContain('€4,200');
    await part.close!();
  });
});

describe('the partner slice: plans become tasks', () => {
  const PLAN = '# Flipside: 2-week plan\n\n### Mon 28 Sep (Day 1)\n- Draft the landing page\n- Set up the pre-order form\n\n### Tue 29 Sep (Day 2)\n- List 30 projects\n\n## KPIs\n- Revenue >= $150\n';

  it('offers a plan doc\'s steps once, and puts them on the board on the founder\'s yes', async () => {
    const answers: [number, unknown][] = [];
    const { deps, part } = await installed({ fake: true, json: (_res, status, body) => { answers.push([status, body]); } });
    const stage = await deps.store.loadStage();
    await deps.store.saveStage({ ...stage, docs: [...stage.docs, { id: 'doc-plan', title: 'Two weeks', x: 0, y: 0, w: 1, h: 1 }, { id: 'doc-notes', title: 'Notes', x: 0, y: 0, w: 1, h: 1 }], cards: [{ id: 'board-1', kind: 'board', x: 0, y: 0, w: 1, h: 1 }] });
    await deps.store.writeDoc('doc-plan', PLAN);
    await deps.store.writeDoc('doc-notes', '# Notes\n\n### Mon 28 Sep\n- a\n- b\n');
    const wrote = (id: string, kind: 'doc-created' | 'doc-changed' = 'doc-changed') => deps.seams.run('tool:after', { roomId: 'marketing', event: { id: 'e', name: 'write_doc', args: {}, ok: true, effect: kind === 'doc-created' ? { kind, id, title: 'x' } : { kind, id } } });
    await wrote('doc-notes');
    await wrote('doc-plan', 'doc-created');
    await wrote('doc-plan');
    const offered = (await deps.attention.list()).filter((one) => one.kind === 'proposed-plan');
    expect(offered).toHaveLength(1);
    expect(offered[0]).toMatchObject({ who: 'Maya', roomId: 'marketing', title: 'Add these 3 tasks to the board? (Two weeks)' });
    deps.body = async () => ({ accept: true });
    await part.route!({ method: 'POST' } as never, {} as never, `/api/partner/plans/${offered[0].id.split(':')[1]}`);
    expect(answers.at(-1)).toEqual([200, { ok: true, boardId: 'board-1', added: 3 }]);
    expect((await deps.boards.list('board-1')).map((task) => task.title)).toEqual(['Draft the landing page', 'Set up the pre-order form', 'List 30 projects']);
    expect((await deps.attention.list()).some((one) => one.kind === 'proposed-plan')).toBe(false);
    // The same steps written again are not asked again; changed steps are.
    await wrote('doc-plan');
    expect((await deps.attention.list()).some((one) => one.kind === 'proposed-plan')).toBe(false);
    await deps.store.writeDoc('doc-plan', `${PLAN}\n### Wed 30 Sep (Day 3)\n- Post in r/SaaS\n`);
    await wrote('doc-plan');
    // After the yes, one step added is offered alone, and a second yes never puts the old ones on the board twice.
    const again = (await deps.attention.list()).find((one) => one.kind === 'proposed-plan')!;
    expect(again).toMatchObject({ title: 'Add this task to the board? (Two weeks)', detail: 'Wed 30 Sep (Day 3): Post in r/SaaS.' });
    await part.route!({ method: 'POST' } as never, {} as never, `/api/partner/plans/${again.id.split(':')[1]}`);
    const titles = (await deps.boards.list('board-1')).map((task) => task.title);
    expect(titles).toHaveLength(4);
    expect(new Set(titles).size).toBe(4);
    await part.close!();
  });

  it('says there is no board rather than failing quietly, and makes one wired to the writer when asked', async () => {
    const answers: [number, unknown][] = [];
    const { deps, part } = await installed({ fake: true, json: (_res, status, body) => { answers.push([status, body]); } });
    const stage = await deps.store.loadStage();
    await deps.store.saveStage({ ...stage, docs: [...stage.docs, { id: 'doc-plan', title: 'Two weeks', x: 0, y: 0, w: 1, h: 1 }] });
    await deps.store.writeDoc('doc-plan', '# Two-week plan\n\n### Mon 28 Sep\n- Draft the page\n- Set up the form\n');
    await deps.seams.run('tool:after', { roomId: 'marketing', event: { id: 'e', name: 'write_doc', args: {}, ok: true, effect: { kind: 'doc-changed', id: 'doc-plan' } } });
    const id = (await deps.attention.list()).find((one) => one.kind === 'proposed-plan')!.id.split(':')[1];
    deps.body = async () => ({ accept: true });
    await part.route!({ method: 'POST' } as never, {} as never, `/api/partner/plans/${id}`);
    expect(answers.at(-1)).toEqual([409, { error: 'There is no task board on the stage yet.', noBoard: true }]);
    expect((await deps.attention.list()).some((one) => one.kind === 'proposed-plan')).toBe(true);
    deps.body = async () => ({ accept: true, makeBoard: true });
    await part.route!({ method: 'POST' } as never, {} as never, `/api/partner/plans/${id}`);
    const after = await deps.store.loadStage();
    const board = after.cards!.find((card) => card.kind === 'board')!;
    expect(after.wires.some((wire) => wire.from === 'marketing' && wire.to === board.id)).toBe(true);
    expect(answers.at(-1)).toEqual([200, { ok: true, boardId: board.id, added: 2 }]);
    expect((await deps.boards.list(board.id))).toHaveLength(2);
    await part.close!();
  });

  it('offers steps a person hands over with propose_tasks, only with a board on the stage', async () => {
    const { deps, part } = await installed({ fake: true });
    const tool = part.tools!.find((one) => one.name === 'propose_tasks')!;
    const stage = await deps.store.loadStage();
    expect(part.offer!(part.tools!, stage, 'marketing').map((one) => one.name)).not.toContain('propose_tasks');
    const withBoard = { ...stage, cards: [{ id: 'board-1', kind: 'board' as const, x: 0, y: 0, w: 1, h: 1 }] };
    expect(part.offer!(part.tools!, withBoard, 'marketing').map((one) => one.name)).toContain('propose_tasks');
    await expect(tool.run({ title: 'x', steps: ['one'] }, { stage: withBoard, roomId: 'marketing' } as never)).rejects.toThrow('two or more');
    const said = await tool.run({ title: 'Launch week', steps: ['Day 1: ship', 'Day 2: post'] }, { stage: withBoard, roomId: 'marketing' } as never);
    expect(said.text).toContain('Offered 2 tasks');
    expect((await deps.attention.list()).find((one) => one.kind === 'proposed-plan')?.detail).toBe('Day 1: ship; Day 2: post.');
    await part.close!();
  });
});

// Program 6: "I'll call five users by Friday" was gone the moment it was said. A co-founder remembers it, brings it up
// on the day, asks once when it is late, and lets the founder close it.
describe('the partner slice: the founder\'s promises', () => {
  it('keeps a promise said in any room, brings it to Needs you and Today\'s five on its day, chases it once, and lets the founder close it', async () => {
    let clock = new Date('2026-09-28T10:00').getTime();
    const told: string[] = [];
    const { deps, part } = await installed({ notify: (title) => { told.push(title); }, json: () => {} }, { now: () => clock, ask: async () => SHAPED });
    await withRooms(deps, [room('p1', 'Sam', { partner: true })]);
    const reply = async (roomId: string, query: string, stopped = false) => (await deps.seams.run('turn:reply', { roomId, query, reply: { text: 'Good.', tools: [], provider: '', model: '', usage: { input: 0, output: 0 }, stopped } })).reply.text;
    expect(await reply('marketing', 'OK. I\'ll call 5 beta users by Friday.')).toBe('Good.\n\n*Kept as a promise: call 5 beta users by Friday (due 2026-10-02). It comes to Needs you on the day.*');
    expect(await reply('marketing', 'I\'ll call 5 beta users by Friday.')).toBe('Good.');
    expect(await reply('marketing', 'I\'ll email the bank tomorrow.', true)).toBe('Good.');
    expect(await reply('marketing', 'Should I raise the price this week?')).toBe('Good.');
    expect((await deps.attention.list()).some((one) => one.kind === 'promise')).toBe(false);
    const system = async () => (await deps.seams.run('turn:before', { roomId: 'p1', source: 'chat', query: 'what now?', messages: [{ role: 'system', content: 'You are Sam.' }] })).messages[0].content as string;
    expect(await system()).toContain('The founder\'s promises:\n- call 5 beta users by Friday (due 2026-10-02)');

    clock = new Date('2026-10-02T10:00').getTime();
    await part.tick!();
    const due = (await deps.attention.list()).find((one) => one.kind === 'promise')!;
    expect(due).toMatchObject({ title: 'You said you would call 5 beta users by Friday', detail: 'Due today. Said on 2026-09-28.', roomId: 'marketing' });
    expect((await todayFive(deps, clock)).find((one) => one.kind === 'promise')).toMatchObject({ reason: expect.stringContaining('Something you said you would do') });
    const chases = async () => (await deps.store.readChat('p1')).filter((one) => one.text.startsWith('You said you would'));
    expect(await chases()).toHaveLength(0);

    clock = new Date('2026-10-03T10:00').getTime();
    await part.tick!();
    await part.tick!();
    expect((await chases()).map((one) => one.text)).toEqual(['You said you would call 5 beta users by Friday (due 2026-10-02). Done? Close it in Needs you, or tell me what got in the way.']);
    expect(told.filter((one) => one === 'A promise is late')).toHaveLength(1);

    deps.body = async () => ({ done: true });
    await part.route!({ method: 'POST' } as never, {} as never, `/api/partner/promises/${due.id.split(':')[1]}`);
    expect((await deps.attention.list()).some((one) => one.kind === 'promise')).toBe(false);
    expect(await system()).not.toContain('The founder\'s promises');
    await part.close!();
  });
});

describe('the partner slice: a promises book that cannot be read', () => {
  it('still saves the founder\'s reply, and only leaves out the receipt line', async () => {
    const { deps, part } = await installed({ json: () => {} }, { now: () => new Date('2026-09-28T10:00').getTime(), ask: async () => SHAPED });
    await withRooms(deps, [room('p1', 'Sam', { partner: true })]);
    // A folder where the file should be: every read of it fails, and it is not a damaged file to rescue.
    await mkdir(join(deps.workspace, 'promises.json'), { recursive: true });
    const quiet = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const out = await deps.seams.run('turn:reply', { roomId: 'marketing', query: 'OK. I\'ll call 5 beta users by Friday.', reply: { text: 'Good.', tools: [], provider: '', model: '', usage: { input: 0, output: 0 }, stopped: false } });
      expect(out.reply.text).toBe('Good.');
      expect(quiet.mock.calls.some(([line]) => String(line).includes('could not keep'))).toBe(true);
    } finally { quiet.mockRestore(); await part.close!(); }
  });
});

// Journey 11: the verdict named no kill signal and no day. It is asked for in four lines and held to them in code.
describe('the partner slice: a verdict that commits', () => {
  it('asks for the shape, keeps the call, and puts the kill signal in Needs you for its day', async () => {
    const { deps, part, workspace } = await installed({}, { now: () => new Date('2026-10-06T10:00').getTime(), ask: async () => SHAPED });
    await withRooms(deps, [room('p1', 'Sam', { partner: true }), room('r1', 'Nadia')]);
    await part.tick!();
    const company = companyDocOf(await deps.store.loadStage())!;
    await deps.store.writeDoc(company.id, `${await deps.store.readDoc(company.id)}`.replace('## Numbers', '## Numbers\n\n- Beta users: 12 (2 paying)\n- Price: €39 a month'));
    const system = async (roomId: string) => (await deps.seams.run('turn:before', { roomId, source: 'chat', query: 'Your verdict: keep going or stop?', messages: [{ role: 'system', content: 'You are someone.' }] })).messages[0].content as string;
    expect(await system('p1')).toContain('Kill signal: one number the founder can measure');
    expect(await system('r1')).not.toContain('Kill signal');
    const base = { tools: [], provider: 'p', model: 'm', usage: { input: 1, output: 1 }, stopped: false };
    const nudges: string[] = [];
    const out = (await deps.seams.run('turn:reply', {
      roomId: 'p1', query: 'Your verdict: keep going or stop?', reply: { ...base, text: 'My call: keep going.\nWhy: 2 of 12 beta users pay €39.\nThis week: ask the 10 free users to pay.' },
      again: async (_first, nudge) => { nudges.push(nudge); return { ...base, text: 'Kill signal: 6 paying users by 2026-11-03; if not, change course.' }; },
    })).reply.text;
    expect(nudges).toHaveLength(1);
    expect(out).toBe('My call: **keep going**.\nWhy: 2 of 12 beta users pay €39.\nKill signal: 6 paying users by 2026-11-03; if not, change course.\nThis week: ask the 10 free users to pay.\n\n*Kept as a check: it comes to Needs you on 2026-11-03.*');
    expect((await partnerState(workspace).read()).call).toMatchObject({ decision: 'keep going', signal: { what: '6 paying users', by: '2026-11-03' }, day: '2026-10-06', roomId: 'p1' });
    // Not in Needs you before its day.
    expect((await deps.attention.list()).some((one) => one.title.startsWith('Check:'))).toBe(false);
    const [check] = (await promisesBook(workspace).list()).filter((one) => one.check);
    expect(promisesAttention([check], '2026-11-03')[0]).toMatchObject({ kind: 'promise', title: 'Check: 6 paying users by 2026-11-03?', roomId: 'p1' });
    await part.close!();
  });
});
