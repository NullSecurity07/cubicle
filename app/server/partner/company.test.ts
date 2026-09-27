import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Decision } from '../../shared/model.ts';
import type { Bet } from '../../shared/partner.ts';
import { createStore } from '../store.ts';
import { addToSection, betsSection, learnedLine, learnedSection, companyDocOf, decisionLine, ensureCompany, hasLine, placeOf, RESTORE_FOR, sectionText, syncDecisions, withSections, writeBets } from './company.ts';

const decided = (id: string, title: string, chosen: string, day: string): Decision => ({ id, title, status: 'decided', at: new Date(`${day}T09:00`).getTime(), decidedAt: new Date(`${day}T10:00`).getTime(), context: '', options: [], chosen });

describe('the Company document', () => {
  it('adopts the seeded Company brief: its id, title and text kept, the missing sections added, no second doc', async () => {
    const store = createStore(await mkdtemp(join(tmpdir(), 'company-')));
    const brief = await (async () => { await store.loadStage(); return store.readDoc('company-brief'); })();
    const changed: string[] = [];
    expect(await ensureCompany(store, undefined, (id) => changed.push(id))).toEqual({ id: 'company-brief', created: false });
    const text = await store.readDoc('company-brief');
    expect(text.startsWith(brief.trimEnd())).toBe(true);
    for (const name of ['Idea', 'Customer', 'Numbers', 'Decisions', 'Bets', 'Open questions']) expect(text).toContain(`## ${name}`);
    expect(changed).toEqual(['company-brief']);
    const stage = await store.loadStage();
    expect(stage.docs.filter((doc) => doc.pinned)).toHaveLength(1);
    expect(stage.docs.find((doc) => doc.id === 'company-brief')?.title).toBe('Company brief');
    // A second run changes nothing.
    expect(await ensureCompany(store, undefined, (id) => changed.push(id))).toEqual({ id: 'company-brief', created: false });
    expect(await store.readDoc('company-brief')).toBe(text);
    expect(changed).toHaveLength(1);
  });

  it('makes "Company" only when no pinned company doc exists, and adds only the sections a written doc lacks', async () => {
    const store = createStore(await mkdtemp(join(tmpdir(), 'company-')));
    const stage = await store.loadStage();
    await store.saveStage({ ...stage, docs: stage.docs.filter((doc) => !doc.pinned) });
    const made = await ensureCompany(store);
    expect(made.created).toBe(true);
    expect(companyDocOf(await store.loadStage())).toMatchObject({ id: made.id, title: 'Company', pinned: true });
    expect(await store.readDoc(made.id)).toContain('## Open questions');
    await store.writeDoc(made.id, '# Company\n\n## Idea\n\nMine.\n');
    await ensureCompany(store, made.id);
    expect(await store.readDoc(made.id)).toBe('# Company\n\n## Idea\n\nMine.\n\n## Customer\n\n## Numbers\n\n## Decisions\n\n## Bets\n\n## Open questions\n');
    expect(withSections('')).toContain('# Company');
  });

  it('puts a new document right of everything on the stage, people and cards too', () => {
    const box = { y: 0, w: 100, h: 100 };
    const stage = { rooms: [{ ...box, x: 0 }], docs: [{ ...box, x: 200, pinned: true, y: 40 }], cards: [{ ...box, x: 900, w: 400 }], wires: [] } as never;
    expect(placeOf(stage)).toEqual({ x: 1360, y: 40 });
    expect(placeOf({ rooms: [], docs: [], cards: [], wires: [] })).toEqual({ x: 520, y: 40 });
  });

  it('adds lines at the end of one section, and makes the section when it is gone', () => {
    const text = '# Company\n\n## Decisions\n\n- 2026-09-01 old\n\n## Bets\n';
    expect(addToSection(text, 'Decisions', ['- 2026-09-26 new'])).toBe('# Company\n\n## Decisions\n\n- 2026-09-01 old\n- 2026-09-26 new\n\n## Bets\n');
    expect(addToSection('# Company\n', 'Decisions', ['- x'])).toBe('# Company\n\n## Decisions\n\n- x\n');
  });

  it('writes each decided decision once, one dated line, oldest first, and skips proposals', async () => {
    const store = createStore(await mkdtemp(join(tmpdir(), 'company-')));
    const { id } = await ensureCompany(store);
    const list: Decision[] = [
      decided('d2', 'Newsletter first', 'Weekly curated newsletter, not a marketplace', '2026-09-26'),
      decided('d1', 'Price', 'Nine dollars a month', '2026-09-20'),
      { id: 'd3', title: 'Raise now?', status: 'proposed', at: 1, context: '', options: ['a', 'b'] },
    ];
    expect(decisionLine(list[0])).toBe('- 2026-09-26 Newsletter first: Weekly curated newsletter, not a marketplace');
    const told: string[] = [];
    const T = 1_000_000;
    const first = await syncDecisions(store, id, list, { decided: [] }, (doc) => told.push(doc), T);
    expect(first).toEqual({ decided: ['d1', 'd2'], writtenAt: { d1: T, d2: T } });
    expect(told).toEqual([id]);
    // Lost track of (the app stopped before noting them): the lines already there are not written twice.
    expect((await syncDecisions(store, id, list, { decided: [] }, (doc) => told.push(doc), T)).decided).toEqual(['d1', 'd2']);
    expect(told).toEqual([id]);
    expect(await syncDecisions(store, id, list, first, () => {}, T + RESTORE_FOR)).toEqual({ decided: ['d1', 'd2'], writtenAt: {} });
    const text = await store.readDoc(id);
    expect(text.match(/^- .+$/gm)).toEqual(['- 2026-09-20 Price: Nine dollars a month', '- 2026-09-26 Newsletter first: Weekly curated newsletter, not a marketplace']);
  });

  it('puts back a line lost within two minutes of writing it, and after that leaves the founder\'s edits alone', async () => {
    const store = createStore(await mkdtemp(join(tmpdir(), 'company-')));
    const { id } = await ensureCompany(store);
    const list = [decided('d1', 'Price', 'Nine dollars a month', '2026-09-20'), decided('d2', 'Newsletter first', 'Weekly', '2026-09-26')];
    const T = 1_000_000;
    let held = await syncDecisions(store, id, list, { decided: [] }, () => {}, T);
    const written = await store.readDoc(id);
    // A window saves its old text over the new lines a minute later: they come back.
    await store.writeDoc(id, written.replace(/^- .*$/gm, ''));
    held = await syncDecisions(store, id, list, held, () => {}, T + 60_000);
    expect((await store.readDoc(id)).match(/^- .+$/gm)).toHaveLength(2);
    // Later the founder deletes one line and rewords the other: both stay as they left them.
    const edited = (await store.readDoc(id)).replace(/^- .*Price:.*$/m, '').replace('Newsletter first: Weekly', 'Newsletter first: weekly, and free for a month');
    await store.writeDoc(id, edited);
    held = await syncDecisions(store, id, list, held, () => {}, T + RESTORE_FOR + 1);
    await syncDecisions(store, id, list, held, () => {}, T + 10 * RESTORE_FOR);
    expect(await store.readDoc(id)).toBe(edited);
    // A decision whose line reads differently (another time zone, a changed choice) is not given a second line.
    const moved = list.map((one) => ({ ...one, chosen: `${one.chosen}, changed` }));
    await syncDecisions(store, id, moved, { decided: [] }, () => {}, T + 20 * RESTORE_FOR);
    expect((await store.readDoc(id)).match(/Newsletter first:/g)).toHaveLength(1);
  });

  it('finds a decision\'s line only in the Decisions section, by its whole title at the start of a line', async () => {
    const store = createStore(await mkdtemp(join(tmpdir(), 'company-')));
    const { id } = await ensureCompany(store);
    await store.writeDoc(id, (await store.readDoc(id)).replace('## Idea\n', '## Idea\n\nPrice: $9 a month.\n'));
    const list = [
      decided('d1', 'Launch Price', 'Nine dollars', '2026-09-20'), decided('d2', 'Price', 'Nine dollars a month', '2026-09-21'),
      decided('d3', 'Pricing: monthly or annual', 'Monthly', '2026-09-22'), decided('d4', 'What (x)?', 'Yes', '2026-09-23'),
    ];
    const T = 1_000_000;
    const held = await syncDecisions(store, id, list, { decided: [] }, () => {}, T);
    const text = await store.readDoc(id);
    expect(sectionText(text, 'Decisions').match(/^- .+$/gm)).toEqual([
      '- 2026-09-20 Launch Price: Nine dollars', '- 2026-09-21 Price: Nine dollars a month', '- 2026-09-22 Pricing: monthly or annual: Monthly', '- 2026-09-23 What (x)?: Yes',
    ]);
    expect(hasLine(text, { title: '' })).toBe(false);
    // "Price" lost within two minutes comes back, though "Launch Price" still holds the word.
    await store.writeDoc(id, text.replace('- 2026-09-21 Price: Nine dollars a month\n', ''));
    await syncDecisions(store, id, list, held, () => {}, T + 60_000);
    expect(sectionText(await store.readDoc(id), 'Decisions').match(/^- \S+ Price:/gm)).toEqual(['- 2026-09-21 Price:']);
  });

  it('strikes an open question through once a decision answers it, and leaves the others open', async () => {
    const store = createStore(await mkdtemp(join(tmpdir(), 'company-')));
    const { id } = await ensureCompany(store);
    await store.writeDoc(id, `${await store.readDoc(id)}\n- Newsletter first or marketplace first?\n- What price?\n`);
    const list = [decided('d1', 'Newsletter first or marketplace first?', 'Newsletter first', '2026-09-26')];
    await syncDecisions(store, id, list, { decided: [] }, () => {}, 1);
    const open = sectionText(await store.readDoc(id), 'Open questions');
    expect(open).toContain('- ~~Newsletter first or marketplace first?~~ Decided 2026-09-26: Newsletter first');
    expect(open).toContain('- What price?');
  });

  it('never ends a bet\'s words on two full stops', () => {
    const bet: Bet = { id: 'b', made: '2026-09-26', what: 'Launch the product.', hypothesis: '', metric: 'signups', target: 50, checkDate: '2026-10-11', status: 'open', at: 1 };
    expect(betsSection([bet])).toBe('- Open: Launch the product. Measured by "signups" on the Metrics card: 50 by 2026-10-11 (made 2026-09-26)');
  });

  it('keeps the Bets section as the ledger says, open ones first', async () => {
    const store = createStore(await mkdtemp(join(tmpdir(), 'company-')));
    const { id } = await ensureCompany(store);
    const bets: Bet[] = [
      { id: 'b1', made: '2026-09-26', what: 'Post in r/SaaS', hypothesis: 'founders sign up', metric: 'signups', target: 20, checkDate: '2026-10-03', status: 'open', at: 1 },
      { id: 'b2', made: '2026-09-01', what: 'Price at $9', hypothesis: 'people pay', metric: 'leads:customer', target: 5, checkDate: '2026-09-20', status: 'closed', at: 1, result: { at: 2, verdict: 'did-not', value: 2, note: '', by: 'Founder' } },
      { id: 'b3', made: '2026-09-26', what: 'Not yet', hypothesis: '', metric: 'x', target: 1, checkDate: '2026-10-01', status: 'proposed', at: 1 },
    ];
    expect(betsSection(bets)).toBe('- Open: Post in r/SaaS. Measured by "signups" on the Metrics card: 20 by 2026-10-03 (made 2026-09-26)\n- Did not work: Price at $9. Measured by "leads:customer" on the Leads card: was 2 against 5 (checked 2026-09-20)');
    await writeBets(store, id, bets);
    await writeBets(store, id, bets);
    const text = await store.readDoc(id);
    expect(text).toContain('## Bets\n\n- Open: Post in r/SaaS');
    expect(text.match(/Post in r\/SaaS/g)).toHaveLength(1);
    expect(text).toContain('## Open questions');
  });

  // A closed bet is the company learning something: one line each, under What we learned, as the ledger says.
  it('writes one What we learned line per closed bet, newest first, and no section while none is closed', async () => {
    const store = createStore(await mkdtemp(join(tmpdir(), 'company-')));
    const { id } = await ensureCompany(store);
    const open: Bet = { id: 'b1', made: '2026-09-26', what: 'Post in r/SaaS', hypothesis: 'founders sign up', metric: 'signups', target: 20, checkDate: '2026-10-03', status: 'open', at: 1 };
    await writeBets(store, id, [open]);
    expect(await store.readDoc(id)).not.toContain('What we learned');
    const older: Bet = { id: 'b2', made: '2026-09-01', what: 'Price at $9.', hypothesis: '', metric: 'leads:customer', target: 5, checkDate: '2026-09-20', status: 'closed', at: 1, result: { at: 2, verdict: 'did-not', value: 2, note: 'nobody paid.', by: 'Founder' } };
    const newer: Bet = { ...open, status: 'closed', result: { at: 3, verdict: 'worked', value: 24, note: '', by: 'Sam' } };
    expect(learnedLine(older)).toBe('- 2026-09-20: Price at $9 did not work; "leads:customer" was 2 against 5. nobody paid.');
    expect(learnedLine({ ...older, result: { ...older.result!, value: null, note: '' } })).toBe('- 2026-09-20: Price at $9 did not work; "leads:customer" could not be read against 5.');
    expect(learnedSection([older, newer])).toEqual(['- 2026-10-03: Post in r/SaaS worked; "signups" was 24 against 20.', learnedLine(older)]);
    await writeBets(store, id, [older, newer]);
    await writeBets(store, id, [older, newer]);
    const text = await store.readDoc(id);
    expect(text).toContain('## What we learned\n\n- 2026-10-03: Post in r/SaaS worked; "signups" was 24 against 20.\n- 2026-09-20: Price at $9 did not work');
    expect(text.match(/## What we learned/g)).toHaveLength(1);
    expect(text).toContain('- Worked: Post in r/SaaS.');
  });
});
