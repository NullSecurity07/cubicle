import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Decision } from '../../shared/model.ts';
import type { Bet } from '../../shared/partner.ts';
import { createStore } from '../store.ts';
import { addToSection, betsSection, companyDocOf, decisionLine, ensureCompany, syncDecisions, writeBets } from './company.ts';

const decided = (id: string, title: string, chosen: string, day: string): Decision => ({ id, title, status: 'decided', at: new Date(`${day}T09:00`).getTime(), decidedAt: new Date(`${day}T10:00`).getTime(), context: '', options: [], chosen });

describe('the Company document', () => {
  it('is put on the stage once, pinned, with the six sections, and found again after', async () => {
    const store = createStore(await mkdtemp(join(tmpdir(), 'company-')));
    const first = await ensureCompany(store);
    expect(first.created).toBe(true);
    const stage = await store.loadStage();
    const doc = companyDocOf(stage)!;
    expect(doc).toMatchObject({ id: first.id, title: 'Company', pinned: true });
    expect(await store.readDoc(doc.id)).toContain('## Open questions');
    const again = await ensureCompany(store);
    expect(again).toEqual({ id: first.id, created: false });
    expect((await store.loadStage()).docs.filter((one) => one.title === 'Company')).toHaveLength(1);
  });

  it('fills a Company doc the window made empty, and leaves a written one alone', async () => {
    const store = createStore(await mkdtemp(join(tmpdir(), 'company-')));
    const stage = await store.loadStage();
    await store.saveStage({ ...stage, docs: [...stage.docs, { id: 'doc-abc', title: 'Company', pinned: true, x: 0, y: 0, w: 1, h: 1 }] });
    expect(await ensureCompany(store)).toEqual({ id: 'doc-abc', created: false });
    expect(await store.readDoc('doc-abc')).toContain('## Decisions');
    await store.writeDoc('doc-abc', '# Company\n\nMine.');
    await ensureCompany(store);
    expect(await store.readDoc('doc-abc')).toBe('# Company\n\nMine.');
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
    const known = await syncDecisions(store, id, list, []);
    expect(known).toEqual(['d1', 'd2']);
    expect(await syncDecisions(store, id, list, known)).toEqual(known);
    const text = await store.readDoc(id);
    expect(text.match(/^- .+$/gm)).toEqual(['- 2026-09-20 Price: Nine dollars a month', '- 2026-09-26 Newsletter first: Weekly curated newsletter, not a marketplace']);
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
