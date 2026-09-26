import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runTurn } from '../loop.ts';
import type { ModelClient } from '../providers.ts';
import { createStore } from '../store.ts';
import { createUsage } from '../usage.ts';
import { answerCase } from './answer.ts';

describe('answerCase', () => {
  it('hands the judge the person\'s words without the truth net\'s lines under them', async () => {
    const client: ModelClient = {
      name: 'script', model: 's-1', maxPromptChars: Infinity, tools: true, limits: {},
      async step(_messages, { onToken }) { onToken("Charge $29 a month. I've saved the plan."); return { text: '', calls: [] }; },
    };
    const store = createStore(await mkdtemp(join(tmpdir(), 'answer-')));
    // The same words through a plain turn do carry both lines, so the answer below had them to lose.
    const plain = await runTurn({
      messages: [{ role: 'user', content: 'What should we charge?' }], tools: [], clients: [client], usage: createUsage(null),
      context: { stage: await store.loadStage(), roomId: 'build', store, granted: new Map() }, events: { token: () => {}, tool: () => {} },
    });
    expect(plain.text).toMatch(/\n\nUnconfirmed: .*\n\nUnsourced figures: \$29 /s);
    const reply = await answerCase({
      team: { rooms: [{ key: 'pricer', name: 'Rhea', role: 'Pricer', brief: 'Set the price.', accent: '#000' }], docs: [], wires: [] } as never,
      noteIds: [], key: 'pricer', brief: 'Set the price.', input: 'What should we charge?', passages: [],
      store, clients: [client], usage: createUsage(null),
    });
    expect(reply.text).toBe("Charge $29 a month. I've saved the plan.");
    expect(reply.text).not.toMatch(/Unconfirmed|Unsourced/);
  });
});
