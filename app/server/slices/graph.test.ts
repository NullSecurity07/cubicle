import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CoderEvent } from '../../shared/coder.ts';
import { hub } from '../events.ts';
import type { Deps } from '../install.ts';
import { createStore } from '../store.ts';
import type { Tool, ToolContext } from '../tools/registry.ts';
import graph, { fakeRunner, findTool, FIXTURES, graphifyVersion, graphJson, leadOf, mapDir, mapFolder, mcpCommand, NO_MAP, NOT_HERE, readMap, spawnRunner, type Runner } from './graph.ts';
import opencode from './opencode.ts';

describe('reading a map', () => {
  it('counts its nodes, links and groups, and names the most connected code, files left out', async () => {
    const map = (await readMap(FIXTURES))!;
    expect(map).toMatchObject({ nodes: 5, edges: 7, communities: 2 });
    expect(map.gods[0]).toBe('a()');
    expect(map.gods).toHaveLength(3);
    expect(map.gods).not.toContain('x.ts');
    expect(map.lead).toMatch(/^- 5 nodes · 7 edges · 2 communities/);
    expect(await readMap(join(tmpdir(), 'no-map-here'))).toBeNull();
  });

  it('takes the summary out of a report, or its first paragraph when it has none, cut to size', () => {
    expect(leadOf('# Graph Report - x\n\n## Summary\n- 3 nodes\n- 0 tokens\n\n## God Nodes\n1. a')).toBe('- 3 nodes\n- 0 tokens');
    expect(leadOf('# Title\n\nFirst words.\n\nSecond.')).toBe('First words.');
    expect(leadOf(`# T\n\n${'x'.repeat(900)}`, 100)).toHaveLength(100);
  });

  it('keeps every folder\'s map in the workspace, apart from the folder itself', () => {
    const one = mapDir('/work', '/code/My Shop');
    expect(one).toMatch(/^\/work\/graphs\/my-shop-[0-9a-f]{10}\/graphify-out$/);
    expect(mapDir('/work', '/other/My Shop')).not.toBe(one);
    expect(graphJson('/work', '/code/My Shop')).toBe(`${one}/graph.json`);
  });
});

describe('mapping a folder', () => {
  it('runs graphify update into the workspace, passes its lines on, and hands a model no key', async () => {
    const out = join(await mkdtemp(join(tmpdir(), 'graph-')), 'graphify-out');
    const seen: { args: string[]; env: NodeJS.ProcessEnv; cwd?: string }[] = [];
    const run: Runner = async (args, options) => { seen.push({ args, env: options.env, cwd: options.cwd }); return fakeRunner(args, options); };
    const lines: string[] = [];
    const summary = await mapFolder('/code/shop', (line) => lines.push(line), { out, run, env: { PATH: '/usr/bin', GROQ_API_KEY: 'sk-secret', ANTHROPIC_API_KEY: 'sk-other' } });
    expect(seen[0].args).toEqual(['update', '/code/shop', '--force']);
    expect(seen[0].cwd).toBe('/code/shop');
    expect(seen[0].env).toMatchObject({ GRAPHIFY_OUT: out, GRAPHIFY_QUERY_LOG_DISABLE: '1', PATH: '/usr/bin' });
    expect(JSON.stringify(seen[0].env)).not.toContain('sk-');
    // Never a labelling step: `update`, then Graphify's own list of the most connected code, and nothing else.
    expect(seen.map((one) => one.args[0])).toEqual(['update', 'god-nodes']);
    expect(summary.gods).toEqual(['a()', 'main()', 'b()']);
    expect(lines).toEqual(['Re-extracting code files (no LLM needed)...', 'Rebuilt: 5 nodes, 7 edges, 2 communities']);
    expect(summary).toMatchObject({ nodes: 5, edges: 7, communities: 2, html: join(out, 'graph.html') });
  });

  it('says in a sentence when graphify fails or leaves no map', async () => {
    const out = join(await mkdtemp(join(tmpdir(), 'graph-')), 'graphify-out');
    const broken: Runner = async (_args, { onLine }) => { onLine?.('error: no code files found'); return { code: 1, out: '' }; };
    await expect(mapFolder('/code/empty', () => {}, { out, run: broken })).rejects.toThrow('Graphify could not map empty: error: no code files found');
  });

  it('kills a run that goes on too long, and one the founder stops', async () => {
    const run = spawnRunner(() => '/bin/sh');
    await expect(run(['-c', 'sleep 5'], { env: process.env, limit: 150 })).rejects.toThrow('it took longer than 1 minutes');
    const stop = new AbortController();
    const going = run(['-c', 'echo started; sleep 5'], { env: process.env, limit: 60_000, signal: stop.signal });
    setTimeout(() => stop.abort(), 100);
    await expect(going).rejects.toThrow('stopped');
    const lines: string[] = [];
    expect(await run(['-c', 'echo one; echo two >&2'], { env: process.env, limit: 5_000, onLine: (line) => lines.push(line) })).toMatchObject({ code: 0 });
    expect(lines.sort()).toEqual(['one', 'two']);
    await expect(spawnRunner(() => null)([], { env: {}, limit: 1 })).rejects.toThrow(NOT_HERE);
  });

  it('finds graphify in ~/.local/bin or on the PATH, and asks it its version', async () => {
    const home = await mkdtemp(join(tmpdir(), 'graph-home-'));
    expect(findTool('graphify', { PATH: '/definitely/not/here' })).toBeNull();
    await mkdir(join(home, '.local/bin'), { recursive: true });
    await writeFile(join(home, '.local/bin/graphify'), '#!/bin/sh\necho "graphify 0.9.70"\n');
    await chmod(join(home, '.local/bin/graphify'), 0o755);
    expect(findTool('graphify', { HOME: home })).toBe(join(home, '.local/bin/graphify'));
    expect(await graphifyVersion({ HOME: home, PATH: '/usr/bin:/bin' })).toBe('0.9.70');
    expect(await graphifyVersion({ PATH: '/definitely/not/here' })).toBeNull();
    expect(await graphifyVersion({}, fakeRunner)).toBe('0.9.66');
  });

  it('starts the coder\'s map server as installed when it can, through pinned uvx when it cannot, or not at all', async () => {
    const home = await mkdtemp(join(tmpdir(), 'graph-mcp-'));
    const bin = join(home, '.local/bin');
    const venv = join(home, 'venv');
    await mkdir(bin, { recursive: true });
    await mkdir(join(venv, 'bin'), { recursive: true });
    await mkdir(join(venv, 'lib/python3.12/site-packages'), { recursive: true });
    await writeFile(join(bin, 'graphify-mcp'), `#!${venv}/bin/python\nimport sys\n`);
    expect(mcpCommand('/g/graph.json', { HOME: home })).toBeNull();
    await writeFile(join(bin, 'uvx'), '');
    expect(mcpCommand('/g/graph.json', { HOME: home })).toEqual([join(bin, 'uvx'), '--from', 'graphifyy[mcp]==0.9.66', 'graphify-mcp', '/g/graph.json']);
    await mkdir(join(venv, 'lib/python3.12/site-packages/mcp'));
    expect(mcpCommand('/g/graph.json', { HOME: home })).toEqual([join(bin, 'graphify-mcp'), '/g/graph.json']);
  });
});

// The slice in fake mode on a throwaway workspace: a real store, a coder card wired to "build", the made-up Graphify.
async function setup(wiredTo = 'build') {
  const workspace = await mkdtemp(join(tmpdir(), 'graph-slice-'));
  const folder = await mkdtemp(join(tmpdir(), 'graph-folder-'));
  const store = createStore(workspace);
  const stage = await store.loadStage();
  stage.cards = [{ id: 'coder-1', kind: 'project', path: folder, x: 0, y: 0, w: 1, h: 1 }];
  stage.wires.push({ id: 'w', from: wiredTo, fromHandle: 'r', to: 'coder-1', toHandle: 'l' });
  await store.saveStage(stage);
  const answered: { status: number; body: any }[] = [];
  const deps = {
    workspace, root: workspace, fake: true, store,
    approvals: { ask: async () => ({ ok: true }), answer: () => true }, attention: { raise: async () => {}, clear: async () => {} },
    json: (_res: ServerResponse, status: number, body: unknown) => { answered.push({ status, body }); },
    body: async () => ({}),
  } as unknown as Deps;
  const heard: { channel: string; data: CoderEvent }[] = [];
  hub.say = (channel, data) => heard.push({ channel, data: data as CoderEvent });
  const part = await graph.install(deps);
  const tool = (name: string) => part.tools!.find((one) => one.name === name)!;
  const context = async (): Promise<ToolContext> => ({ stage: await store.loadStage(), roomId: 'build', store, granted: new Map() });
  const written: { head?: Record<string, string>; body?: Buffer } = {};
  const res = { writeHead: (_status: number, head: Record<string, string>) => { written.head = head; }, end: (body: Buffer) => { written.body = body; } } as unknown as ServerResponse;
  const call = (path: string, method = 'GET') => part.route!({ method } as IncomingMessage, res, path);
  const until = async (check: () => boolean) => { for (let tries = 0; tries < 200 && !check(); tries += 1) await new Promise((settle) => setTimeout(settle, 10)); expect(check()).toBe(true); };
  return { deps, part, store, folder, workspace, heard, answered, tool, context, call, written, until };
}

let closing: (() => Promise<void>) | undefined;
afterEach(async () => { await closing?.(); closing = undefined; });

describe('the map on a coder card', () => {
  it('is offered only to a person wired to a coder card', async () => {
    const { part, store } = await setup();
    const stage = await store.loadStage();
    const names = (roomId: string) => part.offer!(part.tools!, stage, roomId).map((one: Tool) => one.name);
    expect(names('build')).toEqual(['map_folder', 'ask_graph', 'affected_by']);
    expect(names('marketing')).toEqual([]);
  });

  it('asks the founder the first time, maps, keeps the counts on the card, and re-maps without asking', async () => {
    const { tool, context, folder, store, heard, workspace } = await setup();
    const map = tool('map_folder');
    const approval = map.approval as (args: Record<string, unknown>, context: ToolContext) => Promise<string | null>;
    expect(await approval({}, await context())).toBe(`Map ${folder} with Graphify? It reads the code on this machine, with no AI, and keeps the map in the app's own folder.`);
    const said = await map.run({}, await context());
    expect(said.text).toMatch(/^Map of graph-folder-\w+, made at \d\d:\d\d\. 5 nodes, 7 links, 2 groups\.\nMost connected: a\(\), /);
    expect(said.text).toContain('Next: ask_graph');
    // The folder itself is never written in; the map sits in the workspace.
    expect(await readdir(folder)).toEqual([]);
    expect(existsSync(graphJson(workspace, folder))).toBe(true);
    expect((await store.loadStage()).cards?.[0]).toMatchObject({ graph: { nodes: 5, edges: 7, communities: 2 } });
    // Its lines are on the card, like the coder's steps, and the card is told when it starts, ends and what it made.
    const lines = heard.filter((one) => one.channel === 'coder:coder-1' && one.data.line).map((one) => one.data.line!.text);
    expect(lines[0]).toMatch(/^map graph-folder-/);
    expect(lines).toContain('map Rebuilt: 5 nodes, 7 edges, 2 communities');
    expect(lines.at(-1)).toMatch(/^mapped · 5 nodes · 7 links · 2 groups · \d+ s$/);
    expect(heard.filter((one) => one.data.mapping !== undefined).map((one) => one.data.mapping)).toEqual([true, false]);
    expect(heard.find((one) => one.data.graph)?.data.graph).toMatchObject({ nodes: 5 });
    expect(await approval({}, await context())).toBeNull();
  });

  it('answers questions and traces what depends on a name, dated, and says so when there is no map yet', async () => {
    const { tool, context } = await setup();
    expect((await tool('ask_graph').run({ question: 'how are tools registered' }, await context())).text).toBe(NO_MAP);
    expect((await tool('affected_by').run({ name: 'b' }, await context())).text).toBe(NO_MAP);
    await tool('map_folder').run({}, await context());
    const asked = (await tool('ask_graph').run({ question: 'what calls b', budget: 99_999 }, await context())).text;
    expect(asked).toMatch(/^Map of graph-folder-\w+, made at \d\d:\d\d\.\nTraversal: BFS/);
    expect(asked).toContain('EDGE a() --calls');
    expect((await tool('affected_by').run({ name: 'b()' }, await context())).text).toContain('Affected nodes for b()');
    await expect(tool('ask_graph').run({ question: '  ' }, await context())).rejects.toThrow('say what to ask the map');
  });

  it('refuses a person with no coder card, in a sentence', async () => {
    const { tool, context } = await setup('marketing');
    await expect(tool('map_folder').run({}, await context())).rejects.toThrow('no coder card is connected to your room');
  });

  it('maps from the card\'s button and tells the card what it has, and serves the drawing sandboxed', async () => {
    const { call, answered, until, heard, written } = await setup();
    await call('/api/coder/coder-1/graph');
    expect(answered.at(-1)).toMatchObject({ status: 200, body: { mapped: false, mapping: false } });
    await call('/api/coder/coder-1/graph.html');
    expect(answered.at(-1)?.status).toBe(404);
    await call('/api/coder/coder-1/map', 'POST');
    expect(answered.at(-1)).toMatchObject({ status: 202 });
    await until(() => heard.some((one) => one.data.mapping === false));
    await call('/api/coder/coder-1/graph');
    const view = answered.at(-1)!.body;
    expect(view).toMatchObject({ mapped: true, mapping: false, nodes: 5, edges: 7, communities: 2, page: '/api/coder/coder-1/graph.html' });
    expect(view.report).toMatch(/^# Graph Report - shop/);
    expect(view.report.length).toBeLessThanOrEqual(600);
    expect(view.html).toMatch(/graphify-out\/graph\.html$/);
    await call('/api/coder/coder-1/graph.html');
    expect(written.head?.['content-security-policy']).toContain('sandbox allow-scripts');
    expect(String(written.body)).toContain('A made-up map');
    await call('/api/coder/nobody/graph');
    expect(answered.at(-1)?.status).toBe(404);
  });
});

describe('the map and the coder together', () => {
  it('keeps map lines in the coder\'s own log, so a window opened later still sees them', async () => {
    const one = await setup();
    const coder = await opencode.install(one.deps);
    closing = async () => { await coder.close?.(); };
    await one.tool('map_folder').run({}, await one.context());
    const opened = (await Promise.all(hub.opening.map((open) => open()))).flat().find((entry) => entry.channel === 'coder:coder-1');
    const lines = (opened?.data as CoderEvent).lines!.map((line) => line.text);
    expect(lines).toContain('map Rebuilt: 5 nodes, 7 edges, 2 communities');
    expect(lines.at(-1)).toMatch(/^mapped · 5 nodes/);
  });
});
