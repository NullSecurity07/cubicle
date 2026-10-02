import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createStore } from '../store.ts';
import { docTools } from './docs.ts';
import { runTool } from './registry.ts';

const PLAN = '# Launch plan\n\n## Research\n\nNils found three rivals, with sources.\n\n## Review\n\nFaye: the numbers are unsourced.\n\n## Build\n\nTBD\n';

async function setup() {
  const store = createStore(await mkdtemp(join(tmpdir(), 'docs-tools-')));
  const stage = await store.loadStage();
  await store.replaceDoc('brand-doc', PLAN);
  const context = { stage, roomId: 'marketing', store, granted: new Map<string, string>() };
  const call = (name: string, args: Record<string, unknown>) => runTool(docTools, name, JSON.stringify(args), context);
  return { store, context, call };
}

describe('doc tools', () => {
  it('refuses a whole rewrite that would lose a colleague\'s sections, and names them', async () => {
    const { store, call } = await setup();
    const out = await call('write_doc', { doc: 'Brand doc', text: '## Build\n\nShip the stage in October, after the review.' });
    expect(out.ok).toBe(false);
    expect(out.text).toMatch(/not written: .*"Launch plan", "Research", "Review".*replace_section.*append_doc/);
    expect(await store.readDoc('brand-doc')).toBe(PLAN);
  });

  it('still rewrites the whole document when asked to replace it', async () => {
    const { store, call } = await setup();
    const out = await call('write_doc', { doc: 'Brand doc', text: '# Fresh start', replace: true });
    expect(out).toMatchObject({ ok: true, effect: { kind: 'doc-changed', id: 'brand-doc' } });
    expect(await store.readDoc('brand-doc')).toBe('# Fresh start');
  });

  it('lets a rewrite through that keeps what is there', async () => {
    const { store, call } = await setup();
    expect((await call('write_doc', { doc: 'Brand doc', text: PLAN.replace('TBD', 'Ship in October.') })).ok).toBe(true);
    expect(await store.readDoc('brand-doc')).toContain('Ship in October.');
  });

  it('lets a person rewrite a document they made in this turn', async () => {
    const { store, call } = await setup();
    const made = await call('create_doc', { title: 'Scratch', text: '# Draft\n\nA long first try at the plan, to be thrown away.' });
    expect((await call('write_doc', { doc: 'Scratch', text: 'Short.' })).ok).toBe(true);
    expect(await store.readDoc(made.effect!.id!)).toBe('Short.');
  });

  it('replaces one section and leaves the others as they were', async () => {
    const { store, call } = await setup();
    const out = await call('replace_section', { doc: 'Brand doc', heading: 'Build', text: 'Ship the stage in October.' });
    expect(out).toMatchObject({ ok: true, text: 'Replaced the section "Build".', effect: { kind: 'doc-changed', id: 'brand-doc' } });
    expect(await store.readDoc('brand-doc')).toBe(PLAN.replace('TBD', 'Ship the stage in October.'));
  });

  it('refuses a section that is not there, and a document that is not wired', async () => {
    const { store, call, context } = await setup();
    expect((await call('replace_section', { doc: 'Brand doc', heading: 'Pricing', text: 'x' })).text).toMatch(/Failed: no heading "Pricing"/);
    context.roomId = 'build';
    expect((await call('replace_section', { doc: 'Brand doc', heading: 'Build', text: 'x' })).text).toMatch(/no connected document/);
    expect(await store.readDoc('brand-doc')).toBe(PLAN);
  });

  it('reads a pinned doc nobody wired, as the prompt says every person does, and still refuses an unpinned one', async () => {
    const { store, call, context } = await setup();
    await store.replaceDoc('company-brief', '# Company brief\n\nFlipside: a weekly list of small SaaS for sale.');
    context.roomId = 'build';
    expect(context.stage.docs.find((doc) => doc.id === 'company-brief')?.pinned).toBe(true);
    const pinned = await call('read_doc', { doc: 'Company brief' });
    expect(pinned).toMatchObject({ ok: true });
    expect(pinned.text).toContain('Flipside');
    const unpinned = await call('read_doc', { doc: 'Brand doc' });
    expect(unpinned.ok).toBe(false);
    expect(unpinned.text).toMatch(/no connected document/);
    const write = await call('append_doc', { doc: 'Company brief', text: 'More.' });
    expect(write.ok).toBe(false);
    expect(write.text).toMatch(/pinned company document: you can read it, but writing to it needs a wire/);
  });

  it('lets a plain doc repeat a heading, as a running log does', async () => {
    const { store, call } = await setup();
    expect((await call('append_doc', { doc: 'Brand doc', text: '## Monday\n\na' })).ok).toBe(true);
    expect((await call('append_doc', { doc: 'Brand doc', text: '## Monday\n\nb' })).ok).toBe(true);
    expect((await call('append_doc', { doc: 'Brand doc', text: '## Review\n\nMore notes.' })).ok).toBe(true);
    expect((await store.readDoc('brand-doc')).match(/^## Monday$/gm)).toHaveLength(2);
  });

  it('points a person to write_doc when a section to replace is there twice', async () => {
    const { store, call } = await setup();
    await store.replaceDoc('brand-doc', `${PLAN}\n## Build\n\nAgain\n`);
    expect((await call('replace_section', { doc: 'Brand doc', heading: 'Build', text: 'x' })).text).toMatch(/more than one heading is called "Build".*write_doc/);
  });
});

// A figure the truth net would flag under the reply went into the doc unflagged: Meera's "€80–€200/month" for an
// accountant was flagged in chat and written plain into the Evaluation doc.
describe('a figure nothing this turn read', () => {
  it('is marked "(unsourced)" in a plain doc, and a figure the turn read or proposed is not', async () => {
    const { store, call, context } = await setup();
    const sourced = { ...context, sources: () => ['The founder: we charge $29 a month and have 3 paying users.'] };
    const out = await runTool(docTools, 'replace_section', JSON.stringify({ doc: 'Brand doc', heading: 'Build', text: 'At $29 a month, against an accountant at €80–€200/month. I suggest a target of $49 next.' }), sourced);
    expect(out.ok).toBe(true);
    expect(out.text).toBe('Replaced the section "Build". Marked as unsourced, since nothing this turn read gives them: €80, €200.');
    expect(await store.readDoc('brand-doc')).toContain('At $29 a month, against an accountant at €80 (unsourced)–€200 (unsourced)/month. I suggest a target of $49 next.');
    // Written again as it now stands, nothing is marked twice.
    const again = await runTool(docTools, 'write_doc', JSON.stringify({ doc: 'Brand doc', text: await store.readDoc('brand-doc') }), sourced);
    expect(again.text).toBe(`Wrote ${(await store.readDoc('brand-doc')).length} characters.`);
    expect((await store.readDoc('brand-doc')).match(/\(unsourced\)/g)).toHaveLength(2);
    // A figure the doc itself marked is no source for saying it again; one the doc states plainly is.
    expect((await runTool(docTools, 'append_doc', JSON.stringify({ doc: 'Brand doc', text: 'Still €80 for an accountant.' }), sourced)).text).toMatch(/Marked as unsourced.*: €80\.$/);
    expect((await runTool(docTools, 'append_doc', JSON.stringify({ doc: 'Brand doc', text: 'The review found 3 rivals.' }), sourced)).text).toBe('Added 26 characters.');
    // Outside a turn there is nothing to check against, and nothing is marked.
    expect((await call('append_doc', { doc: 'Brand doc', text: 'Rent is $900.' })).text).toBe('Added 13 characters.');
  });

  it('is refused in a team doc with rules, with the figures named', async () => {
    const { readFile } = await import('node:fs/promises');
    const { resolve } = await import('node:path');
    const { place } = await import('../frameworks/place.ts');
    const framework = JSON.parse(await readFile(resolve(import.meta.dirname, '../../frameworks/startup-evaluation/framework.json'), 'utf8'));
    const store = createStore(await mkdtemp(join(tmpdir(), 'docs-figures-')));
    const seed = await store.loadStage();
    const { placed, texts } = place(framework, seed, { x: 2000, y: 0 });
    const stage = { ...seed, rooms: [...seed.rooms, ...placed.rooms], docs: [...seed.docs, ...placed.docs], wires: [...seed.wires, ...placed.wires], cards: [...(seed.cards ?? []), ...placed.cards] };
    for (const [id, text] of Object.entries(texts)) await store.replaceDoc(id, text as string);
    const context = { stage, roomId: 'pain', store, granted: new Map<string, string>(), sources: () => ['Ledgerly: $29 a month, 3 paying users.', 'The founder: I have had 3 customer conversations.'] };
    const text = 'Vitamin — painkiller — hair on fire: painkiller\n\nWhat it costs them per month: an accountant at €80–€200/month.\n\nReal customer conversations done (of ten to twenty): 3';
    const out = await runTool(docTools, 'replace_section', JSON.stringify({ doc: 'Evaluation', heading: '3. Is the pain real?', text }), context);
    expect(out.ok).toBe(false);
    expect(out.text).toMatch(/not written: €80, €200 (?:are|is) not in anything this turn read\. Search or read for them first, take them out, or write "\(unsourced\)" right after each\./);
    const marked = text.replace('€80', '€80 (unsourced)').replace('€200', '€200 (unsourced)');
    expect((await runTool(docTools, 'replace_section', JSON.stringify({ doc: 'Evaluation', heading: '3. Is the pain real?', text: marked }), context)).ok).toBe(true);
    // Marking every line, a figure the turn read and a line with no figure at all, leaves the mark only where it is true.
    const everywhere = 'Vitamin — painkiller — hair on fire: painkiller (unsourced)\n\nWhat it costs them per month: an accountant at €80 (unsourced)–€200 (unsourced)/month, against $29 (unsourced) a month. (unsourced)\n\nReal customer conversations done (of ten to twenty): 3 (unsourced)';
    const out2 = await runTool(docTools, 'replace_section', JSON.stringify({ doc: 'Evaluation', heading: '3. Is the pain real?', text: everywhere }), context);
    expect(out2.ok).toBe(true);
    expect(out2.text).toContain('Took out "(unsourced)" where this turn\'s reading gives the figure or no figure stands before it.');
    const saved = await store.readDoc(stage.docs.find((doc) => doc.title === 'Evaluation')!.id);
    expect(saved).toContain('an accountant at €80 (unsourced)–€200 (unsourced)/month, against $29 a month.');
    expect(saved).toContain('hair on fire: painkiller\n');
    expect(saved).toMatch(/twenty\): 3(?! \(unsourced\))/);
    expect(saved.match(/\(unsourced\)/g)).toHaveLength(2);
  });
});

// Journey 10: Meera wrote counts and claims nobody gave into the Evaluation doc, and the judge's verdict rested on them.
describe('what a team doc says about the world', () => {
  async function team() {
    const { readFile } = await import('node:fs/promises');
    const { resolve } = await import('node:path');
    const { place } = await import('../frameworks/place.ts');
    const framework = JSON.parse(await readFile(resolve(import.meta.dirname, '../../frameworks/startup-evaluation/framework.json'), 'utf8'));
    const store = createStore(await mkdtemp(join(tmpdir(), 'docs-evidence-')));
    const seed = await store.loadStage();
    const { placed, texts } = place(framework, seed, { x: 2000, y: 0 });
    const stage = { ...seed, rooms: [...seed.rooms, ...placed.rooms], docs: [...seed.docs, ...placed.docs], wires: [...seed.wires, ...placed.wires], cards: [...(seed.cards ?? []), ...placed.cards] };
    for (const [id, text] of Object.entries(texts)) await store.replaceDoc(id, text as string);
    // The founder's Day-1 message went to another room; the Company brief the partner kept is what Meera read.
    await store.appendChat(seed.rooms[0].id, { id: 'm1', role: 'user', text: 'Kindling: a playtest tool for board game designers. 12 beta users (2 paying), MRR €78, 40 playtest sessions logged.', at: 1 });
    const read = ['# Company brief\n\n## Numbers\n\n- Beta users: 12 (2 paying)\n- MRR: €78'];
    const context = { stage, roomId: 'pain', store, granted: new Map<string, string>(), sources: () => read, evidence: () => ({ read, said: ['Write section 3 from the brief.'] }) };
    const write = (text: string) => runTool(docTools, 'replace_section', JSON.stringify({ doc: 'Evaluation', heading: '3. Is the pain real?', text }), context);
    return { store, stage, write };
  }
  const SECTION = (lines: string) => `Vitamin — painkiller — hair on fire: painkiller\n\n${lines}`;

  it('refuses journey 10\'s invented counts and claims, and names each', async () => {
    const { write } = await team();
    const conversations = await write(SECTION('Real customer conversations done (of ten to twenty): 2 (beta users currently paying)'));
    expect(conversations.ok).toBe(false);
    expect(conversations.text).toMatch(/not written: "2" \(in "Real customer conversations done/);
    const hours = await write(SECTION('What it costs them per month: 3+ hours per test'));
    expect(hours.text).toMatch(/not written: "3\+" \(in "What it costs them per month: 3\+ hours per test"\)/);
    const retention = await write('Vitamin — painkiller — hair on fire: Painkiller (some pay, retention OK — workable)');
    expect(retention.text).toMatch(/"retention OK" in "3\. Is the pain real\?": no founder message or tool result says this/);
  });

  it('writes a count the founder gave in another room, and marks a view the writer left plain', async () => {
    const { store, stage, write } = await team();
    const out = await write(SECTION('40 playtest sessions logged so far. Likely a painkiller for designers who test often.'));
    expect(out.ok).toBe(true);
    const doc = stage.docs.find((one) => one.title === 'Evaluation')!;
    expect(await store.readDoc(doc.id)).toContain('40 playtest sessions logged so far. Likely a painkiller for designers who test often (assumption).');
    expect(out.text).toContain('Marked as a view: "Likely a painkiller for designers who test often."');
  });
});
