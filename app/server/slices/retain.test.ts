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
// The founder gives the figures: a figure only the person said is never kept.
const ASKED = 'We talked it over with the two pilots this morning, and I have made up my mind: we charge 19 a month from now on, and 190 for the year.';
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

  // Journey 9: Ananya kept "10 non-paying beta users contacted for testing", a figure and an action nobody backed.
  it('never shows the model a flagged sentence, and never keeps a figure only the person said', async () => {
    const flagged = 'The €19 tier suits hobby hosts and I would keep the €39 Pro tier beside it for now. 10 non-paying beta users contacted for testing.\n\n'
      + 'Unsourced figures: 10 (not found in anything this turn read).';
    const { retain, memory, asked, store } = await setup('- 10 non-paying beta users contacted for testing\n- Churn among hosts runs at 30% a month\n- The founder picked the €19 tier for hobby hosts');
    await store.appendChat('marketing', { id: 'f1', role: 'user', text: 'Let us go with €19 for hobby hosts.', at: NOON - 60_000 });
    expect(await retain.retain(turn({ query: 'We have 12 beta users and 2 of them pay. Which tier should hobby hosts get, and what do you make of it?', text: flagged }))).toEqual(['The founder picked the €19 tier for hobby hosts']);
    expect(asked[0][1].content).not.toContain('contacted');
    expect(asked[0][1].content).not.toContain('Unsourced');
    expect((await memory.read('marketing')).notes).not.toMatch(/contacted|30%/);
  });

  // Journey 10: Priya's chat said "leans toward [not written]", but retain kept "LEANS TOWARD PIVOT REQUIRED" in her memory.
  it('keeps no verdict word or score while the team doc holds no verdict', async () => {
    const { readFile } = await import('node:fs/promises');
    const { resolve } = await import('node:path');
    const { place } = await import('../frameworks/place.ts');
    const framework = JSON.parse(await readFile(resolve(import.meta.dirname, '../../frameworks/startup-evaluation/framework.json'), 'utf8'));
    const lean = 'Assumption: 1/2, Pain: 1/2. With section 4 empty I cannot write a verdict, but it leans toward PIVOT REQUIRED due to low customer conversation count; 5/10 so far.';
    const { retain, memory, asked, store } = await setup('- LEANS TOWARD PIVOT REQUIRED due to low customer conversation count\n- Section 4, founder-market fit, is still empty and Rohan owns it');
    const seed = await store.loadStage();
    const { placed, texts } = place(framework, seed, { x: 2000, y: 0 });
    await store.saveStage({ ...seed, rooms: [...seed.rooms, ...placed.rooms], docs: [...seed.docs, ...placed.docs], wires: [...seed.wires, ...placed.wires], cards: [...(seed.cards ?? []), ...placed.cards] });
    for (const [id, text] of Object.entries(texts)) await store.replaceDoc(id, text as string);
    const kept = await retain.retain(turn({ roomId: 'verdict', query: 'Score each part out of 2 for me, and tell me which way the verdict leans right now please.', text: lean }));
    expect(asked[0][1].content).not.toMatch(/PIVOT REQUIRED|5\/10|1\/2/);
    expect(asked[0][1].content).toContain('[not written]');
    expect(kept).toEqual(['Section 4, founder-market fit, is still empty and Rohan owns it']);
    expect((await memory.read('verdict')).notes).not.toMatch(/PIVOT|not written/i);
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

  it('sees a remember from the same turn that lands while the model is still reading', async () => {
    const store = createStore(await mkdtemp(join(tmpdir(), 'retain-')));
    const memory = createMemory(store, async () => '', () => NOON);
    const retain = createRetain({
      memory, store, changed: () => {}, log: () => {}, now: () => NOON,
      extract: async () => {
        await memory.remember('marketing', 'Our first-year pilots pay 190 and get onboarding calls every week');
        return '- 24 September 2026 - Our first-year pilots pay 190 and get onboarding calls weekly\n- 1 October 2026\n- Maya: Got it…\n- The pilots start in October';
      },
    });
    expect(await retain.retain(turn())).toEqual(['The pilots start in October']);
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
    expect(parseFacts('Here are the facts:\n1. Price is 19 for now\n* Launch on 1 Oct\n- NONE\n' + `- ${'y'.repeat(201)}\n- Maya\n- The pilots pay monthly\n- Priya is the first pilot`)).toEqual(['Price is 19 for now', 'The pilots pay monthly', 'Priya is the first pilot']);
    expect(parseFacts('NONE')).toEqual([]);
    // What the local model really wrote on the live check for an exchange with nothing lasting in it.
    expect(parseFacts('NONE  \n24 September 2026  \nMaya')).toEqual([]);
  });

  // What qwen2.5:7b really wrote on the live check of 24 September 2026.
  it('drops a bare date, a label with only a date, and a speaker echoing the exchange', () => {
    expect(parseFacts('- 1 October 2026')).toEqual([]);
    expect(parseFacts('- Effective date: 1 Oct 2026')).toEqual([]);
    expect(parseFacts('- Maya: Got it…', ['Maya', 'Founder'])).toEqual([]);
    expect(parseFacts('- Launch: 2026-10-01')).toEqual([]);
  });

  it('takes the date or the speaker off the front of a line and keeps the fact', () => {
    expect(parseFacts('- 24 September 2026 - Our first-year price is 190 for the two pilots')).toEqual(['Our first-year price is 190 for the two pilots']);
    expect(parseFacts('- 2026-09-24: The pilots pay by card')).toEqual(['The pilots pay by card']);
    expect(parseFacts('- Maya: the deck goes to both pilots on Friday', ['Maya', 'Founder'])).toEqual(['the deck goes to both pilots on Friday']);
    // A date inside the line is part of the fact.
    expect(parseFacts('- The launch is on 1 October 2026')).toEqual(['The launch is on 1 October 2026']);
  });

  it('matches a known fact on its words, not its punctuation or its date', () => {
    const notes = '- 3 Sept 2026 · (kept on its own) price: 19 a month\n- the founder likes tables';
    expect(isKnown('The price is 19 a month', notes)).toBe(true);
    expect(isKnown('The price is 25 a month', notes)).toBe(false);
    expect(isKnown('From 1 October 2026 the price is 19 a month', notes)).toBe(true);
  });

  it('calls a line known when seven in ten of its words are in a line the person remembered', () => {
    const notes = '- 24 Sept 2026 · Our first-year pilots pay 190 and get onboarding calls every week';
    expect(isKnown('24 September 2026 - Our first-year pilots pay 190 and get onboarding calls weekly', notes)).toBe(true);
    expect(isKnown('Our first-year pilots pay 190 and get a shared Slack channel', notes)).toBe(false);
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

  // Journey 15: the founder said "break-even is 50 print jobs a month, not 50 paying hosts", and the notes kept
  // "Break-even point: 50 paying hosts" and said it again after.
  it('takes a figure the founder corrected out of the notes, and never keeps it again', async () => {
    const { retain, memory } = await setup('- Break-even point: 50 paying hosts\n- The founder wants a kill signal tied to the 10-jobs goal');
    await memory.remember('marketing', '(kept on its own) Break-even point: 50 paying hosts');
    await memory.remember('marketing', '(kept on its own) Price is €12 per print job');
    const query = "I don't buy it. Break-even is 50 print jobs a month, not 50 paying hosts: one host is not €12 a month of revenue. Tie the kill signal to my 10-jobs goal.";
    const kept = await retain.retain(turn({ query, text: 'Fair: break-even is 50 print jobs a month. Kill signal tied to the 10-jobs goal.' }));
    const { notes } = await memory.read('marketing');
    expect(notes).not.toContain('50 paying hosts');
    expect(notes).toContain('Price is €12 per print job');
    expect(kept.join('\n')).not.toContain('paying hosts');
  });
});
