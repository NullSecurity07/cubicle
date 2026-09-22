import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { seedStage, type Stage } from '../../shared/model.ts';
import { installSlices, type Deps } from '../install.ts';
import { createLibrary, HEAD, MOST_NOTE_CHARS } from '../library/notes.ts';
import type { ModelMessage } from '../prompt.ts';
import { createSeams } from '../seams.ts';
import { createUsage } from '../usage.ts';
import slice from './library.ts';

// Five steps, each its own passage: long enough that they do not fold into one, alike enough that several of them
// answer the same question, which is what the top three and the floor are about.
const step = (at: number) => `Step ${at}: score the wedge and the market before you judge the idea. ${'The founder writes this down every time they look at one. '.repeat(9)}`;
const NOTE = [1, 2, 3, 4, 5].map(step).join('\n\n');
const OTHER = ['# Hiring', `Hire slowly and fire kindly, and never hire for a job nobody has done yet. ${'Write the job down before the person exists. '.repeat(10)}`].join('\n\n');

// The stage the tests ask about: Maya, a note card wired to her, and a second note card wired to nobody.
function stageWith(cards: { id: string; noteId: string }[], wireTo: string[]): Stage {
  return {
    ...seedStage,
    cards: cards.map((card) => ({ kind: 'library' as const, id: card.id, noteId: card.noteId, x: 0, y: 0, w: 280, h: 190 })),
    wires: [...seedStage.wires, ...wireTo.map((id) => ({ id: `marketing-${id}`, from: 'marketing', fromHandle: 'r', to: id, toHandle: 'l' }))],
  };
}

async function setup(stage: Stage) {
  const workspace = await mkdtemp(join(tmpdir(), 'library-slice-'));
  const library = createLibrary(workspace);
  await library.add({ title: 'Startup evaluation notes', text: NOTE, source: 'file' });
  await library.add({ title: 'Hiring notes', text: OTHER, source: 'paste' });
  const seams = createSeams();
  const deps = { workspace, root: workspace, fake: true, seams, clients: [], usage: createUsage(null), store: { loadStage: async () => stage } } as unknown as Deps;
  const extras = await installSlices([slice], deps);
  const ask = async (query: string) => (await seams.run('turn:before', {
    roomId: 'marketing', source: 'chat', query, messages: [{ role: 'system', content: 'You are Maya, Marketing.' } as ModelMessage],
  })).messages;
  return { extras, ask, library };
}
const blockOf = (messages: ModelMessage[]) => messages[0].content.replace('You are Maya, Marketing.', '').trim();

describe('the library slice', () => {
  it('gives a person the three best passages of a note wired to them', async () => {
    const { ask } = await setup(stageWith([{ id: 'note-1', noteId: 'startup-evaluation-notes' }], ['note-1']));
    const block = blockOf(await ask('How do I score the wedge and the market of an idea?'));
    expect(block.startsWith(HEAD('Startup evaluation notes'))).toBe(true);
    // Three passages, each quoted whole, and no sign of the note that is wired to nobody.
    expect(block.match(/^Step \d:/gm)).toHaveLength(3);
    expect(block).not.toContain('Hire slowly');
    expect(block.length).toBeLessThanOrEqual(MOST_NOTE_CHARS);
  });

  it('says nothing when no note is wired to that person', async () => {
    const { ask } = await setup(stageWith([{ id: 'note-1', noteId: 'startup-evaluation-notes' }], []));
    expect(blockOf(await ask('How do I score the wedge and the market of an idea?'))).toBe('');
  });

  it('says nothing when the wired note has nothing to do with the question', async () => {
    const { ask } = await setup(stageWith([{ id: 'note-1', noteId: 'startup-evaluation-notes' }], ['note-1']));
    expect(blockOf(await ask('Chase the overdue invoice from that customer in Lisbon'))).toBe('');
  });

  it('keeps every wired note inside the one cap for the turn', async () => {
    const { ask } = await setup(stageWith([{ id: 'note-1', noteId: 'startup-evaluation-notes' }, { id: 'note-2', noteId: 'hiring-notes' }], ['note-1', 'note-2']));
    const block = blockOf(await ask('Score the wedge, the market and the idea, and hire slowly for the job'));
    expect(block).toContain(HEAD('Startup evaluation notes'));
    expect(block).toContain(HEAD('Hiring notes'));
    expect(block.length).toBeLessThanOrEqual(MOST_NOTE_CHARS);
  });

  it('leaves a card whose note is gone from the library alone', async () => {
    const { ask, library } = await setup(stageWith([{ id: 'note-1', noteId: 'startup-evaluation-notes' }], ['note-1']));
    await library.remove('startup-evaluation-notes');
    expect(blockOf(await ask('How do I score the wedge and the market of an idea?'))).toBe('');
  });
});
