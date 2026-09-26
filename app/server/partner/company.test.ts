import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Decision } from '../../shared/model.ts';
import type { Bet } from '../../shared/partner.ts';
import { createStore } from '../store.ts';
import { addToSection, betsSection, companyDocOf, decisionLine, ensureCompany, placeOf, RESTORE_FOR, syncDecisions, withSections, writeBets } from './company.ts';

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

  it('keeps the Bets section as the ledger says, open ones first', async () => {
    const store = createStore(await mkdtemp(join(tmpdir(), 'company-')));
    const { id } = await ensureCompany(store);
    const bets: Bet[] = [
      { id: 'b1', made: '2026-09-26', what: 'Post in r/SaaS', hypothesis: 'founders sign up', metric: 'signups', target: 20, checkDate: '2026-10-03', status: 'open', at: 1 },
      { id: 'b2', made: '2026-09-01', what: 'Price at $9', hypothesis: 'people pay', metric: 'leads:customer', target: 5, checkDate: '2026-09-20', status: 'closed', at: 1, result: { at: 2, verdict: 'did-not', value: 2, note: '', by: 'Founder' } },
      { id: 'b3', made: '2026-09-26', what: 'Not yet', hypothesis: '', metric: 'x', target: 1, checkDate: '2026-10-01', status: 'proposed', at: 1 },
    ];
    expect(betsSection(bets)).toBe('- Open: Post in r/SaaS. signups to 20 by 2026-10-03 (made 2026-09-26)\n- Did not work: Price at $9. leads:customer was 2 against 5 (checked 2026-09-20)');
    await writeBets(store, id, bets);
    await writeBets(store, id, bets);
    const text = await store.readDoc(id);
    expect(text).toContain('## Bets\n\n- Open: Post in r/SaaS');
    expect(text.match(/Post in r\/SaaS/g)).toHaveLength(1);
    expect(text).toContain('## Open questions');
  });
});
