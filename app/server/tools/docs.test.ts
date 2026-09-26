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
