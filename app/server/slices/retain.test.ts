import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMemory } from '../memory.ts';
import type { ModelMessage } from '../prompt.ts';
import type { ModelClient } from '../providers.ts';
import type { Payloads, Source } from '../seams.ts';
import { createStore } from '../store.ts';
import { createRetain, EVERY_MS, fromDoc, isKnown, localExtract, parseFacts } from './retain.ts';

// Thursday 24 September 2026, noon where the machine is.
const NOON = new Date(2026, 8, 24, 12).getTime();
const ASKED = 'We talked it over with the two pilots this morning, and I have made up my mind about what we charge from now on.';
const SAID = 'Understood. The price is 19 a month from today, the annual plan stays at 190, and I will tell both pilots on Friday as you asked.';

const turn = (over: Partial<{ source: Source; query: string; text: string; stopped: boolean; roomId: string }> = {}): Payloads['turn:after'] => ({
  roomId: over.roomId ?? 'marketing', source: over.source ?? 'chat', query: over.query ?? ASKED,
  reply: { text: over.text ?? SAID, tools: [], provider: 'x', model: 'x', usage: { input: 0, output: 0 }, stopped: over.stopped ?? false },
});

async function setup(answer = '- The price is 19 a month from 24 Sep 2026\n- The annual plan is 190\n- Tell both pilots on Friday', extract = true) {
  const store = createStore(await mkdtemp(join(tmpdir(), 'retain-')));
  let clock = NOON;
  const memory = createMemory(store, async () => '', () => clock);
  const asked: ModelMessage[][] = [];
  const changed: string[] = [];
  const logged: string[] = [];
  const retain = createRetain({
    memory, store, changed: (roomId) => changed.push(roomId), log: (line) => logged.push(line), now: () => clock,
    ...(extract ? { extract: async (messages: ModelMessage[]) => { asked.push(messages); return answer; } } : {}),
  });
  return { store, memory, retain, asked, changed, logged, later: (ms: number) => { clock += ms; } };
}

describe('retain', () => {
  it('keeps up to three lasting facts, marked, dated, and says so to the panel and the console', async () => {
    const { retain, memory, asked, changed, logged } = await setup();
    expect(await retain.retain(turn())).toHaveLength(3);
    const { notes } = await memory.read('marketing');
    expect(notes.split('\n')).toEqual([
      '- 24 Sept 2026 · (kept on its own) The price is 19 a month from 24 Sep 2026',
      '- 24 Sept 2026 · (kept on its own) The annual plan is 190',
      '- 24 Sept 2026 · (kept on its own) Tell both pilots on Friday',
    ]);
    expect(asked[0][0].content).toContain('Today is Thursday, 24 September 2026.');
    expect(asked[0][1].content).toContain(`Founder: ${ASKED}`);
    expect(asked[0][1].content).toContain(`Maya: ${SAID}`);
    expect(changed).toEqual(['marketing']);
    expect(logged[0]).toMatch(/^retain · Maya kept 3 lines on its own/);
  });

  it('asks no model for a turn that is not the founder\'s, was stopped, or is too short', async () => {
    const { retain, asked } = await setup();
    await retain.retain(turn({ source: 'run' }));
    await retain.retain(turn({ stopped: true }));
    await retain.retain(turn({ query: 'ok, the price is 19' }));
    await retain.retain(turn({ text: 'Done.' }));
    expect(asked).toHaveLength(0);
  });

  it('waits three founder turns and ten minutes between two reads of one room', async () => {
    const { retain, asked, later } = await setup('NONE');
    await retain.retain(turn());
    later(EVERY_MS);
    await retain.retain(turn());
    await retain.retain(turn({ source: 'run' }));
    await retain.retain(turn());
    expect(asked).toHaveLength(1);
    await retain.retain(turn());
    expect(asked).toHaveLength(2);
    // Three turns have gone by, but not ten minutes.
    for (let index = 0; index < 3; index += 1) await retain.retain(turn());
    expect(asked).toHaveLength(2);
    // Another room keeps its own count.
    await retain.retain(turn({ roomId: 'research' }));
    expect(asked).toHaveLength(3);
  });

  it('leaves the last of the notes to the founder', async () => {
    const { retain, memory, asked } = await setup();
    await memory.write('marketing', { notes: `- ${'x'.repeat(3450)}` });
    await retain.retain(turn());
    expect(asked).toHaveLength(0);
  });

  it('keeps nothing twice, nothing a document already says, and nothing when the model says NONE', async () => {
    const { retain, memory, store, changed } = await setup('- price: 19 a month\n- Our customers are small family bakeries in the north of England\n- The pilots start in October');
    await memory.remember('marketing', 'The price is 19 a month');
    const stage = await store.loadStage();
    const brief = stage.docs[0];
    await store.writeDoc(brief.id, '# Brief\n\nOur customers are small family bakeries in the north of England, mostly in towns.');
    await store.saveStage({ ...stage, wires: [...stage.wires, { id: 'w', from: 'marketing', fromHandle: 'r', to: brief.id, toHandle: 'l' }] });
    expect(await retain.retain(turn())).toEqual(['The pilots start in October']);
    expect(changed).toEqual(['marketing']);
    const none = await setup('NONE');
    expect(await none.retain.retain(turn())).toEqual([]);
    expect(none.changed).toEqual([]);
  });

  it('does nothing without a model on this machine, and says so once', async () => {
    const { retain, logged, memory } = await setup(undefined, false);
    await retain.retain(turn());
    await retain.retain(turn({ roomId: 'research' }));
    expect(logged).toEqual(['retain · no model on this machine, so nothing is kept on its own']);
    expect((await memory.read('marketing')).notes).toBe('');
  });
});

describe('the parts of retain', () => {
  it('reads the model\'s lines, dropping bullets, NONE, preambles, labels and anything too long', () => {
    expect(parseFacts('Here are the facts:\n1. Price is 19\n* Launch on 1 Oct\n- NONE\n' + `- ${'y'.repeat(201)}\n- Maya\n- The pilots pay monthly\n- Priya is the first pilot`)).toEqual(['Price is 19', 'Launch on 1 Oct', 'The pilots pay monthly']);
    expect(parseFacts('NONE')).toEqual([]);
    // What the local model really wrote on the live check for an exchange with nothing lasting in it.
    expect(parseFacts('NONE  \n24 September 2026  \nMaya')).toEqual([]);
  });

  it('matches a known fact on its words, not its punctuation or its date', () => {
    const notes = '- 3 Sept 2026 · (kept on its own) price: 19 a month\n- the founder likes tables';
    expect(isKnown('The price is 19 a month', notes)).toBe(true);
    expect(isKnown('The price is 25 a month', notes)).toBe(false);
  });

  it('only calls a line copied when six or more real words run on in a document', () => {
    const doc = ['Our customers are small family bakeries in the north of England.'];
    expect(fromDoc('small family bakeries in the north of England', doc)).toBe(false);
    expect(fromDoc('customers are small family bakeries in the north of England', doc)).toBe(true);
    expect(fromDoc('customers are small family bakeries in the south of England', doc)).toBe(false);
  });

  it('asks only a model on this machine', () => {
    const hosted = { name: 'groq', local: false } as unknown as ModelClient;
    expect(localExtract([hosted])).toBeUndefined();
    expect(localExtract([hosted, { name: 'ollama', local: true } as unknown as ModelClient])).toBeTypeOf('function');
  });
});
