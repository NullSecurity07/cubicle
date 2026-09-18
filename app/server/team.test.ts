import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runTurn } from './loop.ts';
import type { ModelClient } from './providers.ts';
import { createStore } from './store.ts';
import { teamTools } from './tools/team.ts';
import { createUsage } from './usage.ts';

const asks = (list: { name: string; question: string }[]): ModelClient => {
  let step = 0;
  return { name: 's', model: 's', maxPromptChars: Infinity, tools: true, limits: {}, async step(_m, { onToken }) {
    step += 1;
    if (step === 1) return { text: '', calls: list.map((args, index) => ({ id: `c${index}`, name: 'ask_person', args: JSON.stringify(args) })) };
    onToken('ok'); return { text: '', calls: [] };
  } };
};

async function turn(wire: boolean, list: { name: string; question: string }[]) {
  const store = createStore(await mkdtemp(join(tmpdir(), 'team-')));
  const stage = await store.loadStage();
  if (wire) stage.wires.push({ id: 't', from: 'marketing', fromHandle: 'b', to: 'build', toHandle: 't' });
  const consulted: unknown[] = [];
  const result = await runTurn({
    messages: [{ role: 'user', content: 'go' }], clients: [asks(list)], usage: createUsage(null),
    tools: teamTools(async (input) => { consulted.push({ from: input.fromRoomId, to: input.toRoomId, question: input.question }); return 'Two weeks.'; }),
    context: { stage, roomId: 'marketing', store, granted: new Map() }, events: { token: () => {}, tool: () => {} },
  });
  return { result, consulted };
}

describe('ask_person', () => {
  it('puts the question to a wired colleague, by name in any case, and tells their room to refresh', async () => {
    const { result, consulted } = await turn(true, [{ name: 'dev', question: 'How long for SSO?' }]);
    expect(consulted).toEqual([{ from: 'marketing', to: 'build', question: 'How long for SSO?' }]);
    expect(result.tools[0]).toMatchObject({ ok: true, result: 'Dev answered:\nTwo weeks.', effect: { kind: 'chat-changed', id: 'build' } });
  });

  it('reaches nobody without a wire, and says how the founder connects people', async () => {
    const { result, consulted } = await turn(false, [{ name: 'Dev', question: 'x' }]);
    expect(consulted).toEqual([]);
    expect(result.tools[0].result).toMatch(/no colleague called "Dev".*Connected: nobody.*drawing a wire/);
  });

  it('allows two consults a turn, not a third', async () => {
    const { result } = await turn(true, [{ name: 'Dev', question: 'a' }, { name: 'Dev', question: 'b' }, { name: 'Dev', question: 'c' }]);
    expect(result.tools.map((tool) => tool.ok)).toEqual([true, true, false]);
  });
});
