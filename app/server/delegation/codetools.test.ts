import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolEffect } from '../../shared/model.ts';
import { offerToolsToCode, runCode } from '../sandbox.ts';
import { createSeams } from '../seams.ts';
import type { Tool, ToolContext } from '../tools/registry.ts';
import { CALL_LIMIT, createCodeTools } from './codetools.ts';

const tool = (name: string, extra: Partial<Tool> = {}): Tool => ({
  name, description: name, parameters: {},
  async run(args) { return { text: `${name} says ${JSON.stringify(args)}` }; }, ...extra,
} as Tool);

const THEIRS = [
  tool('look'),
  tool('send', { approval: true }),
  tool('browse', { approval: async () => 'Allow this step?' }),
  tool('unready', { ready: () => 'Set up the mailbox first.' }),
  tool('moves', { async run() { return { text: 'moved', effect: { kind: 'doc-changed', id: 'brand-doc' } as ToolEffect }; } }),
  tool('run_code'),
  tool('delegate_task'),
];

function bridge(theirs: Tool[] = THEIRS) {
  const effects: ToolEffect[] = [];
  const seen: string[] = [];
  const seams = createSeams();
  seams.on('tool:before', async (payload, next) => { seen.push(`before ${payload.call.name}`); return next(payload); });
  seams.on('tool:after', async (payload, next) => { seen.push(`after ${payload.event.name} ${payload.event.ok}`); return next(payload); });
  const context = { roomId: 'marketing', granted: new Map(), report: (effect: ToolEffect) => effects.push(effect) } as unknown as ToolContext;
  return { effects, seen, context, seams, tools: createCodeTools({ toolsFor: () => theirs, seams })(context) };
}

describe('the tools code can call', () => {
  afterEach(() => { offerToolsToCode(null); });

  it('offers what the person has, never itself and never a hand-over', () => {
    expect(bridge().tools!.names).toEqual(['look', 'send', 'browse', 'unready', 'moves']);
    expect(createCodeTools({ toolsFor: () => [] })({} as ToolContext)).toBeNull();
  });

  it('runs a call the way a turn runs one, through both seams', async () => {
    const { tools, seen } = bridge();
    expect(await tools!.call('look', { at: 'the numbers' })).toEqual({ ok: true, text: 'look says {"at":"the numbers"}' });
    expect(seen).toEqual(['before look', 'after look true']);
  });

  it('will not run anything the founder has to say yes to', async () => {
    const { tools, seen } = bridge();
    for (const name of ['send', 'browse']) {
      expect(await tools!.call(name, {})).toEqual({ ok: false, text: `${name} needs the founder's yes, so it cannot run from code. Ask for it as a step of your own.` });
    }
    // Refused before anything else looks at it: a step nobody will approve is not a step.
    expect(seen).toEqual([]);
  });

  it('says what is not there and what is not ready', async () => {
    const { tools } = bridge();
    expect((await tools!.call('nope', {})).text).toMatch(/no such tool: nope\. From code you can call: look, send/);
    expect(await tools!.call('unready', {})).toEqual({ ok: false, text: 'Set up the mailbox first.' });
  });

  it('mirrors what a call moved on the stage, under the receipt the founder is watching', async () => {
    const { tools, effects } = bridge();
    await tools!.call('moves', {});
    expect(effects).toEqual([{ kind: 'doc-changed', id: 'brand-doc' }]);
  });

  it('stops at twenty calls and says to print what it has', async () => {
    const { tools } = bridge();
    for (let at = 0; at < CALL_LIMIT; at += 1) expect((await tools!.call('look', { at })).ok).toBe(true);
    expect(await tools!.call('look', {})).toEqual({ ok: false, text: `That is ${CALL_LIMIT} tool calls from one piece of code, which is the limit. Work with what you have and print it.` });
  });

  it('reaches javascript in the sandbox, and the founder reads what it called', async () => {
    const { context, tools } = bridge();
    offerToolsToCode(() => tools);
    const result = await runCode({
      language: 'javascript',
      code: "console.log(tools.names.join('|'));\nconsole.log(tools.call('look', { n: 1 }));\ntry { tools.call('send', {}); } catch (error) { console.log('refused:', error.message); }",
    }, await mkdtemp(join(tmpdir(), 'codetools-')), undefined, context);
    expect(result.output).toContain('look|send|browse|unready|moves');
    expect(result.output).toContain('look says {"n":1}');
    expect(result.output).toContain("refused: send needs the founder's yes");
    expect(result.output).toContain('Tools you called from the code:\n- look {"n":1} — ok\n- send {} — no');
    expect(result.ok).toBe(true);
  }, 60_000);

  it('reaches python the same way, and the code that never asks is untouched', async () => {
    const { context, tools } = bridge();
    offerToolsToCode(() => tools);
    const dir = await mkdtemp(join(tmpdir(), 'codetools-'));
    const result = await runCode({ language: 'python', code: "print(len(tools.names))\nprint(tools.call('look', {'n': 2}))" }, dir, undefined, context);
    expect(result).toEqual({ ok: true, output: '5\nlook says {"n":2}\nTools you called from the code:\n- look {"n":2} — ok' });
    // Nothing is offered when nobody put a maker there, and the run is exactly what it was before any of this.
    offerToolsToCode(null);
    expect(await runCode({ language: 'javascript', code: 'console.log(1 + 1); void 0' }, dir, undefined, context)).toEqual({ ok: true, output: '2' });
  }, 120_000);
});
