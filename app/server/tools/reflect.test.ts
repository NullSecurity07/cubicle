import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDecisions } from '../decisions.ts';
import { gatherPieces } from '../gather.ts';
import { createRecall, wordEmbedder } from '../recall.ts';
import { createStore } from '../store.ts';
import { changesOf, figureOf, keywordsOf, memoryEntries, reflectTools, timeline } from './reflect.ts';
import { runTool, type ToolContext } from './registry.ts';

const AUGUST = new Date(2026, 7, 12, 10).getTime();
const SEPTEMBER = new Date(2026, 8, 3, 16).getTime();

async function setup(notes: string) {
  const dir = await mkdtemp(join(tmpdir(), 'reflect-'));
  const store = createStore(dir);
  const stage = await store.loadStage();
  const decisions = createDecisions(dir, () => SEPTEMBER);
  await decisions.record({ title: 'Monthly price', context: 'Pilots pay without asking twice.', options: [], chosen: 'Raise the price to 19 a month.', why: '' });
  await store.appendChat('marketing', { id: 'm1', role: 'user', text: 'Set the price to 15 a month for the pilots.', at: AUGUST });
  await store.appendChat('marketing', { id: 'm2', role: 'assistant', text: 'Done: the price is 15 a month.', at: AUGUST });
  const memory = { read: async () => ({ notes, summary: '' }) };
  const recall = createRecall({ dir, embed: wordEmbedder, gather: gatherPieces(store, decisions, memory.read) });
  const tools = reflectTools({ recall, decisions, memory });
  const ask = (about: string) => runTool(tools, 'reflect', JSON.stringify({ about }), { stage, roomId: 'marketing', store, granted: new Map() } as ToolContext);
  return { ask };
}

describe('reflect', () => {
  it('lays out what is known oldest first, the undated at the end, and says what changed', async () => {
    const { ask } = await setup('- 24 Sept 2026 · (kept on its own) the price is 19 a month\n- the founder likes a table\n- price talks go through the founder');
    const said = (await ask('our price')).text;
    const conversation = said.indexOf('[12 Aug 2026 · Conversation]');
    const decision = said.indexOf('[3 Sept 2026 · Decision] Monthly price: Raise the price to 19 a month.');
    const kept = said.indexOf('[24 Sept 2026 · Your memory] (kept on its own) the price is 19 a month');
    expect(conversation).toBeGreaterThanOrEqual(0);
    expect(decision).toBeGreaterThan(conversation);
    expect(kept).toBeGreaterThan(decision);
    expect(said).toContain('Undated:\n[Your memory] price talks go through the founder');
    expect(said).not.toContain('likes a table');
    expect(said.trim().split('\n').at(-1)).toBe('Changed over time: 15 (12 Aug 2026) → 19 (3 Sept 2026). The latest is 19.');
    expect(said.length).toBeLessThanOrEqual(2500);
  });

  it('says so when nothing is written down', async () => {
    const { ask } = await setup('');
    expect((await ask('the office cat')).text).toBe('Nothing written down about that. Ask the founder rather than guess.');
  });
});

describe('the parts of reflect', () => {
  it('finds the figure said about the subject, never a year or a day of the month', () => {
    expect(figureOf('price set to 15 on 12 Aug', 'price')).toBe('15');
    expect(figureOf('prices went up in 2026 to 19%', 'price')).toBe('19%');
    expect(figureOf('the price, agreed on 3 Sept', 'price')).toBeUndefined();
    expect(figureOf('15 seats', 'price')).toBeUndefined();
  });

  it('says a change only when the figure really moved', () => {
    const keys = keywordsOf('the price');
    expect(changesOf([{ at: 1, where: 'x', text: 'price 15' }, { at: 2, where: 'x', text: 'price 15' }], keys)).toEqual([]);
    expect(changesOf([{ at: AUGUST, where: 'x', text: 'price 15' }, { at: SEPTEMBER, where: 'x', text: 'the price is now 19' }, { at: SEPTEMBER + 1, where: 'x', text: 'price 19' }], keys))
      .toEqual(['Changed over time: 15 (12 Aug 2026) → 19 (3 Sept 2026). The latest is 19.']);
  });

  it('reads the day off a memory line and keeps a line without one undated', () => {
    const entries = memoryEntries('- 3 Sept 2026 · launch date is 1 Oct\n- launch in the spring', keywordsOf('launch'));
    expect(entries[0]).toEqual({ at: new Date(2026, 8, 3).getTime(), where: 'Your memory', text: 'launch date is 1 Oct' });
    expect(entries[1]).toEqual({ where: 'Your memory', text: 'launch in the spring' });
  });

  it('stays inside its cap', () => {
    const many = Array.from({ length: 60 }, (_, index) => ({ at: index, where: 'Conversation', text: `price note ${'x'.repeat(80)} ${index}` }));
    const said = timeline(many, keywordsOf('price'));
    expect(said.length).toBeLessThanOrEqual(2500);
    expect(said).toContain('ask about something narrower');
  });
});
