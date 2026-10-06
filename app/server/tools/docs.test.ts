import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createStore } from '../store.ts';
import { docAsked, docTools } from './docs.ts';
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

  // Journey 15: Otto's create_doc was tried again after each guard bounce, and the stage showed "Runway" three times.
  it('makes one doc per title: the same title again this turn writes into it, and one on the stage is never made twice', async () => {
    const { store, call, context } = await setup();
    const first = await call('create_doc', { title: 'Runway', text: '# Runway\n\nFirst try.' });
    const again = await call('create_doc', { title: 'runway', text: '# Runway\n\nSecond try.' });
    expect(again).toMatchObject({ ok: true, effect: { kind: 'doc-changed', id: first.effect!.id } });
    expect(again.text).toContain('no second "Runway"');
    expect(await store.readDoc(first.effect!.id!)).toBe('# Runway\n\nSecond try.');
    expect([...context.granted.values()]).toEqual(['Runway']);
    const onStage = await call('create_doc', { title: 'Brand doc', text: '# Another' });
    expect(onStage.ok).toBe(true);
    expect(onStage.effect).toBeUndefined();
    expect(onStage.text).toContain('A document called "Brand doc" is already on the stage, so no second one was made.');
    expect((await store.loadStage()).docs.filter((doc) => doc.title.toLowerCase() === 'runway')).toHaveLength(1);
  });

  it('names a doc made from the whole ask short, and still finds it by the long title', async () => {
    const { store, call } = await setup();
    const made = await call('create_doc', { title: 'Write me a doc about our pricing in 400 words', text: '# Pricing\n\nTBD' });
    expect(made).toMatchObject({ ok: true, text: 'Created "Pricing".', effect: { kind: 'doc-created', title: 'Pricing' } });
    expect((await call('write_doc', { doc: 'Write me a doc about our pricing in 400 words', text: '# Pricing\n\nTBD\n\nThree tiers.' })).ok).toBe(true);
    expect(await store.readDoc(made.effect!.id!)).toContain('Three tiers.');
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

  it('adds inside a named section, before the next heading, and says where it went', async () => {
    const { store, call } = await setup();
    const out = await call('append_doc', { doc: 'Brand doc', section: 'Review', text: '- Dana: pricing is unclear.' });
    expect(out.ok).toBe(true);
    expect(out.text).toMatch(/^Added 1 line to the end of the "Review" section\./);
    expect(await store.readDoc('brand-doc')).toBe(PLAN.replace('Faye: the numbers are unsourced.\n', 'Faye: the numbers are unsourced.\n- Dana: pricing is unclear.\n'));
  });

  it('finds the section past "##", case and a trailing colon', async () => {
    const { store, call } = await setup();
    await store.replaceDoc('brand-doc', '# Brief\n\n## Numbers:\n\n- 12 beta users\n\n## Open questions\n\n- Pricing?\n');
    const out = await call('append_doc', { doc: 'Brand doc', section: '## numbers', text: '- 2 paying' });
    expect(out.text).toMatch(/to the end of the "Numbers" section/);
    expect(await store.readDoc('brand-doc')).toBe('# Brief\n\n## Numbers:\n\n- 12 beta users\n- 2 paying\n\n## Open questions\n\n- Pricing?\n');
  });

  it('says plainly when the named section is not there, and adds at the end', async () => {
    const { store, call } = await setup();
    const out = await call('append_doc', { doc: 'Brand doc', section: 'Numbers', text: 'Ten users.' });
    expect(out.ok).toBe(true);
    expect(out.text).toMatch(/^There is no "Numbers" section in this document \(its headings: "Launch plan", "Research", "Review", "Build"\), so this was added at the end, after "Build"\. Do not say it went into "Numbers"\./);
    expect(await store.readDoc('brand-doc')).toBe(`${PLAN}\nTen users.\n`);
  });

  it('quotes a marked line back, so the reply can say it with its "(unsourced)" mark', async () => {
    const { store, context } = await setup();
    await store.replaceDoc('brand-doc', '# Company brief\n\n## Numbers\n\n- 12 beta users, 2 paying\n\n## Open questions\n\n- Pricing?\n');
    const read = ['The founder: we have 12 beta users, 2 of them paying.'];
    const turn = { ...context, sources: () => read, evidence: () => ({ read, said: read }) };
    const out = await runTool(docTools, 'append_doc', JSON.stringify({ doc: 'Brand doc', section: 'Numbers', text: '- Projected paying users (December): 10' }), turn);
    expect(out.ok).toBe(true);
    const doc = await store.readDoc('brand-doc');
    expect(doc).toContain('- 12 beta users, 2 paying\n- Projected paying users (December): 10');
    expect(doc.indexOf('Projected')).toBeLessThan(doc.indexOf('## Open questions'));
    expect(out.text).toMatch(/^Added 1 line to the end of the "Numbers" section\./);
    expect(out.text).toContain('It reads: "- Projected paying users (December): 10 (unsourced)".');
    expect(out.text).toMatch(/quote it with its "\(unsourced\)" mark/);
  });

  it('points a person to write_doc when a section to replace is there twice', async () => {
    const { store, call } = await setup();
    await store.replaceDoc('brand-doc', `${PLAN}\n## Build\n\nAgain\n`);
    expect((await call('replace_section', { doc: 'Brand doc', heading: 'Build', text: 'x' })).text).toMatch(/more than one heading is called "Build".*write_doc/);
  });
});

// A count in a plain doc held as on a team doc, but marked rather than refused: "14 customer interviews" nobody read
// stays in the founder's doc as the writer's alone.
describe('a count nothing read gives, in a doc with no rules', () => {
  const READ = ['The founder: we have 12 beta users, 2 of them paying, and 40 playtest sessions logged.'];
  const write = async (text: string, read = READ) => {
    const { store, context } = await setup();
    const turn = { ...context, sources: () => read, evidence: () => ({ read, said: read }) };
    const out = await runTool(docTools, 'append_doc', JSON.stringify({ doc: 'Brand doc', text }), turn);
    return { out, doc: (await store.readDoc('brand-doc')).slice(PLAN.length), again: async () => runTool(docTools, 'write_doc', JSON.stringify({ doc: 'Brand doc', text: await store.readDoc('brand-doc') }), turn), store };
  };

  it('is marked "(unsourced)" after the number once, and the writer is told which', async () => {
    const { out, doc, again, store } = await write('We ran 14 customer interviews with our 40 playtest hosts.');
    expect(out.ok).toBe(true);
    expect(doc).toContain('We ran 14 (unsourced) customer interviews with our 40 (unsourced) playtest hosts.');
    expect(out.text).toMatch(/Marked as unsourced, since nothing read gives them for what they count: "14" .*"40" .*Read for them, or take them out\./);
    expect((await again()).text).not.toMatch(/Marked/);
    expect((await store.readDoc('brand-doc')).match(/\(unsourced\)/g)).toHaveLength(2);
  });

  it('leaves alone counts read, dates, versions, list numbers, headings, plans, quotes of a source and totals shown', async () => {
    const text = [
      '## Week 2 plan',
      '',
      '1. On 3 October we ship v2 and 2.1.4 to all 12 beta users.',
      '2. Call 5 hosts by Friday; we should book 8 more sessions.',
      '3. The founder wrote "we have 12 beta users, 2 of them paying".',
      '4. 14 in all: 12 beta users and 2 paying users.',
      '5. 40 playtest sessions logged at 3pm on the 2nd, step 4 of the plan.',
    ].join('\n');
    const { out, doc } = await write(text);
    expect(doc).toContain(text);
    expect(out.text).toMatch(/^Added \d+ lines at the end of the document, after "Build"\.$/);
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
    expect((await runTool(docTools, 'append_doc', JSON.stringify({ doc: 'Brand doc', text: 'Still €80 for an accountant.' }), sourced)).text).toMatch(/Marked as unsourced.*: €80\. It reads: "Still €80 \(unsourced\) for an accountant\."\. When you tell the founder, quote it with its "\(unsourced\)" mark\.$/);
    expect((await runTool(docTools, 'append_doc', JSON.stringify({ doc: 'Brand doc', text: 'The review found 3 rivals.' }), sourced)).text).toBe('Added 1 line at the end of the document, after "Build".');
    // Outside a turn there is nothing to check against, and nothing is marked.
    expect((await call('append_doc', { doc: 'Brand doc', text: 'Rent is $900.' })).text).toBe('Added 1 line at the end of the document, after "Build".');
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

// Journey 13: a new "Customer notes" doc said the pilot offices loved the boxes, and nothing on record said so.
describe('customer feedback in a new doc', () => {
  it('is marked "(assumption)" when nothing read says it, and the writer is told to say "no feedback on record"', async () => {
    const { store, context } = await setup();
    const read = ['Make a new doc with customer notes: what we actually know about our five pilot offices.', 'Brief: local produce boxes, 5 pilot offices, 3 paying.'];
    const turn = { ...context, sources: () => read, evidence: () => ({ read, said: read }) };
    const text = '# Customer notes\n\n**Office manager feedback:** HR/Office managers report it acts as a popular perk and talking point in the office.\n\n5 pilot offices, 3 paying.';
    const out = await runTool(docTools, 'create_doc', JSON.stringify({ title: 'Customer notes', text }), turn);
    expect(out.ok).toBe(true);
    expect(out.text).toMatch(/^Created "Customer notes"\. Marked as an assumption, since no notes read say it: .*no feedback on record/);
    const id = (out.effect as { id: string }).id;
    expect(await store.readDoc(id)).toContain('talking point in the office (assumption).\n\n5 pilot offices, 3 paying.');
  });
});

// Journey 13: "Net burn €1,380" and "runway 8.7 months" worked out in the head, wrong, and unmarked.
describe('a derived figure in a doc', () => {
  it('is marked "(unsourced)" with no calc behind it, and the writer is told to use calc and show the working', async () => {
    const { store, context } = await setup();
    const read = ['Brief: monthly burn €2,100, MRR €720, cash €12,000.', 'Work out our unit economics in a new doc.'];
    const turn = { ...context, sources: () => read, evidence: () => ({ read, said: read }) };
    const out = await runTool(docTools, 'create_doc', JSON.stringify({ title: 'Unit Economics', text: '# Unit Economics\n\nNet burn at current MRR (€720): €1,380 per month\nRunway at net burn: 8.7 months' }), turn);
    expect(out.text).toMatch(/no calc this turn worked them out .*"€1,380".*"8\.7".*Work each one out with calc/s);
    expect(await store.readDoc((out.effect as { id: string }).id)).toContain('€1,380 (unsourced) per month\nRunway at net burn: 8.7 (unsourced) months');
    const worked = [...read, '2100 - 720 = 1380', '12000 / 1380 = 8.695652174'];
    const calced = { ...context, sources: () => worked, evidence: () => ({ read: worked, said: worked }) };
    const again = await runTool(docTools, 'create_doc', JSON.stringify({ title: 'Unit Economics 2', text: '# Unit Economics\n\nNet burn = 2,100 − 720 = 1,380 (calc)\nRunway at net burn: 8.7 months' }), calced);
    expect(again.text).toBe('Created "Unit Economics 2".');
  });
});

// Journey 14: the partner's brief update wrote "Runway: 4.4 (unsourced) months (4,000 / 900, calc)": a wrong figure,
// and a calc label with no calc behind it. The brief's runway and break-even are calc's on its own Numbers.
describe('a write to the Company brief', () => {
  it('sets Runway and Break-even from calc on the brief\'s Numbers, and says so', async () => {
    const { store, context } = await setup();
    await store.replaceDoc('company-brief', '# Company brief\n\n## Numbers\n\n- Price: €49 per practice per month\n- Paying practices: 2\n- Cash in the bank: €4,000\n- Monthly burn: €900\n');
    const wired = { ...context, stage: { ...context.stage, wires: [...context.stage.wires, { id: 'w-brief', from: 'marketing', fromHandle: 'r', to: 'company-brief', toHandle: 'l' }] }, sources: () => ['We charge €49 a practice a month, 2 paying, €4,000 cash, €900 burn.'] };
    const text = '- Price: €49 per practice per month\n- Paying practices: 2\n- Cash in the bank: €4,000\n- Monthly burn: €900\n- Runway: 4.4 months (4,000 / 900, calc)\n- Break-even: 19 paying practices (900 / 49, calc)';
    const out = await runTool(docTools, 'replace_section', JSON.stringify({ doc: 'Company brief', heading: 'Numbers', text }), wired as never);
    expect(out.ok).toBe(true);
    const doc = await store.readDoc('company-brief');
    expect(doc).toContain('- Runway: 5 months (calc: round(4000 / (900 - 2 * 49), 1) = 5)');
    expect(doc).toContain('- Break-even: 19 paying practices (calc: ceil(900 / 49) = 19)');
    expect(doc).not.toContain('4.4');
    expect(out.text).toContain('Set from calc on the brief\'s own Numbers: "Runway: 5 months (calc: round(4000 / (900 - 2 * 49), 1) = 5)"');
  });

  it('refuses a write that moves the goal\'s day with no reason and the old day gone', async () => {
    const { store, context } = await setup();
    await store.replaceDoc('company-brief', '# Company brief\n\nGoal this quarter: 10 paying practices.\n\n## Bets\n');
    const wired = { ...context, stage: { ...context.stage, wires: [...context.stage.wires, { id: 'w-brief', from: 'marketing', fromHandle: 'r', to: 'company-brief', toHandle: 'l' }] }, sources: () => ['Goal this quarter: 10 paying practices.'] };
    const write = (text: string) => runTool(docTools, 'replace_section', JSON.stringify({ doc: 'Company brief', heading: 'Bets', text }), wired as never);
    const out = await write('- Goal: 10 paying practices by 3 November 2026.');
    expect(out.ok).toBe(false);
    expect(out.text).toContain('the goal "10 paying practices" moves from this quarter to 3 November 2026');
    expect((await write('- Goal: 10 paying practices by 3 November 2026 (was this quarter; moved because the founder asked for an earlier check).')).ok).toBe(true);
  });
});

// Journey 16: "Otto, work out our runway in a doc" went into the Company brief's Numbers.
describe('the doc an ask names', () => {
  const brief = '# Company brief\n\n## Numbers\n\n- Price: €59 per week\n';
  async function wiredTo(query: string) {
    const { store, context } = await setup();
    await store.replaceDoc('company-brief', brief);
    const wired = { ...context, query, stage: { ...context.stage, wires: [...context.stage.wires, { id: 'w-brief', from: 'marketing', fromHandle: 'r', to: 'company-brief', toHandle: 'l' }] }, sources: () => [brief] };
    return { store, call: (name: string, args: Record<string, unknown>) => runTool(docTools, name, JSON.stringify(args), wired as never) };
  }

  it('reads the doc named in the ask, and the brief only when the ask names it', () => {
    expect(docAsked('Otto, work out our runway in a doc')).toEqual({ brief: false });
    expect(docAsked('Otto, write a runway doc')).toEqual({ name: 'Runway', brief: false });
    expect(docAsked('Put the runway in a doc called Runway, not in the Company brief')).toEqual({ name: 'Runway', brief: false });
    expect(docAsked('Add the runway to the Company brief and a runway doc')).toEqual({ name: 'Runway', brief: true });
    expect(docAsked('What is our runway?')).toBeNull();
  });

  it('refuses a write into the Company brief when the ask names another doc, and says to make that doc', async () => {
    const { store, call } = await wiredTo('Otto, work out our runway in a runway doc');
    const out = await call('append_doc', { doc: 'Company brief', section: 'Numbers', text: '- Runway: 3 months' });
    expect(out.ok).toBe(false);
    expect(out.text).toContain('the founder asked for a doc called "Runway", not the Company brief. Make it with create_doc (title "Runway")');
    expect(await store.readDoc('company-brief')).toBe(brief);
    expect((await call('create_doc', { title: 'Runway', text: '# Runway\n\nWorked from the brief.' })).ok).toBe(true);
    expect((await call('replace_section', { doc: 'Company brief', heading: 'Numbers', text: '- Price: €59' })).ok).toBe(false);
  });

  it('writes the brief when the ask names it, or names no doc', async () => {
    expect((await (await wiredTo('Update the Numbers in the Company brief')).call('append_doc', { doc: 'Company brief', section: 'Numbers', text: '- Paying: 11' })).ok).toBe(true);
    expect((await (await wiredTo('We have 11 paying now')).call('append_doc', { doc: 'Company brief', section: 'Numbers', text: '- Paying: 11' })).ok).toBe(true);
  });
});
