import { mkdtemp, mkdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ToolEvent } from '../shared/model.ts';
import { fakeCoder, projectDir, readEvent } from './coder.ts';
import { runTurn } from './loop.ts';
import type { ModelClient } from './providers.ts';
import { createStore } from './store.ts';
import { projectTools } from './tools/project.ts';
import { createUsage } from './usage.ts';

describe('projectDir', () => {
  it('takes a real folder and refuses what is missing, relative or far too broad', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'proj-'));
    await mkdir(join(dir, 'app', 'workspace'), { recursive: true });
    expect(projectDir(`${dir}/app/`)).toBe(join(dir, 'app'));
    expect(() => projectDir('')).toThrow(/full folder path/);
    expect(() => projectDir('code/app')).toThrow(/full folder path/);
    expect(() => projectDir(join(dir, 'nope'))).toThrow(/no folder/);
    expect(() => projectDir('/')).toThrow(/too broad/);
    expect(() => projectDir(homedir())).toThrow(/too broad/);
    expect(() => projectDir('~')).toThrow(/too broad/);
    expect(() => projectDir(join(dir, 'app'), [join(dir, 'app', 'workspace')])).toThrow(/too broad/);
  });
});

describe('readEvent', () => {
  it('turns harness events into lines a founder can read', () => {
    expect(readEvent(JSON.stringify({ type: 'tool_use', part: { tool: 'bash', state: { status: 'completed', input: { command: 'node --test\n  math.test.js' } } } }))).toEqual({ log: 'bash node --test math.test.js' });
    expect(readEvent(JSON.stringify({ type: 'tool_use', part: { tool: 'edit', state: { status: 'completed', title: 'math.js', input: { filePath: '/p/math.js' } } } }))).toEqual({ log: 'edit math.js' });
    expect(readEvent(JSON.stringify({ type: 'text', part: { text: ' Done. ' } }))).toEqual({ text: 'Done.' });
    expect(readEvent(JSON.stringify({ type: 'step_start' }))).toBeNull();
    expect(readEvent(JSON.stringify({ type: 'tool_use', part: { tool: 'bash', state: { status: 'running' } } }))).toBeNull();
    expect(readEvent('not json')).toBeNull();
  });
});

describe('delegate_coding', () => {
  const client = (task: string): ModelClient => {
    let step = 0;
    return { name: 's', model: 's', maxPromptChars: Infinity, tools: true, limits: {}, async step(_m, { onToken }) {
      step += 1;
      if (step === 1) return { text: '', calls: [{ id: 'c1', name: 'delegate_coding', args: JSON.stringify({ task }) }] };
      onToken('ok'); return { text: '', calls: [] };
    } };
  };
  async function run(wiredTo: string, path: string, approve = true) {
    const store = createStore(await mkdtemp(join(tmpdir(), 'coder-')));
    const stage = await store.loadStage();
    stage.cards = [{ id: 'proj', kind: 'project', path, x: 0, y: 0, w: 1, h: 1 }];
    stage.wires.push({ id: 'w', from: wiredTo, fromHandle: 'r', to: 'proj', toHandle: 'l' });
    const events: ToolEvent[] = [];
    const result = await runTurn({
      messages: [{ role: 'user', content: 'go' }], tools: projectTools(fakeCoder, []), clients: [client('Fix the add bug')], usage: createUsage(null),
      approve: async () => ({ ok: approve }), context: { stage, roomId: 'build', store, granted: new Map() }, events: { token: () => {}, tool: (event) => events.push(event) },
    });
    return { result, events };
  }

  it('asks the founder with the folder named, streams the steps to the card, and reports the changed files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'proj-'));
    const { result, events } = await run('build', dir);
    expect(events[0]).toMatchObject({ waiting: true, question: `Start this coding task in ${dir}?` });
    expect(events.filter((event) => event.effect?.kind === 'project-progress' && event.ok === undefined).map((event) => (event.effect as { line: string }).line)).toEqual(['fake-coder · model none', 'edit src/example.ts']);
    expect(result.tools[0]).toMatchObject({ ok: true, result: 'Did: Fix the add bug\nChanged: src/example.ts' });
  });

  it('does nothing without a wire, without a yes, or for a folder that is not a project', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'proj-'));
    expect((await run('marketing', dir)).result.tools[0].result).toMatch(/no project card is connected/);
    expect((await run('build', dir, false)).result.tools[0].result).toMatch(/founder said no/);
    expect((await run('build', '/')).result.tools[0].result).toMatch(/too broad/);
  });
});
