import { mkdtemp, readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Lead, LeadsEvent } from '../../shared/leads.ts';
import { leadsCsv } from '../../shared/leads.ts';
import { hub } from '../events.ts';
import type { Deps } from '../install.ts';
import { createSeams } from '../seams.ts';
import { createStore } from '../store.ts';
import type { Tool, ToolContext } from '../tools/registry.ts';
import leads, { LEAD_TOOLS } from './leads.ts';

// The slice in fake mode on a throwaway workspace: a real store, a Leads card wired to Maya, the made-up OpenOutreach.
async function setup() {
  const workspace = await mkdtemp(join(tmpdir(), 'leads-slice-'));
  const store = createStore(workspace);
  const stage = await store.loadStage();
  stage.cards = [{ id: 'leads-1', kind: 'leads', x: 0, y: 0, w: 1, h: 1 }];
  stage.wires.push({ id: 'w', from: 'marketing', fromHandle: 'r', to: 'leads-1', toHandle: 'l' });
  await store.saveStage(stage);
  const seams = createSeams();
  const answered: { status: number; body: any }[] = [];
  let sent: unknown = {};
  const deps = {
    workspace, root: workspace, fake: true, store, seams,
    json: (_res: ServerResponse, status: number, body: unknown) => { answered.push({ status, body }); },
    body: async () => sent,
  } as unknown as Deps;
  const heard: { channel: string; data: LeadsEvent }[] = [];
  hub.say = (channel, data) => heard.push({ channel, data: data as LeadsEvent });
  const part = await leads.install(deps);
  const tool = (name: string) => part.tools!.find((one) => one.name === name)!;
  const context = async (roomId = 'marketing'): Promise<ToolContext> => ({ stage: await store.loadStage(), roomId, store, granted: new Map() });
  const use = async (name: string, args: Record<string, unknown>) => tool(name).run(args, await context());
  const call = async (path: string, method = 'GET', body: unknown = {}) => { sent = body; await part.route!({ method } as IncomingMessage, {} as ServerResponse, path); return answered.at(-1)!; };
  const list = async () => ((await call('/api/leads/leads-1')).body as LeadsEvent).leads;
  return { part, store, seams, heard, tool, use, call, list, workspace };
}

let closing: (() => Promise<void>) | undefined;
afterEach(async () => { await closing?.(); closing = undefined; });

describe('the Leads card', () => {
  it('is offered only to a person wired to one', async () => {
    const { part, store } = await setup();
    closing = part.close;
    const stage = await store.loadStage();
    const names = (roomId: string) => part.offer!(part.tools!, stage, roomId).map((one: Tool) => one.name);
    expect(names('marketing')).toEqual(LEAD_TOOLS);
    expect(names('build')).toEqual([]);
  });

  it('adds a lead once, however it is typed, and says when one is already here', async () => {
    const { part, use, list, heard, workspace } = await setup();
    closing = part.close;
    expect((await use('add_lead', { person: 'Ada Lovelace', company: 'Engines Ltd', why: 'Posted about planning pain' })).text).toBe('Added Ada Lovelace at Engines Ltd.');
    expect((await use('add_lead', { person: '  ada   lovelace ', company: 'ENGINES LTD' })).text).toBe('Ada Lovelace at Engines Ltd is already here, in New.');
    const [lead] = await list();
    expect(lead).toMatchObject({ stage: 'new', source: 'person', notes: [{ by: 'Maya', text: 'Posted about planning pain' }] });
    expect(heard.at(-1)).toMatchObject({ channel: 'leads:leads-1', data: { leads: [{ id: lead.id }] } });
    // Every change says a newer revision than the one before, so a card never keeps an older list over a newer one.
    const revs = heard.map((one) => one.data.rev);
    expect(revs.every((rev, index) => index === 0 || rev > revs[index - 1])).toBe(true);
    await part.close!();
    closing = undefined;
    expect(JSON.parse(await readFile(join(workspace, 'leads', 'leads-1.json'), 'utf8'))).toHaveLength(1);
  });

  it('scores, notes and moves a lead by name, and a good score takes a new one to Fit', async () => {
    const { part, use, list } = await setup();
    closing = part.close;
    await use('add_lead', { person: 'Ada Lovelace', company: 'Engines Ltd' });
    await use('add_lead', { person: 'Charles Babbage', company: 'Engines Ltd' });
    expect((await use('score_lead', { lead: 'Ada Lovelace', score: 8.4, why: 'Buyer; asked for this on LinkedIn' })).text).toBe('Scored Ada Lovelace at Engines Ltd 8/10. Now in Fit.');
    expect((await use('score_lead', { lead: 'charles babbage at engines ltd', score: 4, why: 'Not the buyer' })).text).toContain('Now in New.');
    await expect(use('note_lead', { lead: 'Engines', text: 'x' })).rejects.toThrow('could be Ada Lovelace at Engines Ltd, Charles Babbage at Engines Ltd');
    expect((await use('note_lead', { lead: 'Ada', text: 'Met at the meetup' })).text).toBe('Noted on Ada Lovelace at Engines Ltd.');
    expect((await use('move_lead', { lead: 'Ada Lovelace', stage: 'meeting' })).text).toBe('Moved Ada Lovelace at Engines Ltd to Meeting.');
    const listed = (await use('list_leads', { stage: 'meeting' })).text;
    expect(listed).toMatch(/^- \[meeting\] Ada Lovelace at Engines Ltd · fit 8\/10 · added .+ · last note .+: Met at the meetup$/);
    expect((await use('list_leads', { stage: 'customer' })).text).toBe('No leads in Customer.');
    expect((await list()).find((one) => one.person.name === 'Ada Lovelace')?.fit).toMatchObject({ score: 8, why: 'Buyer; asked for this on LinkedIn' });
  });

  it('leaves contacted to the founder', async () => {
    const { part, use, call, list } = await setup();
    closing = part.close;
    await use('add_lead', { person: 'Ada Lovelace', company: 'Engines Ltd' });
    await expect(use('move_lead', { lead: 'Ada Lovelace', stage: 'contacted' })).rejects.toThrow('only the founder marks a lead contacted');
    const [lead] = await list();
    expect((await call(`/api/leads/leads-1/${lead.id}`, 'PATCH', { stage: 'contacted' })).status).toBe(200);
    expect((await list())[0].stage).toBe('contacted');
  });

  it('leaves a lead alone when an email went to somebody else, or was refused', async () => {
    const { part, seams, list, call } = await setup();
    closing = part.close;
    await call('/api/leads/leads-1', 'POST', { name: 'Jonas Berg', company: 'Fjordly' });
    await seams.run('tool:after', { roomId: 'marketing', event: { id: 'c', name: 'send_email', args: { to: 'someone@else.example', subject: 'Hi' }, ok: true } });
    await seams.run('tool:after', { roomId: 'marketing', event: { id: 'd', name: 'send_email', args: { to: 'jonas@fjordly.example', subject: 'Hi' }, ok: false } });
    expect((await list())[0].stage).toBe('new');
  });

  it('finds leads with OpenOutreach after asking, adds only the new ones, and never names a score', async () => {
    const { part, tool, use, list, seams } = await setup();
    closing = part.close;
    const find = tool('find_leads');
    expect(find.ready!()).toBeNull();
    const approval = find.approval as (args: Record<string, unknown>) => Promise<string>;
    expect(await approval({ count: 10 })).toBe('Find 10 leads with OpenOutreach? Plain finding spends nothing; verified emails cost 1 credit each (40 free).');
    expect(await approval({ count: 400, emails: true })).toContain('Find 25 leads');
    expect((await use('find_leads', { count: 3 })).text).toBe('3 new leads on the card. Next: score them with score_lead.');
    expect((await use('find_leads', { count: 3 })).text).toBe('0 new leads on the card, 3 already there.');
    const found = await list();
    expect(found.map((one) => one.source)).toEqual(['openoutreach', 'openoutreach', 'openoutreach']);
    expect(found.every((one) => !one.fit && one.stage === 'new')).toBe(true);
    expect(found[0].notes[0].text).toMatch(/^Why it picked them: /);
    // The founder then says yes to an email to one of them: that lead is contacted, the others are not.
    await seams.run('tool:after', { roomId: 'marketing', event: { id: 'c', name: 'send_email', args: { to: 'Jonas@Fjordly.example', subject: 'A quick one' }, ok: true } });
    const after = await list();
    expect(after.find((one) => one.person.name === 'Jonas Berg')).toMatchObject({ stage: 'contacted', notes: [{}, { by: 'Founder', text: 'Emailed: "A quick one".' }] });
    expect(after.filter((one) => one.stage === 'contacted')).toHaveLength(1);
  });

  it('tells a wired person the card is there, and nobody else', async () => {
    const { part, seams } = await setup();
    closing = part.close;
    const system = (roomId: string) => seams.run('turn:before', { roomId, source: 'chat' as never, query: 'hi', messages: [{ role: 'system', content: 'You are Maya.' }] });
    expect((await system('marketing')).messages[0].content).toContain('A Leads card');
    expect((await system('build')).messages[0].content).toBe('You are Maya.');
  });
});

describe('the founder\'s own changes', () => {
  it('adds by hand, refuses a second copy, notes, deletes, and knows only cards on the stage', async () => {
    const { part, call, list } = await setup();
    closing = part.close;
    expect((await call('/api/leads/leads-1', 'POST', { name: 'Ada Lovelace', company: 'Engines Ltd', line: 'Met at the meetup' })).body).toMatchObject({ source: 'founder', notes: [{ by: 'Founder', text: 'Met at the meetup' }] });
    expect(await call('/api/leads/leads-1', 'POST', { name: 'ada lovelace', company: 'engines ltd' })).toEqual({ status: 409, body: { error: 'Ada Lovelace at Engines Ltd is already here' } });
    expect((await call('/api/leads/leads-1', 'POST', { name: 'Ada', company: '' })).status).toBe(400);
    const [lead] = await list();
    expect((await call(`/api/leads/leads-1/${lead.id}/notes`, 'POST', { text: 'Replied on Tuesday' })).body.notes).toHaveLength(2);
    expect((await call(`/api/leads/leads-1/${lead.id}`, 'PATCH', { stage: 'won' })).status).toBe(400);
    await call(`/api/leads/leads-1/${lead.id}`, 'DELETE');
    expect(await list()).toEqual([]);
    expect((await call('/api/leads/leads-2')).status).toBe(404);
  });

  it('copies as a spreadsheet that keeps commas and quotes inside their cells', () => {
    const lead: Lead = { id: 'lead-1', person: { name: 'Ada "the Countess" Lovelace', email: 'ada@x.example' }, company: { name: 'Engines, Ltd' }, stage: 'fit', fit: { score: 8, why: 'Buyer', at: 0 }, notes: [{ at: 0, by: 'Maya', text: 'Line one' }], source: 'person', addedAt: 0, updatedAt: 0 };
    expect(leadsCsv([lead])).toBe('name,title,company,website,size,linkedin_url,email,stage,fit,fit_why,source,added,notes\n"Ada ""the Countess"" Lovelace",,"Engines, Ltd",,,,ada@x.example,fit,8,Buyer,person,1970-01-01,1970-01-01 Maya: Line one\n');
  });
});
