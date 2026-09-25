import { mkdtemp } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Interview, InterviewEvent } from '../../shared/interviews.ts';
import { hub } from '../events.ts';
import { body, json } from '../http.ts';
import type { Deps } from '../install.ts';
import { silentWav } from '../interviews/fixtures.ts';
import { FAKE_TRANSCRIPT } from '../interviews/hear.ts';
import { createSeams } from '../seams.ts';
import { createStore } from '../store.ts';
import type { Tool, ToolContext } from '../tools/registry.ts';
import interviews, { INTERVIEW_TOOLS, seamLine, transcriptText } from './interviews.ts';

async function setup() {
  const workspace = await mkdtemp(join(tmpdir(), 'interviews-slice-'));
  const store = createStore(workspace);
  const stage = await store.loadStage();
  stage.cards = [
    { id: 'interview-1', kind: 'interview', who: 'Ana', company: 'Acme', on: '2026-09-25', x: 0, y: 0, w: 1, h: 1 },
    { id: 'interview-2', kind: 'interview', who: 'Ben', x: 0, y: 0, w: 1, h: 1 },
  ];
  stage.wires.push({ id: 'w', from: 'marketing', fromHandle: 'r', to: 'interview-1', toHandle: 'l' });
  await store.saveStage(stage);
  const seams = createSeams();
  const deps = { workspace, root: workspace, fake: true, store, seams, json, body } as unknown as Deps;
  const heard: { channel: string; data: InterviewEvent }[] = [];
  hub.say = (channel, data) => heard.push({ channel, data: structuredClone(data) as InterviewEvent });
  const part = await interviews.install(deps);
  const server: Server = createServer((req, res) => { void part.route!(req, res, new URL(req.url ?? '/', 'http://here').pathname).then((done) => { if (!done) json(res, 404, {}); }); });
  await new Promise<void>((done) => { server.listen(0, '127.0.0.1', done); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/interviews`;
  const use = async (name: string, args: Record<string, unknown>, roomId = 'marketing') => part.tools!.find((one: Tool) => one.name === name)!.run(args, { stage: await store.loadStage(), roomId, store, granted: new Map() } as ToolContext);
  const read = async (id = 'interview-1') => ((await (await fetch(`${base}/${id}`)).json()) as InterviewEvent).data;
  const turn = async (roomId: string) => (await seams.run('turn:before', { roomId, source: 'chat', query: 'hi', messages: [{ role: 'system', content: 'You are Maya.' }, { role: 'user', content: 'hi' }] })).messages[0].content;
  const close = async () => { await new Promise((done) => { server.close(done); }); await part.close!(); };
  return { part, store, base, use, read, turn, heard, close };
}

let closing: (() => Promise<void>) | undefined;
afterEach(async () => { await closing?.(); closing = undefined; });

describe('the Interview card', () => {
  it('is offered only to a person wired to one', async () => {
    const { part, store, close } = await setup();
    closing = close;
    const stage = await store.loadStage();
    const names = (roomId: string) => part.offer!(part.tools!, stage, roomId).map((one: Tool) => one.name);
    expect(names('marketing')).toEqual(INTERVIEW_TOOLS);
    expect(names('build')).toEqual([]);
  });

  it('records only after consent, writes the call down, plays it back a piece at a time, and a wired person reads it', async () => {
    const { base, use, read, turn, heard, close } = await setup();
    closing = close;
    expect(await turn('marketing')).toContain('- An interview with Ana (Acme) on 2026-09-25: not recorded yet.');
    expect(await turn('build')).toBe('You are Maya.');

    const refused = await fetch(`${base}/interview-1/recordings?name=call.wav`, { method: 'POST', body: new Uint8Array(silentWav(3)) });
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toBe('Tick that they agreed to be recorded first.');

    expect((await (await fetch(`${base}/interview-1/consent`, { method: 'POST', body: JSON.stringify({ yes: true }) })).json()).consent).toBe(true);
    const added = await fetch(`${base}/interview-1/recordings?name=call.wav`, { method: 'POST', body: new Uint8Array(silentWav(90)) });
    expect(added.status).toBe(200);
    expect((await added.json()).seconds).toBe(90);
    let data: Interview = await read();
    for (let tries = 0; data.state !== 'idle' && tries < 50; tries += 1) { await new Promise((done) => { setTimeout(done, 20); }); data = await read(); }
    expect(data.transcript).toEqual(FAKE_TRANSCRIPT);
    expect(heard.some((one) => one.channel === 'interview:interview-1' && one.data.data.state === 'transcribing')).toBe(true);

    const piece = await fetch(`${base}/interview-1/recordings/0`, { headers: { range: 'bytes=0-11' } });
    expect(piece.status).toBe(206);
    expect(piece.headers.get('content-type')).toBe('audio/wav');
    expect(Buffer.from(await piece.arrayBuffer()).toString('ascii', 0, 4)).toBe('RIFF');
    expect((await fetch(`${base}/interview-1/recordings/5`)).status).toBe(404);

    expect(await turn('marketing')).toContain('- An interview with Ana (Acme) on 2026-09-25: 2 min, transcribed. Read it with read_interview.');
    const text = (await use('read_interview', {})).text;
    expect(text).toContain('Interview with Ana, Acme, 2026-09-25: 2 min, recorded with their consent and written down on this machine by fake.');
    expect(text).toContain('[0:04] Last month it took us four days');
    const about = (await use('read_interview', { query: 'pay budget' })).text;
    expect(about).toContain('The lines about "pay budget":');
    expect(about).toContain('[0:15] If something cut that to one day');
    expect(about).not.toContain('[0:04]');
    await expect(use('read_interview', {}, 'build')).rejects.toThrow('no Interview card is connected');
    await expect(use('read_interview', { cardId: 'interview-2' })).rejects.toThrow('no interview "interview-2" is wired to you');
  });

  it('keeps who was asked for insights, and refuses a doc or a person not on the stage', async () => {
    const { base, turn, close } = await setup();
    closing = close;
    const bad = await fetch(`${base}/interview-1/insights`, { method: 'POST', body: JSON.stringify({ docId: 'nope', roomId: 'marketing' }) });
    expect(bad.status).toBe(400);
    const good = await (await fetch(`${base}/interview-1/insights`, { method: 'POST', body: JSON.stringify({ docId: 'brand-doc', roomId: 'marketing' }) })).json();
    expect(good.insights).toMatchObject({ docId: 'brand-doc', title: 'Brand doc', roomId: 'marketing', by: 'Maya' });
    expect(await turn('marketing')).toContain('Insights go in the doc "Brand doc".');
    expect((await fetch(`${base}/not-here`)).status).toBe(404);
  });
});

describe('what a person reads', () => {
  const card = { id: 'interview-1', kind: 'interview' as const, who: 'Ana', company: 'Acme', x: 0, y: 0, w: 1, h: 1 };
  const base: Interview = { consent: true, recordings: [{ path: 'a', seconds: 24 * 60, at: Date.UTC(2026, 8, 25, 10) }], transcript: [], state: 'idle' };

  it('says the day of the first recording when the card has none, and names the card when several are wired', () => {
    expect(seamLine(card, { ...base, state: 'transcribing' }, false)).toBe('- An interview with Ana (Acme) on 2026-09-25: 24 min, being written down.');
    expect(seamLine(card, { ...base, transcript: [{ at: 0, text: 'hi' }] }, true)).toBe('- An interview with Ana (Acme) on 2026-09-25: 24 min, transcribed. Read it with read_interview (cardId "interview-1").');
    expect(seamLine(card, { ...base, state: 'failed' }, false)).toBe('- An interview with Ana (Acme) on 2026-09-25: 24 min, not written down yet.');
  });

  it('cuts a long transcript with a plain word about the rest', () => {
    const transcript = Array.from({ length: 50 }, (_, index) => ({ at: index * 10, text: `line number ${index} of the call` }));
    const text = transcriptText(card, { ...base, transcript }, '', 300);
    expect(text).toMatch(/\(\d+ more lines after this; ask with a query to find a part\)$/);
    expect(transcriptText(card, { ...base, transcript }, 'pricing')).toContain('Nothing in it mentions "pricing"');
  });
});
