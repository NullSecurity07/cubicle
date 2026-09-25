import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DeckEvent } from '../../shared/deck.ts';
import { hub } from '../events.ts';
import type { Deps } from '../install.ts';
import { createSeams } from '../seams.ts';
import { createStore } from '../store.ts';
import type { Tool, ToolContext } from '../tools/registry.ts';
import deck, { DECK_TOOLS, gatherDeck, metricsOf } from './deck.ts';

// The slice in fake mode on a throwaway workspace: a real store, a Deck card wired to Maya, the brand doc wired to it.
async function setup() {
  const workspace = await mkdtemp(join(tmpdir(), 'deck-slice-'));
  const store = createStore(workspace);
  const stage = await store.loadStage();
  stage.cards = [{ id: 'deck-1', kind: 'deck', brief: 'Seed deck for Relay', x: 0, y: 0, w: 1, h: 1 }, { id: 'note-1', kind: 'note', text: 'We have 4,200 agencies on the waitlist', x: 0, y: 0, w: 1, h: 1 }];
  stage.wires.push({ id: 'w', from: 'marketing', fromHandle: 'r', to: 'deck-1', toHandle: 'l' }, { id: 'n', from: 'note-1', fromHandle: 'r', to: 'deck-1', toHandle: 'l' }, { id: 'd', from: 'brand-doc', fromHandle: 'r', to: 'deck-1', toHandle: 'l' });
  await store.saveStage(stage);
  await store.writeDoc('brand-doc', '# Brand\n\nRelay is calm software for agencies.');
  const seams = createSeams();
  const answered: { status: number; body: any }[] = [];
  let sent: unknown = {};
  const deps = {
    workspace, root: workspace, fake: true, store, seams,
    json: (_res: ServerResponse, status: number, body: unknown) => { answered.push({ status, body }); },
    body: async () => sent,
  } as unknown as Deps;
  const heard: { channel: string; data: DeckEvent }[] = [];
  hub.say = (channel, data) => heard.push({ channel, data: data as DeckEvent });
  const part = await deck.install(deps);
  const tool = (name: string) => part.tools!.find((one) => one.name === name)!;
  const context = async (roomId = 'marketing'): Promise<ToolContext> => ({ stage: await store.loadStage(), roomId, store, granted: new Map() });
  const use = async (name: string, args: Record<string, unknown>, roomId?: string) => tool(name).run(args, await context(roomId));
  const call = async (path: string, method = 'GET', body: unknown = {}) => { sent = body; await part.route!({ method } as IncomingMessage, { writeHead() {}, end() {} } as unknown as ServerResponse, path); return answered.at(-1)!; };
  return { part, store, seams, heard, use, call, workspace, deps };
}

let closing: (() => Promise<void>) | undefined;
afterEach(async () => { await closing?.(); closing = undefined; });

// Making a deck prints it with headless Chrome, which is slow when every other test file runs beside it.
describe('the Deck card', { timeout: 60_000 }, () => {
  it('is offered only to a person wired to one', async () => {
    const { part, store } = await setup();
    closing = part.close;
    const stage = await store.loadStage();
    const names = (roomId: string) => part.offer!(part.tools!, stage, roomId).map((one: Tool) => one.name);
    expect(names('marketing')).toEqual(DECK_TOOLS);
    expect(names('build')).toEqual([]);
    await expect(part.tools![2].run({}, { stage, roomId: 'build', store, granted: new Map() })).rejects.toThrow('no Deck card is connected');
  });

  it('reads what is wired to it: documents, notes, and a Metrics card when there is one', async () => {
    const { part, deps, store, workspace } = await setup();
    closing = part.close;
    const gathered = await gatherDeck(deps, 'deck-1');
    expect(gathered.material.brief).toBe('Seed deck for Relay');
    // The pinned Company brief reaches the deck the way it reaches a film, since the media sweep: a claim from it is fair game.
    expect(gathered.material.sources.map((one) => one.name)).toEqual(['a note', 'Brand doc', 'Company brief']);
    expect(gathered.material.metrics).toBeUndefined();
    const stage = await store.loadStage();
    stage.cards!.push({ id: 'metrics-1', kind: 'metrics' } as never);
    stage.wires.push({ id: 'm', from: 'metrics-1', fromHandle: 'r', to: 'deck-1', toHandle: 'l' });
    await mkdir(join(workspace, 'metrics'), { recursive: true });
    await writeFile(join(workspace, 'metrics', 'metrics-1.json'), JSON.stringify({ block: 'MRR 12,400 (Sep 24)' }));
    expect(await metricsOf(workspace, stage, 'deck-1')).toEqual({ name: 'Metrics card', text: 'MRR 12,400 (Sep 24)' });
  });

  it('makes, edits and reads a deck for a wired person, and tells the card as it goes', async () => {
    const { part, use, heard } = await setup();
    closing = part.close;
    const made = await use('make_deck', {});
    expect(made.text).toMatch(/^Deck version 1, 5 slides, PDF at decks\/seed-deck-for-relay-deck-1-v1\.pdf\./);
    expect(made.text).toContain('4. [Traction] Early and honest about it · No numbers yet.');
    const edited = await use('edit_deck', { notes: 'merge 2 and 3' });
    expect(edited.text).toMatch(/^Version 2: merged slides 2 and 3; kept 3 of 4 slides as they were; slide 2: kept 4 of 5 lines, one idea a slide\./);
    const read = await use('read_deck', {});
    expect(read.text).toContain('version 2 of 2');
    expect(read.text).toContain('from the notes "merge 2 and 3"');
    expect((await use('read_deck', { version: 1 })).text).toContain('5. [The ask]');
    expect(heard.filter((one) => one.channel === 'deck:deck-1').at(-1)!.data.deck.versions).toHaveLength(2);
  });

  it('tells a wired person what the deck holds, in a few dated lines', async () => {
    const { part, seams, use } = await setup();
    closing = part.close;
    const messages = [{ role: 'system' as const, content: 'You are Maya.' }];
    const run = (roomId: string) => seams.run('turn:before', { roomId, messages } as never);
    expect(((await run('marketing')) as any).messages[0].content).toContain('No deck made yet.');
    await use('make_deck', {});
    const said = ((await run('marketing')) as any).messages[0].content as string;
    expect(said).toMatch(/The deck now: "Seed deck for Relay", version 1, 5 slides, made \w+/);
    expect(said.length - 'You are Maya.'.length).toBeLessThan(1400);
    expect(((await run('build')) as any).messages[0].content).toBe('You are Maya.');
  });

  it('answers its own routes: the deck, a make, notes, and one slide as a page', async () => {
    const { part, call } = await setup();
    closing = part.close;
    expect((await call('/api/decks/nope')).status).toBe(404);
    expect((await call('/api/decks/deck-1')).body.deck.versions).toEqual([]);
    expect((await call('/api/decks/deck-1/make', 'POST', { purpose: 'update', look: 'editorial' })).status).toBe(202);
    // Chrome prints for real when it is here, and under a full test run that can take seconds.
    for (let until = Date.now() + 45_000; Date.now() < until && (await call('/api/decks/deck-1')).body.deck.state !== 'idle';) await new Promise((done) => setTimeout(done, 50));
    const deck = (await call('/api/decks/deck-1')).body.deck;
    expect(deck.versions[0]).toMatchObject({ version: 1, look: 'editorial', purpose: 'update', brief: 'Seed deck for Relay' });
    expect((await call('/api/decks/deck-1/v/1/slides/9')).status).toBe(404);
    expect((await call('/api/decks/deck-1/edit', 'POST', { notes: 'drop 5' })).status).toBe(202);
  });
});
