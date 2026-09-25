import { mkdtemp, readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { monthOf, todayOf, type RunwayEvent } from '../../shared/runway.ts';
import { createAttention } from '../attention.ts';
import { hub } from '../events.ts';
import type { Deps } from '../install.ts';
import { createSeams } from '../seams.ts';
import { createStore } from '../store.ts';
import type { Tool, ToolContext } from '../tools/registry.ts';
import runway, { RUNWAY_TOOLS } from './runway.ts';

const today = todayOf(Date.now());
const month = monthOf(today);

// The slice on a throwaway workspace: a real store and a real Needs you, a Runway card wired to Maya.
async function setup() {
  const workspace = await mkdtemp(join(tmpdir(), 'runway-slice-'));
  const store = createStore(workspace);
  const stage = await store.loadStage();
  stage.cards = [{ id: 'runway-1', kind: 'runway', x: 0, y: 0, w: 1, h: 1 }];
  stage.wires.push({ id: 'w', from: 'marketing', fromHandle: 'r', to: 'runway-1', toHandle: 'l' });
  await store.saveStage(stage);
  const seams = createSeams();
  const attention = createAttention(workspace);
  const answered: { status: number; body: any }[] = [];
  let sent: unknown = {};
  const deps = {
    workspace, root: workspace, fake: true, store, seams, attention,
    json: (_res: ServerResponse, status: number, body: unknown) => { answered.push({ status, body }); },
    body: async () => sent,
  } as unknown as Deps;
  const heard: { channel: string; data: RunwayEvent }[] = [];
  hub.say = (channel, data) => heard.push({ channel, data: data as RunwayEvent });
  const part = await runway.install(deps);
  const tool = (name: string) => part.tools!.find((one) => one.name === name)!;
  const context = async (roomId = 'marketing'): Promise<ToolContext> => ({ stage: await store.loadStage(), roomId, store, granted: new Map() });
  const use = async (name: string, args: Record<string, unknown>, roomId?: string) => tool(name).run(args, await context(roomId));
  const call = async (path: string, method = 'GET', body: unknown = {}) => { sent = body; await part.route!({ method } as IncomingMessage, {} as ServerResponse, path); return answered.at(-1)!; };
  const read = async () => (await call('/api/runway/runway-1')).body as RunwayEvent;
  const system = (roomId: string) => seams.run('turn:before', { roomId, source: 'chat' as never, query: 'hi', messages: [{ role: 'system', content: 'You are Maya.' }] }).then((payload) => payload.messages[0].content as string);
  return { part, store, heard, use, call, read, system, attention, workspace };
}

const numbers = { cash: { amount: 120_000, asOf: today }, flows: [{ id: 'team', label: 'Team', monthly: -10_000, from: month, category: 'people' }, { id: 'sales', label: 'Sales', monthly: 2000, from: month }], scenarios: [] };

let closing: (() => Promise<void>) | undefined;
afterEach(async () => { await closing?.(); closing = undefined; });

describe('the Runway card', () => {
  it('is offered only to a person wired to one, and only they read its line', async () => {
    const { part, store, call, system } = await setup();
    closing = part.close;
    const stage = await store.loadStage();
    const names = (roomId: string) => part.offer!(part.tools!, stage, roomId).map((one: Tool) => one.name);
    expect(names('marketing')).toEqual(RUNWAY_TOOLS);
    expect(names('build')).toEqual([]);
    expect(await system('marketing')).toContain('A Runway card, still empty.');
    await call('/api/runway/runway-1', 'PUT', numbers);
    const line = await system('marketing');
    expect(line).toContain('Cash $120,000 on');
    expect(line).toContain('Burn $10,000 a month (people $10,000). Revenue $2,000 a month.');
    expect(line).toMatch(/\d+\.\d months left, cash out \d{4}-\d{2}\. As of \d{4}-\d{2}-\d{2}\.$/);
    expect(await system('build')).toBe('You are Maya.');
  });

  it('keeps the founder\'s numbers in the sidecar and refuses ones that do not read', async () => {
    const { part, call, heard, workspace } = await setup();
    closing = part.close;
    const saved = await call('/api/runway/runway-1', 'PUT', numbers);
    expect(saved.status).toBe(200);
    expect(heard.at(-1)!.channel).toBe('runway:runway-1');
    await part.close!();
    const file = JSON.parse(await readFile(join(workspace, 'runway', 'runway-1.json'), 'utf8'));
    expect(file.flows.map((one: { label: string }) => one.label)).toEqual(['Team', 'Sales']);
    expect((await call('/api/runway/runway-1', 'PUT', { ...numbers, flows: [{ label: 'x', monthly: 'lots' }] })).status).toBe(400);
    expect((await call('/api/runway/nope')).status).toBe(404);
  });

  it('reads Base or a named scenario for a person', async () => {
    const { part, call, use } = await setup();
    closing = part.close;
    await call('/api/runway/runway-1', 'PUT', { ...numbers, scenarios: [{ id: 'lost', name: 'Lose Sales', changes: [{ drop: 'sales' }] }] });
    expect((await use('read_runway', {})).text).toMatch(/^Base: cash \$120,000 on .*\n.*Flows:\n- Team: -\$10,000 a month/s);
    expect((await use('read_runway', { scenario: 'lose sales' })).text).toContain('Scenario "Lose Sales"');
    await expect(use('read_runway', { scenario: 'Moon' })).rejects.toThrow(/no scenario called "Moon"/);
  });

  it('puts a suggested flow in Needs you, and it counts only once the founder accepts it', async () => {
    const { part, call, use, read, attention } = await setup();
    closing = part.close;
    await call('/api/runway/runway-1', 'PUT', numbers);
    const said = await use('propose_flow', { label: 'Engineer', monthly: -9000, from: '2027-01', category: 'people', why: 'The build plan needs one' });
    expect(said.text).toBe('Suggested "Engineer", -$9,000 a month from 2027-01. It waits in Needs you until the founder accepts it on the card.');
    const [waiting] = (await attention.list()).filter((one) => one.kind === 'proposed-runway');
    expect(waiting).toMatchObject({ cardId: 'runway-1', who: 'Maya', roomId: 'marketing', title: '"Engineer", -$9,000 a month from 2027-01' });
    expect((await read()).runway.flows).toHaveLength(2);
    const proposal = (await read()).proposals[0];
    const accepted = await call(`/api/runway/runway-1/proposals/${proposal.id}`, 'POST');
    expect(accepted.body.runway.flows.map((one: { label: string }) => one.label)).toEqual(['Team', 'Sales', 'Engineer']);
    expect(accepted.body.proposals).toEqual([]);
    expect((await attention.list()).some((one) => one.kind === 'proposed-runway')).toBe(false);
  });

  it('takes a suggested scenario, naming Base flows by label, and keeps to three', async () => {
    const { part, call, use, read } = await setup();
    closing = part.close;
    await call('/api/runway/runway-1', 'PUT', numbers);
    await expect(use('propose_scenario', { name: 'Ghost', drop: ['Nope'] })).rejects.toThrow(/no Base flow called "Nope"/);
    const said = await use('propose_scenario', { name: 'Raise in March', drop: ['sales'], cash: [{ amount: 500_000, at: '2027-03' }] });
    expect(said.text).toContain('the scenario "Raise in March" (drops "Sales"; brings in $500,000 in 2027-03)');
    const { proposals } = await read();
    await call(`/api/runway/runway-1/proposals/${proposals[0].id}`, 'POST');
    const [scenario] = (await read()).runway.scenarios;
    expect(scenario).toMatchObject({ name: 'Raise in March', changes: [{ drop: 'sales' }, { cash: 500_000, at: '2027-03' }] });
    // A flow suggested into that scenario lands there, not in Base.
    await use('propose_flow', { label: 'Hire', monthly: -5000, from: '2027-04', scenario: 'raise in march' });
    await call(`/api/runway/runway-1/proposals/${(await read()).proposals[0].id}`, 'POST');
    expect((await read()).runway.scenarios[0].changes.at(-1)).toMatchObject({ add: { label: 'Hire' } });
    expect((await read()).runway.flows).toHaveLength(2);
    // Declining lets it go.
    await use('propose_scenario', { name: 'Two', cash: [{ amount: 1, at: '2027-01' }] });
    await call(`/api/runway/runway-1/proposals/${(await read()).proposals[0].id}`, 'DELETE');
    expect((await read()).proposals).toEqual([]);
    await call('/api/runway/runway-1', 'PUT', { ...(await read()).runway, scenarios: [...(await read()).runway.scenarios, { name: 'B', changes: [] }, { name: 'C', changes: [] }] });
    await expect(use('propose_scenario', { name: 'Four', cash: [{ amount: 1, at: '2027-01' }] })).rejects.toThrow(/already has 3 scenarios/);
  });

  it('raises runway-low once a threshold, lets the founder mark it seen, and clears it when cash recovers', async () => {
    const { part, call, read, attention } = await setup();
    closing = part.close;
    const short = (amount: number) => ({ cash: { amount, asOf: today }, flows: [{ label: 'Team', monthly: -10_000, from: month }], scenarios: [] });
    await call('/api/runway/runway-1', 'PUT', short(25_000));
    await part.tick!();
    const first = (await read()).alert!;
    expect(first.level).toBe(3);
    await part.tick!();
    expect((await read()).alert).toEqual(first);
    const low = (await attention.list()).filter((one) => one.kind === 'runway-low');
    expect(low).toHaveLength(1);
    expect(low[0].title).toMatch(/^Cash runs out in \d\.\d months?$/);
    // Better, but still under six: amber, and nothing new is raised.
    await call('/api/runway/runway-1', 'PUT', short(50_000));
    expect((await read()).alert).toEqual({ ...first, level: 6 });
    await call('/api/runway/runway-1/seen', 'POST');
    expect((await attention.list()).some((one) => one.kind === 'runway-low')).toBe(false);
    // Worse again: a new crossing, raised again.
    await call('/api/runway/runway-1', 'PUT', short(20_000));
    expect((await read()).alert).toMatchObject({ level: 3 });
    expect((await read()).alert!.seen).toBeUndefined();
    await call('/api/runway/runway-1', 'PUT', short(500_000));
    expect((await read()).alert).toBeUndefined();
  });
});
