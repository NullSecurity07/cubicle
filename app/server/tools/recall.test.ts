import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { shortDay } from '../clock.ts';
import { createDecisions } from '../decisions.ts';
import { gatherPieces } from '../gather.ts';
import { createRecall, wordEmbedder } from '../recall.ts';
import { createStore } from '../store.ts';
import { recallTools } from './recall.ts';
import { runTool, type ToolContext } from './registry.ts';

// Recall is the one tool whose whole purpose is reaching back, so what it brings back has to say when it is from.
const JUNE = new Date(2026, 5, 2, 10, 0).getTime();
const JULY = new Date(2026, 6, 14, 9, 30).getTime();
const SEPTEMBER = new Date(2026, 8, 3, 16, 0).getTime();

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'recall-tools-'));
  const store = createStore(dir);
  const stage = await store.loadStage();
  const decisions = createDecisions(dir, () => JUNE);
  await decisions.record({ title: 'Launch channel', context: '', options: [], chosen: 'Hacker News.', why: 'Our first fifty users came from there.' });
  await store.writeDoc('brand-doc', '# Brand\n\nVoice: calm, plain words, no hype.');
  const said = (id: string, role: 'user' | 'assistant', text: string, at: number) => store.appendChat('marketing', { id, role, text, at });
  await said('m1', 'user', 'What did the two pilots say about pricing?', JULY);
  await said('m2', 'assistant', 'Both pilots asked to be charged for what they use.', JULY);
  await said('m3', 'user', 'Book a venue for the launch party.', SEPTEMBER);
  const memory = async () => ({ notes: 'The founder prefers a table to a paragraph.', summary: '' });
  const recall = createRecall({ dir, embed: wordEmbedder, gather: gatherPieces(store, decisions, memory) });
  const tools = recallTools(recall);
  // A fresh turn each time, so the cap on how often one person may recall is not in the way.
  const ask = (query: string) => runTool(tools, 'recall', JSON.stringify({ query }), { stage, roomId: 'marketing', store, granted: new Map() } as ToolContext);
  return { ask };
}

describe('what recall hands back', () => {
  it('says the day a conversation was had, and it is the day that talk happened, not the last day anybody spoke', async () => {
    const { ask } = await setup();
    const found = await ask('what did the two pilots say about being charged');
    expect(found.text).toContain('charged for what they use');
    expect(found.text).toContain('said on 14 Jul 2026');
    // The party was booked in September. A conversation held in July must not come back wearing September's date.
    expect(found.text).not.toContain('3 Sept 2026');
  });

  it('dates a decision by the day it was decided, and a document by the day it was last written', async () => {
    const { ask } = await setup();
    expect((await ask('which launch channel was chosen')).text).toContain('[Decision: Launch channel, decided on 2 Jun 2026]');
    expect((await ask('what is the brand voice')).text).toContain(`[Doc: Brand doc, last changed ${shortDay(Date.now())}]`);
  });

  it('says nothing about when for a memory, which keeps no date of its own', async () => {
    const { ask } = await setup();
    expect((await ask('does the founder want a table or a paragraph')).text).toContain('[Your memory: What Maya remembers]\n');
  });
});
