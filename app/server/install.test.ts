import { mkdtemp, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Stage } from '../shared/model.ts';
import { installSlices, lateRuns, loadSlices, type Deps, type Installed, type Runs, type Slice } from './install.ts';
import type { Tool } from './tools/registry.ts';

const FIXTURES = resolve(import.meta.dirname, 'install.fixtures');
const tool = (name: string) => ({ name, description: name, parameters: {}, async run() { return { text: name }; } }) as Tool;
const stage = { rooms: [], docs: [], cards: [] } as unknown as Stage;
const deps = (extra: Partial<Deps> = {}) => ({ workspace: '/w', root: '/r', fake: true, json: () => {}, ...extra }) as unknown as Deps;
const slice = (name: string, part: Installed, order?: number): Slice => ({ name, order, install: () => part });

describe('slices', () => {
  it('loads every slice in a folder, by order and then by name, and skips what will not import', async () => {
    const said: string[] = [];
    const found = await loadSlices(FIXTURES, (name, error) => said.push(`${name}: ${error.message}`));
    expect(found.map((one) => one.name)).toEqual(['zebra', 'example']);
    expect(said).toEqual(['broken: this extra is broken']);
  });

  it('is not a slice if it is a test, and sorts by name inside the same order', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'slices-'));
    await writeFile(join(dir, 'beta.ts'), 'export default { name: "beta", install: () => ({}) };');
    await writeFile(join(dir, 'alpha.ts'), 'export default { name: "alpha", install: () => ({}) };');
    await writeFile(join(dir, 'alpha.test.ts'), 'throw new Error("a test is not a slice");');
    await writeFile(join(dir, 'notes.md'), 'nor is a readme');
    const said: string[] = [];
    expect((await loadSlices(dir, (name, error) => said.push(`${name}: ${error.message}`))).map((one) => one.name)).toEqual(['alpha', 'beta']);
    expect(said).toEqual([]);
  });

  it('gives back nothing at all when there is no folder there', async () => {
    expect(await loadSlices(join(FIXTURES, 'nowhere'), () => {})).toEqual([]);
  });

  it('joins their tools into one list, in the order they were installed', async () => {
    const extras = await installSlices([slice('b', { tools: [tool('two')] }), slice('a', { tools: [tool('one')] })], deps());
    expect(extras.tools.map((one) => one.name)).toEqual(['two', 'one']);
    expect(extras.names).toEqual(['b', 'a']);
  });

  it('names a slice that throws on the way in and starts without it', async () => {
    const said: string[] = [];
    const extras = await installSlices([
      { name: 'rotten', install() { throw new Error('no keys'); } },
      slice('fine', { tools: [tool('one')] }),
    ], deps(), (name, error) => said.push(`${name}: ${error.message}`));
    expect(said).toEqual(['rotten: no keys']);
    expect(extras.names).toEqual(['fine']);
    expect(extras.tools.map((one) => one.name)).toEqual(['one']);
  });

  it('narrows the offer one slice after another, and lets none of them add a tool', async () => {
    const all = [tool('read'), tool('write'), tool('send')];
    const extras = await installSlices([
      slice('first', { offer: (tools) => tools.filter((one) => one.name !== 'send') }),
      slice('second', { offer: (tools) => [...tools, tool('sneaked')].filter((one) => one.name !== 'write') }),
    ], deps());
    expect(extras.offer(all, stage, 'build').map((one) => one.name)).toEqual(['read']);
  });

  it('keeps the offer as it was when one of them throws', async () => {
    const said: string[] = [];
    const all = [tool('read'), tool('write')];
    const extras = await installSlices([
      slice('broken', { offer: () => { throw new Error('cannot decide'); } }),
      slice('sane', { offer: (tools) => tools.filter((one) => one.name === 'read') }),
    ], deps(), (name, error) => said.push(`${name}: ${error.message}`));
    expect(extras.offer(all, stage, 'build').map((one) => one.name)).toEqual(['read']);
    expect(said).toEqual(['broken: cannot decide']);
  });

  it('hands the whole list back when nobody wants a say', async () => {
    const all = [tool('read'), tool('write')];
    const extras = await installSlices([slice('quiet', {})], deps());
    expect(extras.offer(all, stage, 'build')).toBe(all);
  });

  it('stops at the first route that answers', async () => {
    const seen: string[] = [];
    const extras = await installSlices([
      slice('first', { async route(_req, _res, path) { seen.push('first'); return path === '/api/first'; } }),
      slice('second', { async route() { seen.push('second'); return true; } }),
    ], deps());
    expect(await extras.route({} as IncomingMessage, {} as ServerResponse, '/api/first')).toBe(true);
    expect(seen).toEqual(['first']);
    expect(await extras.route({} as IncomingMessage, {} as ServerResponse, '/api/other')).toBe(true);
    expect(seen).toEqual(['first', 'first', 'second']);
  });

  it('says so when no slice wanted the path', async () => {
    const extras = await installSlices([slice('quiet', {})], deps());
    expect(await extras.route({} as IncomingMessage, {} as ServerResponse, '/api/nothing')).toBe(false);
  });

  it('runs every tick and every close, and a thrower takes none of the others down', async () => {
    const said: string[] = [];
    const ran: string[] = [];
    const extras = await installSlices([
      slice('rotten', { async tick() { throw new Error('tick failed'); }, async close() { throw new Error('close failed'); } }),
      slice('fine', { async tick() { ran.push('tick'); }, async close() { ran.push('close'); } }),
    ], deps(), (name, error) => said.push(`${name}: ${error.message}`));
    await extras.tick();
    await extras.close();
    expect(ran).toEqual(['tick', 'close']);
    expect(said).toEqual(['rotten: tick failed', 'rotten: close failed']);
  });

  it('holds the runner open until it exists, then passes every call straight through', async () => {
    const late = lateRuns();
    await expect(late.runs.start('b1', 't1')).rejects.toThrow(/not ready yet/);
    const started: string[] = [];
    late.fill({ start: async (boardId, taskId) => { started.push(`${boardId}/${taskId}`); }, stop: () => {}, note: async () => {}, tick: async () => {} } as Runs);
    await late.runs.start('b1', 't1');
    expect(started).toEqual(['b1/t1']);
  });

  it('installs the example the way the app does, tools and route and all', async () => {
    const answered: unknown[] = [];
    const extras = await installSlices(await loadSlices(FIXTURES, () => {}), deps({ json: (_res, status, sent) => answered.push([status, sent]) }));
    expect(extras.tools.map((one) => one.name)).toEqual(['example_tool']);
    expect(await extras.tools[0].run({}, {} as never)).toEqual({ text: '/w' });
    expect(extras.offer([tool('read'), tool('secret_key')], stage, 'build').map((one) => one.name)).toEqual(['read']);
    expect(await extras.route({} as IncomingMessage, {} as ServerResponse, '/api/example')).toBe(true);
    expect(answered).toEqual([[200, { ok: true }]]);
  });
});
