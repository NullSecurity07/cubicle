import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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
    const reply = await answerCase({
      team: { rooms: [{ key: 'pricer', name: 'Rhea', role: 'Pricer', brief: 'Set the price.', accent: '#000' }], docs: [], wires: [] } as never,
      noteIds: [], key: 'pricer', brief: 'Set the price.', input: 'What should we charge?', passages: [],
      store: createStore(await mkdtemp(join(tmpdir(), 'answer-'))), clients: [client], usage: createUsage(null),
    });
    expect(reply.text).toBe("Charge $29 a month. I've saved the plan.");
  });
});
