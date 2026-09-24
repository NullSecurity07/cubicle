import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLibrary, HEAD, inUse, MOST_BYTES, MOST_NOTE_CHARS, notesBlock, piecesOf } from './notes.ts';

const setup = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'library-'));
  return { dir, library: createLibrary(dir) };
};
// Every test that leans on a framework holding a note puts the library back to knowing of nobody.
afterEach(() => { inUse.by = () => null; });

describe('the library index', () => {
  it('writes a file and an index entry, newest first', async () => {
    const { dir, library } = await setup();
    const note = await library.add({ title: 'Startup evaluation notes', text: '# Steps\n\nRead the market first.\n', tags: ['yc', 'evaluation'], source: 'file' });
    expect(note.id).toBe('startup-evaluation-notes');
    expect(note.source).toBe('file');
    expect(note.bytes).toBe(32);
    expect(await readFile(join(dir, 'library', 'startup-evaluation-notes.md'), 'utf8')).toContain('Read the market first.');
    await library.add({ title: 'Pricing', text: 'Charge for the value.', source: 'paste' });
    expect((await library.list()).map((one) => one.id)).toEqual(['pricing', 'startup-evaluation-notes']);
    expect(JSON.parse(await readFile(join(dir, 'library', 'index.json'), 'utf8')).notes).toHaveLength(2);
    expect(await library.read('pricing')).toBe('Charge for the value.');
  });

  // Two notes added in the same moment: each reads the index and writes it back, and without a queue the second write
  // was made from a list that never had the first note in it.
  it('keeps both of two notes added at once, and a delete made beside them', async () => {
    const { library } = await setup();
    await library.add({ title: 'Old', text: 'going' });
    await Promise.all([
      library.add({ title: 'Pricing', text: 'Charge for the value.' }),
      library.add({ title: 'Hiring', text: 'Hire slowly.' }),
      library.remove('old'),
      library.add({ title: 'Selling', text: 'Ask for the money.' }),
    ]);
    expect((await library.list()).map((one) => one.id).sort()).toEqual(['hiring', 'pricing', 'selling']);
  });

  it('replaces a note added again under the same title, and says so in the hash', async () => {
    const { library } = await setup();
    const first = await library.add({ title: 'Pricing', text: 'Charge for the value.' });
    const again = await library.add({ title: ' pricing ', text: 'Charge for the value. Raise it once a year.' });
    expect(again.id).toBe(first.id);
    expect(again.hash).not.toBe(first.hash);
    expect(await library.list()).toHaveLength(1);
    expect(await library.read('pricing')).toContain('Raise it once a year.');
  });

  it('deletes a note, and keeps one a framework was built from', async () => {
    const { library } = await setup();
    await library.add({ title: 'Pricing', text: 'Charge for the value.' });
    inUse.by = (id) => (id === 'pricing' ? 'Startup evaluation' : null);
    await expect(library.remove('pricing')).rejects.toThrow('Startup evaluation');
    expect(await library.list()).toHaveLength(1);
    inUse.by = () => null;
    await library.remove('pricing');
    expect(await library.list()).toEqual([]);
    expect(await library.read('pricing')).toBeNull();
  });

  it('refuses a note over the size a note can be, and one with nothing in it', async () => {
    const { library } = await setup();
    await expect(library.add({ title: 'Everything', text: 'x'.repeat(MOST_BYTES + 1) })).rejects.toThrow('200 KB');
    await expect(library.add({ title: 'Empty', text: '  ' })).rejects.toThrow('nothing in it');
    await expect(library.add({ title: '   ', text: 'words' })).rejects.toThrow('needs a title');
    expect(await library.list()).toEqual([]);
  });

  it('reads the files that are there and lets a hand-deleted one go quietly', async () => {
    const { dir, library } = await setup();
    await library.add({ title: 'Pricing', text: '# Pricing\n\nCharge for the value.' });
    await library.add({ title: 'Hiring', text: '# Hiring\n\nHire slowly.' });
    await writeFile(join(dir, 'library', 'hiring.md'), '');
    expect((await library.pieces()).map((piece) => piece.title)).toEqual(['Pricing › Pricing']);
  });
});

describe('a note passage by passage', () => {
  const note = { id: 'evaluation', title: 'Startup evaluation notes', tags: [], source: 'file' as const, addedAt: 1, bytes: 0, hash: '' };
  // Long enough that the passages fall either side of the second heading, which is the whole point of the titles.
  const text = ['# Evaluation', `Read the whole market before you judge one idea. ${'m'.repeat(400)}`, '## The rubric',
    `Score the team, the market and the wedge out of five. ${'r'.repeat(400)}`, 'A total under nine is a kill.'].join('\n\n');

  it('titles every passage with the heading it sits under', () => {
    const pieces = piecesOf(note, text);
    expect(pieces.map((piece) => piece.title)).toEqual(['Startup evaluation notes \u203a Evaluation', 'Startup evaluation notes \u203a The rubric']);
    expect(pieces.map((piece) => piece.id)).toEqual(['evaluation#0', 'evaluation#1']);
    expect(pieces[1].text).toContain('A total under nine is a kill.');
    expect(pieces.every((piece) => piece.kind === 'library')).toBe(true);
  });

  it('falls back to the note itself when nothing above the passage is a heading', () => {
    expect(piecesOf(note, 'Just words, no headings at all.')[0].title).toBe('Startup evaluation notes');
  });
});

describe('the block a person is given', () => {
  it('quotes whole passages under one line per note', () => {
    const block = notesBlock([{ title: 'Pricing', chunks: ['Charge for the value.', 'Raise it once a year.'] }, { title: 'Hiring', chunks: ['Hire slowly.'] }]);
    expect(block).toBe(`${HEAD('Pricing')}\nCharge for the value.\n\nRaise it once a year.\n\n${HEAD('Hiring')}\nHire slowly.`);
  });

  it('leaves out a passage that does not fit whole, and never goes over the cap', () => {
    const long = 'w'.repeat(1400);
    const block = notesBlock([{ title: 'Pricing', chunks: [long, long, long] }]);
    expect(block.length).toBeLessThanOrEqual(MOST_NOTE_CHARS);
    expect(block.split(long).length - 1).toBe(2);
    expect(notesBlock([{ title: 'Pricing', chunks: ['x'.repeat(MOST_NOTE_CHARS)] }])).toBe('');
  });
});
