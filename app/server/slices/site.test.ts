import { mkdtemp } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hub } from '../events.ts';
import type { Deps } from '../install.ts';
import { createSeams } from '../seams.ts';
import { createStore } from '../store.ts';
import type { Tool, ToolContext } from '../tools/registry.ts';
import site, { SITE_TOOLS } from './site.ts';

// The slice in fake mode on a throwaway workspace: a Site card wired to Maya, a note wired to the card.
async function setup() {
  const workspace = await mkdtemp(join(tmpdir(), 'site-slice-'));
  const store = createStore(workspace);
  const stage = await store.loadStage();
  stage.cards = [
    { id: 'site-1', kind: 'site', brief: 'Relay helps agencies bill on time', look: 'clean', x: 0, y: 0, w: 1, h: 1 },
    { id: 'note-1', kind: 'note', text: 'Relay is used by 340 agencies', x: 0, y: 0, w: 1, h: 1 },
    { id: 'browser-1', kind: 'browser', x: 0, y: 0, w: 1, h: 1 },
  ];
  stage.wires.push({ id: 'w', from: 'marketing', fromHandle: 'r', to: 'site-1', toHandle: 'l' }, { id: 'n', from: 'note-1', fromHandle: 'r', to: 'site-1', toHandle: 'l' });
  await store.saveStage(stage);
  const answered: { status: number; body: any }[] = [];
  const written: { status: number; headers: Record<string, unknown>; body?: Buffer }[] = [];
  let sent: unknown = {};
  const deps = {
    workspace, root: workspace, fake: true, store, seams: createSeams(), own: { ports: [7001], token: 't' },
    json: (_res: ServerResponse, status: number, body: unknown) => { answered.push({ status, body }); },
    body: async () => sent,
  } as unknown as Deps;
  hub.say = () => {};
  const part = await site.install(deps);
  const context = async (roomId = 'marketing'): Promise<ToolContext> => ({ stage: await store.loadStage(), roomId, store, granted: new Map() });
  const use = async (name: string, args: Record<string, unknown>, roomId?: string) => part.tools!.find((one) => one.name === name)!.run(args, await context(roomId));
  const response = () => ({ writeHead(status: number, headers: Record<string, unknown>) { written.push({ status, headers }); }, end(body?: Buffer) { if (written.length) written.at(-1)!.body = body; } }) as unknown as ServerResponse;
  const call = async (path: string, method = 'GET', body: unknown = {}) => { sent = body; answered.length = 0; written.length = 0; await part.route!({ method, headers: { host: '127.0.0.1:7001' } } as unknown as IncomingMessage, response(), path); return { json: answered.at(-1), raw: written.at(-1) }; };
  return { part, store, deps, use, call };
}

let closing: (() => Promise<void>) | undefined;
afterEach(async () => { await closing?.(); closing = undefined; });

describe('the Site card', () => {
  it('is offered only to a person wired to one', async () => {
    const { part, store } = await setup();
    closing = part.close;
    const stage = await store.loadStage();
    const names = (roomId: string) => part.offer!(part.tools!, stage, roomId).map((one: Tool) => one.name);
    expect(names('marketing')).toEqual(SITE_TOOLS);
    expect(names('build')).toEqual([]);
  });

  it('makes, edits and reads a site through its tools, with the critic in the answer', async () => {
    const { part, use } = await setup();
    closing = part.close;
    expect((await use('read_site', {})).text).toMatch(/no site yet/);
    const made = await use('make_site', {});
    expect(made.text).toMatch(/Site version 1, 5 sections/);
    expect(made.text).toMatch(/ok · One headline/);
    expect(made.text).toMatch(/Using|Relay/);
    const edited = await use('edit_site', { notes: 'drop faq' });
    expect(edited.text).toMatch(/Version 2: dropped the questions/);
    expect((await use('read_site', {})).text).toMatch(/version 2 of 2/);
    await expect(use('read_site', {}, 'build')).rejects.toThrow('no Site card is connected');
  });

  it('serves a version\'s files with a strict policy, zips it, and opens it in a plain browser card', async () => {
    const { part, use, call } = await setup();
    closing = part.close;
    await use('make_site', {});
    const page = await call('/api/sites/site-1/v/1/index.html');
    expect(page.raw!.status).toBe(200);
    expect(page.raw!.headers['content-security-policy']).toMatch(/default-src 'none'.*frame-ancestors 'self'/);
    expect(page.raw!.body!.toString()).toContain('<h1>');
    expect((await call('/api/sites/site-1/v/1/style.css')).raw!.headers['content-type']).toMatch(/text\/css/);
    expect((await call('/api/sites/site-1/v/1/media/nope.png')).json!.status).toBe(404);
    const zipped = await call('/api/sites/site-1/v/1/zip');
    expect(zipped.raw!.headers['content-disposition']).toMatch(/attachment; filename="relay-helps-agencies-bill-on-time-v1\.zip"/);
    expect((await call('/api/sites/site-1/serve', 'POST', { browserId: 'nope' })).json!.status).toBe(400);
    const served = await call('/api/sites/site-1/serve', 'POST', { browserId: 'browser-1' });
    expect(served.json).toEqual({ status: 200, body: { url: 'http://127.0.0.1:7001/api/sites/site-1/v/1/index.html' } });
    expect((await call('/api/sites/other/make', 'POST')).json!.status).toBe(404);
  });

  it('tells a wired person what the site is, dated, in a few lines', async () => {
    const { part, use, deps } = await setup();
    closing = part.close;
    await use('make_site', {});
    const out = await deps.seams.run('turn:before', { roomId: 'marketing', messages: [{ role: 'system', content: 'You are Maya.' }, { role: 'user', content: 'hi' }] } as never) as { messages: { content: string }[] };
    const seen = out.messages[0].content;
    expect(seen).toMatch(/A Site card/);
    expect(seen).toMatch(/The site now: "Relay helps agencies bill on time", version 1, 5 sections, 5 of 5 critic rules hold, made /);
  });
});
