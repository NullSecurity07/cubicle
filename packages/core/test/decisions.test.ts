import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault } from '../src/template.js';
import { Vault } from '../src/vault.js';
import { listDecisions, writeDecision } from '../src/decisions.js';
import { stringifyNote } from '../src/frontmatter.js';

let dir: string;
let vault: Vault;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-decisions-'));
  vault = (await scaffoldVault(dir)).vault;
});
afterEach(() => {
  vault.close();
  rmSync(dir, { recursive: true, force: true });
});

const SECTIONS = {
  context: 'Signups flatlined for two weeks.',
  options: '- Rewrite the landing page\n- Cut the price',
  chosen: 'Rewrite the landing page.',
  why: 'The price is already the lowest of the three competitors.',
  expected_effect: 'Signups up 20% within a fortnight.',
  review_date: '2026-09-17',
};

describe('decisions (spec §4.1, §9.6)', () => {
  it('lists a conforming decision note', () => {
    vault.writeText('Decisions/2026-09-03-abc.md', stringifyNote(
      { id: 'dec_abc', decided_by: 'ceo', cycle: 'job_hb', status: 'adopted', inputs: ['[[Meetings/m1]]'], owner_rating: null },
      '## Context\n\nx\n',
    ), 'ceo');

    const list = listDecisions(vault);

    expect(list).toHaveLength(1);
    expect(list[0].path).toBe('Decisions/2026-09-03-abc.md');
    expect(list[0].data.decided_by).toBe('ceo');
    expect(list[0].data.inputs).toEqual(['[[Meetings/m1]]']);
    expect(list[0].body).toContain('## Context');
  });

  it('skips a note missing decided_by and warns exactly once per revision', () => {
    vault.writeText('Decisions/bad.md', stringifyNote({ id: 'dec_bad', cycle: 'job_hb' }, 'no author\n'), 'ceo');

    expect(listDecisions(vault)).toEqual([]);
    listDecisions(vault);

    const warnings = vault.events.query({ types: ['daemon.warning'] }).filter((e) => (e.payload as { path?: string }).path === 'Decisions/bad.md');
    expect(warnings).toHaveLength(1);
    expect(String((warnings[0].payload as { reason?: string }).reason)).toMatch(/decided_by/);
  });

  it('writeDecision produces the six sections in spec order', () => {
    const rel = writeDecision(vault, 'dec_landing', { decided_by: 'ceo', cycle: 'job_hb', status: 'adopted', inputs: ['[[Jobs/job_1]]'] }, SECTIONS, 'ceo');

    expect(rel).toBe('Decisions/dec_landing.md');
    const note = vault.readNote(rel);
    const headings = [...note.body.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(headings).toEqual(['Context', 'Options considered', 'Chosen', 'Why', 'Expected effect', 'Review date']);
    expect(note.body).toContain('Signups flatlined for two weeks.');
    expect(note.data.review_date).toBe('2026-09-17');
    expect(vault.events.last('vault.wrote')!.payload).toMatchObject({ path: rel, by: 'ceo' });

    const back = listDecisions(vault).find((d) => d.data.id === 'dec_landing')!;
    expect(back.data.status).toBe('adopted');
    expect(back.data.inputs).toEqual(['[[Jobs/job_1]]']);
    expect(back.data.owner_rating).toBeNull();
  });
});
