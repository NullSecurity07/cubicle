import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDecisions } from './decisions.ts';
import { gatherPieces } from './gather.ts';
import { nearestSkills } from './playbook.ts';
import { createRecall, wordEmbedder } from './recall.ts';
import { createSkills } from './skills.ts';
import { createStore } from './store.ts';

const by = { roomId: 'marketing', name: 'Maya' };
const source = { kind: 'run' as const, ref: 'task-1' };

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'gather-'));
  const store = createStore(dir);
  const decisions = createDecisions(dir);
  const skills = createSkills(dir);
  await store.writeDoc('brand-doc', '# Brand\n\nVoice: calm, plain words, no hype.');
  await store.appendChat('marketing', { id: 'm1', role: 'user', text: 'What did the pilots say about pricing?', at: Date.now() });
  await decisions.record({ title: 'Launch channel', context: '', options: [], chosen: 'Hacker News.', why: 'Our first users came from there.' });
  await store.saveUpload('notes.md', Buffer.from('Pricing notes: usage based.'));
  await skills.create({ name: 'Chase an unpaid invoice', when: 'When a customer has not paid and the due date has passed', procedure: ['Find the invoice', 'Write one polite email'], pitfalls: [], verify: 'The founder said yes.', by, source });
  const reads = { chat: 0, memory: 0 };
  const readChat = store.readChat;
  store.readChat = async (roomId) => { reads.chat += 1; return readChat(roomId); };
  const memory = async () => { reads.memory += 1; return { notes: 'Prefers tables.', summary: '' }; };
  return { dir, store, decisions, skills, reads, gather: gatherPieces(store, decisions, memory, skills) };
}

describe('gatherPieces', () => {
  it('gathers every kind the workspace holds when no kinds are named', async () => {
    const { gather } = await setup();
    const kinds = new Set((await gather()).map((piece) => piece.kind));
    expect([...kinds].sort()).toEqual(['chat', 'decision', 'doc', 'file', 'memory', 'skill']);
  });

  it('leaves a failed turn out of the conversations it gathers', async () => {
    const { store, gather } = await setup();
    await store.appendChat('marketing', { id: 'm2', role: 'assistant', text: 'No model could answer this time (gemini down). Ask again in a minute.', at: Date.now(), failed: true });
    const chats = (await gather(new Set(['chat']))).filter((piece) => piece.kind === 'chat');
    expect(chats.map((piece) => piece.text).join('\n')).toContain('What did the pilots say about pricing?');
    expect(chats.map((piece) => piece.text).join('\n')).not.toContain('No model could answer');
  });

  it('reads only the kinds it is asked for, and no conversation at all for skills', async () => {
    const { gather, reads } = await setup();
    const pieces = await gather(new Set(['skill']));
    expect(pieces.map((piece) => piece.kind)).toEqual(['skill']);
    expect(reads).toEqual({ chat: 0, memory: 0 });
    expect(new Set((await gather(new Set(['memory']))).map((piece) => piece.kind))).toEqual(new Set(['memory']));
    expect(reads.chat).toBe(0);
  });
});

describe('a search over some kinds only', () => {
  it('keeps the saved vectors of every other kind', async () => {
    const { dir, gather, skills } = await setup();
    const recall = createRecall({ dir, embed: wordEmbedder, gather });
    await recall.warm();
    await recall.settled();
    const saved = async () => Object.keys(JSON.parse(await readFile(join(dir, '.index', 'recall.json'), 'utf8')).vectors).length;
    const everything = await saved();
    // A new skill means something fresh to embed, which is when the index is written again.
    await skills.create({ name: 'Prepare a weekly update', when: 'When the founder asks for the weekly progress note', procedure: ['List what shipped'], pitfalls: [], verify: 'Under ten lines.', by, source });
    const [hit] = await nearestSkills(recall, 'weekly progress note for the team', 1);
    expect(hit.kind).toBe('skill');
    await recall.settled();
    expect(await saved()).toBeGreaterThan(everything);
    // And a whole search afterwards still finds the doc without embedding it again.
    expect((await recall.search('calm plain words brand voice'))[0].id).toBe('brand-doc');
  });
});
