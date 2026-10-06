import { mkdtemp } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Lead } from '../../shared/leads.ts';
import { readingOf, saysPaying, stageAfter } from '../../shared/leads-thread.ts';
import { draftId } from '../../shared/maildraft.ts';
import { createAttention } from '../attention.ts';
import { createBoards } from '../boards.ts';
import { localDay } from '../clock.ts';
import { hub } from '../events.ts';
import type { Deps } from '../install.ts';
import type { Received } from '../mail.ts';
import { metricsFor } from '../metrics/store.ts';
import { healthRows } from '../openends/health.ts';
import { createSeams } from '../seams.ts';
import { createStore } from '../store.ts';
import leads from './leads.ts';
import { BY_HAND, POLL_EVERY, threadSlice } from './leads-thread.ts';

const DAY = 86_400_000;
// A morning in the founder's own zone, so "the day after" is a calendar day here whatever the machine's zone.
const MONDAY = new Date(2026, 9, 5, 9, 0).getTime();

// A mailbox that holds what the test puts in it, and says who asked to read it.
function fixtureInbox(keyed = true) {
  const messages: Received[] = [];
  const asked: string[] = [];
  return {
    messages, asked,
    mail: { ways: () => ({ agentmail: keyed, gmail: false }), async received(roomId: string) { asked.push(roomId); return { address: `${roomId}@agentmail.test`, messages: [...messages] }; } },
  };
}

// Both slices on a throwaway workspace: a Leads card wired to Maya (marketing), a board and a Metrics card on the
// stage, a clock the test moves, and a mailbox the test fills.
async function setup(options: { keyed?: boolean; metrics?: boolean; board?: boolean } = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'lead-thread-'));
  const store = createStore(workspace);
  const stage = await store.loadStage();
  stage.cards = [
    { id: 'leads-1', kind: 'leads', x: 0, y: 0, w: 1, h: 1 },
    ...(options.board === false ? [] : [{ id: 'board-1', kind: 'board' as const, x: 0, y: 0, w: 1, h: 1 }]),
    ...(options.metrics === false ? [] : [{ id: 'metrics-1', kind: 'metrics' as const, x: 0, y: 0, w: 1, h: 1 }]),
  ] as typeof stage.cards;
  stage.wires.push({ id: 'w', from: 'marketing', fromHandle: 'r', to: 'leads-1', toHandle: 'l' });
  await store.saveStage(stage);
  const seams = createSeams();
  const attention = createAttention(workspace);
  const boards = createBoards(workspace);
  const answered: { status: number; body: any }[] = [];
  let sent: unknown = {};
  const deps = {
    workspace, root: workspace, fake: true, store, seams, attention, boards,
    json: (_res: ServerResponse, status: number, body: unknown) => { answered.push({ status, body }); },
    body: async () => sent,
  } as unknown as Deps;
  hub.say = () => true;
  const clock = { at: MONDAY };
  const inbox = fixtureInbox(options.keyed ?? true);
  const card = await leads.install(deps);
  const part = await threadSlice({ mail: () => inbox.mail, now: () => clock.at }).install(deps);
  const call = async (path: string, body: unknown = {}, method = 'POST') => {
    sent = body;
    for (const one of [card, part]) if (await one.route!({ method } as IncomingMessage, {} as ServerResponse, path)) return answered.at(-1)!;
    throw new Error(`nobody answered ${path}`);
  };
  const list = async () => (await call('/api/leads/leads-1', {}, 'GET')).body.leads as Lead[];
  const add = async (name: string, email?: string) => (await call('/api/leads/leads-1', { name, company: `${name} Co`, ...(email ? { email } : {}) })).body as Lead;
  const lead = async (id: string) => (await list()).find((one) => one.id === id)!;
  const needs = async () => attention.list();
  return { part, card, seams, call, list, add, lead, needs, clock, inbox, boards, workspace, close: async () => { await part.close?.(); await card.close?.(); } };
}

let closing: (() => Promise<void>) | undefined;
afterEach(async () => { await closing?.(); closing = undefined; });

describe('the stage rules', () => {
  it('moves a lead forward only, and only from the stages each event comes after', () => {
    expect(stageAfter('new', 'sent')).toBe('contacted');
    expect(stageAfter('fit', 'opened')).toBe('contacted');
    expect(stageAfter('replied', 'sent')).toBeNull();
    expect(stageAfter('contacted', 'replied')).toBe('replied');
    expect(stageAfter('meeting', 'replied')).toBeNull();
    expect(stageAfter('replied', 'meeting')).toBe('meeting');
    expect(stageAfter('customer', 'meeting')).toBeNull();
    expect(stageAfter('contacted', 'notes')).toBeNull();
  });

  it('counts a paying customer only when the notes say they pay', () => {
    expect(saysPaying('They signed the annual plan on the call.')).toBe(true);
    expect(saysPaying('Great call. She placed an order for 3 boxes.')).toBe(true);
    expect(saysPaying('Not ready to pay yet, wants a trial.')).toBe(false);
    expect(saysPaying('They might pay if we add invoices.')).toBe(false);
    expect(saysPaying('They did not sign anything.')).toBe(false);
    expect(readingOf('Liked it, will think.')).toEqual({ conversations: 1, paying: 0 });
  });
});

describe('a lead\'s thread', () => {
  it('a drafted email the founder opens in Gmail marks its lead Contacted, once, and nobody else', async () => {
    const { seams, call, add, lead, close } = await setup();
    closing = close;
    const ada = await add('Ada', 'ada@engines.example');
    const bo = await add('Bo', 'bo@beta.example');
    const draft = { to: 'ada@engines.example', subject: 'A quick one', body: 'Hello Ada' };
    await seams.run('tool:after', { roomId: 'marketing', event: { id: 'd', name: 'draft_email', args: draft, ok: true } });
    expect((await lead(ada.id)).thread).toMatchObject([{ kind: 'drafted', draft: draftId(draft), subject: 'A quick one', room: 'marketing' }]);
    expect((await lead(ada.id)).stage).toBe('new');

    expect((await call('/api/leads-thread/opened', { id: draftId(draft), to: draft.to })).body).toEqual({ moved: ['Ada at Ada Co'] });
    const opened = await lead(ada.id);
    expect(opened.stage).toBe('contacted');
    expect(opened.thread!.at(-1)).toMatchObject({ kind: 'opened' });
    expect((await call('/api/leads-thread/opened', { id: draftId(draft), to: draft.to })).body).toEqual({ moved: [] });
    expect((await lead(bo.id)).stage).toBe('new');
    expect((await call('/api/leads-thread/opened', { id: 'not-a-draft' })).status).toBe(400);
  });

  it('a send the founder said yes to marks Contacted with the mailbox it went from', async () => {
    const { seams, add, lead, close } = await setup();
    closing = close;
    const ada = await add('Ada', 'ada@engines.example');
    await seams.run('tool:after', { roomId: 'marketing', event: { id: 's', name: 'send_email', args: { to: 'Ada@engines.example', subject: 'Hello' }, ok: true } });
    const sent = await lead(ada.id);
    expect(sent.stage).toBe('contacted');
    expect(sent.thread).toMatchObject([{ kind: 'sent', room: 'marketing', via: 'agentmail', subject: 'Hello' }]);
    expect(sent.notes.at(-1)).toMatchObject({ by: 'Founder', text: 'Emailed: "Hello".' });
  });

  it('a pasted reply moves to Replied, keeps the words, and offers an answer drafted by the wired person until one is', async () => {
    const { seams, call, add, lead, needs, close } = await setup();
    closing = close;
    const ada = await add('Ada', 'ada@engines.example');
    await call(`/api/leads/leads-1/${ada.id}/replied`, { text: 'Sounds useful. What does it cost for 20 people?' });
    const replied = await lead(ada.id);
    expect(replied.stage).toBe('replied');
    expect(replied.thread!.at(-1)).toMatchObject({ kind: 'replied', text: 'Sounds useful. What does it cost for 20 people?' });
    const [ask] = (await needs()).filter((entry) => entry.kind === 'lead-replied');
    expect(ask).toMatchObject({ title: 'Ada at Ada Co replied. Draft an answer?', roomId: 'marketing', cardId: 'leads-1' });
    const words = (await call(`/api/leads/leads-1/${ada.id}/reply-ask`)).body;
    expect(words.roomId).toBe('marketing');
    expect(words.text).toMatch(/What does it cost for 20 people\?.*draft_email.*propose a short meeting/s);

    await seams.run('tool:after', { roomId: 'marketing', event: { id: 'd', name: 'draft_email', args: { to: 'ada@engines.example', subject: 'Re: pricing', body: 'Hi' }, ok: true } });
    expect((await needs()).filter((entry) => entry.kind === 'lead-replied')).toEqual([]);
    expect((await call(`/api/leads/leads-1/${ada.id}/replied`, { text: '  ' })).status).toBe(400);
  });

  it('a waved-away reply ask stays away', async () => {
    const { call, add, needs, close } = await setup();
    closing = close;
    const ada = await add('Ada', 'ada@engines.example');
    await call(`/api/leads/leads-1/${ada.id}/replied`, { text: 'Not now, thanks.' });
    const [ask] = (await needs()).filter((entry) => entry.kind === 'lead-replied');
    expect((await call('/api/leads-thread/answer', { id: ask.id, do: 'dismiss' })).status).toBe(200);
    expect((await needs()).filter((entry) => entry.kind === 'lead-replied')).toEqual([]);
  });

  it('a meeting set for a day moves to Meeting and puts a task dated that day on the board', async () => {
    const { call, add, lead, boards, close } = await setup();
    closing = close;
    const ada = await add('Ada', 'ada@engines.example');
    const day = localDay(MONDAY + 2 * DAY);
    expect((await call(`/api/leads/leads-1/${ada.id}/meeting`, { day })).body.board).toBe('board-1');
    const met = await lead(ada.id);
    expect(met.stage).toBe('meeting');
    const [task] = await boards.list('board-1');
    expect(task).toMatchObject({ title: 'Meeting with Ada at Ada Co', due: day, column: 'todo' });
    expect(met.thread!.at(-1)).toMatchObject({ kind: 'meeting', day, boardId: 'board-1', taskId: task.id });
    expect((await call(`/api/leads/leads-1/${ada.id}/meeting`, { day: 'Thursday' })).status).toBe(400);
  });

  it('asks how the meeting went from the day after it, never on the day, and the notes propose a reading', async () => {
    const { call, add, lead, needs, clock, close } = await setup();
    closing = close;
    const ada = await add('Ada', 'ada@engines.example');
    await call(`/api/leads/leads-1/${ada.id}/meeting`, { day: localDay(MONDAY) });
    clock.at = MONDAY + 10 * 3_600_000;
    expect((await needs()).filter((entry) => entry.kind === 'lead-notes')).toEqual([]);
    clock.at = MONDAY + DAY;
    const [ask] = (await needs()).filter((entry) => entry.kind === 'lead-notes');
    expect(ask).toMatchObject({ title: 'How did the meeting with Ada go?', cardId: 'leads-1' });

    expect((await call('/api/leads-thread/answer', { id: ask.id, do: 'notes', text: 'Good call. They signed the pilot at 49 a month.' })).status).toBe(200);
    expect((await needs()).filter((entry) => entry.kind === 'lead-notes')).toEqual([]);
    const noted = await lead(ada.id);
    expect(noted.notes.at(-1)).toMatchObject({ by: 'Founder', text: 'Meeting notes: Good call. They signed the pilot at 49 a month.' });
    const [reading] = (await needs()).filter((entry) => entry.kind === 'lead-reading');
    expect(reading.title).toBe('Log conversations +1 and paying customers +1 from the meeting with Ada?');
  });

  it('a reading logged goes on the Metrics card one up from the last, and a paying customer moves to Customer', async () => {
    const { call, add, lead, needs, workspace, close } = await setup();
    closing = close;
    const metrics = metricsFor(workspace);
    await metrics.log('metrics-1', { ref: 'Customer conversations', value: 4, at: '2026-10-01', from: 'founder' });
    const ada = await add('Ada', 'ada@engines.example');
    await call(`/api/leads/leads-1/${ada.id}/meeting`, { day: '2026-10-01' });
    await call(`/api/leads/leads-1/${ada.id}/meeting-notes`, { text: 'They bought the starter plan.' });
    const [reading] = (await needs()).filter((entry) => entry.kind === 'lead-reading');
    expect((await call('/api/leads-thread/answer', { id: reading.id, do: 'log' })).status).toBe(200);
    const numbers = (await metrics.load('metrics-1')).metrics;
    expect(numbers.find((one) => one.label === 'Customer conversations')!.points.at(-1)).toMatchObject({ value: 5, from: 'meeting notes, Ada at Ada Co' });
    expect(numbers.find((one) => one.label === 'Paying customers')!.points.at(-1)).toMatchObject({ value: 1 });
    expect((await lead(ada.id)).stage).toBe('customer');
    expect((await needs()).filter((entry) => entry.kind === 'lead-reading')).toEqual([]);
    expect((await call('/api/leads-thread/answer', { id: reading.id, do: 'log' })).status).toBe(400);
  });

  it('a reading declined logs nothing, and none is offered without a Metrics card', async () => {
    const one = await setup();
    closing = one.close;
    const ada = await one.add('Ada', 'ada@engines.example');
    await one.call(`/api/leads/leads-1/${ada.id}/meeting-notes`, { text: 'Not ready to pay.' });
    const [reading] = (await one.needs()).filter((entry) => entry.kind === 'lead-reading');
    expect(reading.title).toBe('Log conversations +1 from the meeting with Ada?');
    await one.call('/api/leads-thread/answer', { id: reading.id, do: 'dismiss' });
    expect((await metricsFor(one.workspace).load('metrics-1')).metrics).toEqual([]);
    expect((await one.lead(ada.id)).thread!.at(-1)!.reading).toMatchObject({ answer: 'declined' });
    await one.close();

    const two = await setup({ metrics: false, board: false });
    closing = two.close;
    const bo = await two.add('Bo', 'bo@beta.example');
    expect((await two.call(`/api/leads/leads-1/${bo.id}/meeting`, { day: '2026-10-01' })).body.board).toBeNull();
    await two.call(`/api/leads/leads-1/${bo.id}/meeting-notes`, { text: 'Fine.' });
    expect((await two.needs()).filter((entry) => entry.kind === 'lead-reading')).toEqual([]);
  });
});

describe('the inbox poll', () => {
  it('reads the wired people\'s inboxes every ten minutes and takes only replies from leads written to, once', async () => {
    const { part, seams, add, lead, inbox, clock, needs, close } = await setup();
    closing = close;
    const ada = await add('Ada', 'ada@engines.example');
    const bo = await add('Bo', 'bo@beta.example');
    await seams.run('tool:after', { roomId: 'marketing', event: { id: 's', name: 'send_email', args: { to: 'ada@engines.example', subject: 'Hello' }, ok: true } });
    inbox.messages.push(
      { id: 'm-1', from: 'Ada Lovelace <ADA@engines.example>', subject: 'Re: Hello', preview: 'Yes, let us talk on Thursday.', at: '' },
      { id: 'm-2', from: 'news@shop.example', subject: 'Sale', preview: 'Everything must go', at: '' },
      { id: 'm-3', from: 'bo@beta.example', subject: 'Hi', preview: 'Who are you?', at: '' },
    );
    await part.tick!();
    expect(inbox.asked).toEqual(['marketing']);
    const replied = await lead(ada.id);
    expect(replied.stage).toBe('replied');
    expect(replied.thread!.at(-1)).toMatchObject({ kind: 'replied', mail: 'm-1', text: 'Re: Hello\nYes, let us talk on Thursday.' });
    // Bo was never written to, so his mail is not his lead's reply.
    expect((await lead(bo.id)).stage).toBe('new');
    expect((await needs()).filter((entry) => entry.kind === 'lead-replied')).toHaveLength(1);

    await part.tick!();
    expect(inbox.asked).toHaveLength(1);
    clock.at += POLL_EVERY;
    await part.tick!();
    expect(inbox.asked).toHaveLength(2);
    expect((await lead(ada.id)).thread!.filter((event) => event.kind === 'replied')).toHaveLength(1);
  });

  it('does not poll without a mail key, and Health says replies come by hand', async () => {
    const { part, seams, add, inbox, close } = await setup({ keyed: false });
    closing = close;
    await add('Ada', 'ada@engines.example');
    await seams.run('tool:after', { roomId: 'marketing', event: { id: 's', name: 'send_email', args: { to: 'ada@engines.example', subject: 'Hello' }, ok: true } });
    await part.tick!();
    expect(inbox.asked).toEqual([]);
    expect(await healthRows.get('replies')!()).toMatchObject({ name: 'Replies', detail: expect.stringContaining(BY_HAND) });
  });
});
