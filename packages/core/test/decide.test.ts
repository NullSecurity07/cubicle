import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault } from '../src/template.js';
import type { Vault } from '../src/vault.js';
import { createProposal, findInboxById, listInbox } from '../src/proposals.js';
import {
  numberedOptions, proposalOptions, decidableFor, pressureBlock, resolvedOutcome,
  decidedByOwner, ownerDecide, OwnerDecideError, proposedContentBlock, OWNER,
} from '../src/decide.js';

let dir: string; let vault: Vault;
beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-decide-')); vault = (await scaffoldVault(dir)).vault; });
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

const THREE = [
  '1. Northwind — kits of ready-prepped food for nursery kitchens.',
  '2. Tuckbox — a weekly box a nursery cook can serve straight from.',
  '3. Provender — nursery catering priced per child per week.',
  '',
  'Set `chosen: 1|2|3` and `approved: true`; the chosen line\'s name becomes the company name.',
].join('\n');

describe('the numbered options are the dispatcher\'s own, and only its own', () => {
  it('reads the number as written, not as counted', () => {
    // Three ideas that arrived as 1, 3, 4 must not be renumbered here: `chosen:` is matched against the number
    // on the line, so a reader that counted would apply a different name than the one the owner clicked.
    const o = numberedOptions('1. one\n3. three\n4. four');
    expect(o.map((x) => x.n)).toEqual([1, 3, 4]);
    expect(o.map((x) => x.label)).toEqual(['one', 'three', 'four']);
  });

  it('takes the same lines the dispatcher used to filter for', () => {
    const body = '1. a\n  2. b\n3.no space\nnot 4. a line\n5. e';
    expect(numberedOptions(body).map((x) => x.n)).toEqual([1, 2, 5]);
  });

  it('strips the markdown a model wraps a name in — the same characters the dispatcher strips', () => {
    expect(numberedOptions('1. **Northwind** — kits').map((x) => x.label)).toEqual(['Northwind — kits']);
    expect(numberedOptions('1. `Northwind`').map((x) => x.label)).toEqual(['Northwind']);
    expect(numberedOptions('1. **Northwind** — kits')[0].line).toBe('1. **Northwind** — kits');
  });
});

describe('what the owner is asked for', () => {
  it('brand_change with three lines is a choice', () => {
    const o = proposalOptions('brand_change', THREE);
    expect(o.map((x) => x.n)).toEqual([1, 2, 3]);
    expect(decidableFor('brand_change', o)).toBe('choose');
  });

  it('brand_change with a proposed-content block is an approval: the dispatcher never reads a number there', () => {
    const body = '## Proposed content\n\n```\nname: Northwind\n```\n\n1. this is prose, not an option\n';
    expect(proposedContentBlock(body)).toBe('name: Northwind\n');
    expect(proposalOptions('brand_change', body)).toEqual([]);
    expect(decidableFor('brand_change', [])).toBe('approve');
  });

  it('idea_verdict is keep/park/scrap — the table the dispatcher rules by, not prose', () => {
    const o = proposalOptions('idea_verdict', 'Recommendation: **keep**.\n\nSet `approved: true`…');
    expect(o).toEqual([
      { n: 1, label: 'keep', line: '1. keep' },
      { n: 2, label: 'park', line: '2. park' },
      { n: 3, label: 'scrap', line: '3. scrap' },
    ]);
    expect(decidableFor('idea_verdict', o)).toBe('choose');
  });

  it('a founder brief is adopt or send back, whatever its body contains', () => {
    expect(proposalOptions('founder_brief', '1. a\n2. b')).toEqual([]);
    expect(decidableFor('founder_brief', [])).toBe('adopt');
  });

  it('every other kind is approve or reject, numbered lines or not', () => {
    for (const kind of ['plan_verdict', 'file_change', 'hire', 'spend', 'threat_model']) {
      expect(proposalOptions(kind, '1. a\n2. b')).toEqual([]);
      expect(decidableFor(kind, [])).toBe('approve');
    }
  });
});

describe('the pressure test block travels with the decision', () => {
  it('stops at the next heading', () => {
    expect(pressureBlock('# T\n\n## Pressure test\n\n**Verdict:** WEAK.\n\n## What next\n\nplan')).toBe('**Verdict:** WEAK.');
  });

  it('stops at the closing fence, because on a brief it is the last section inside one', () => {
    const body = '# Brief\n\n## Proposed content\n\n```md\n## Who it is for\n\nnurseries\n\n## Pressure test\n\n**Brutal Verdict:** PIVOT REQUIRED.\n```\n\nSet `approved: true` to adopt it.\n';
    expect(pressureBlock(body)).toBe('**Brutal Verdict:** PIVOT REQUIRED.');
  });

  it('is empty when the note never took the test', () => {
    expect(pressureBlock('# T\n\nno such section')).toBe('');
    expect(pressureBlock('## Pressure testing the idea\n\nnot the section')).toBe('');
  });
});

describe('the outcome is the dispatcher\'s own footer', () => {
  it('reads the sentence back past an ISO stamp full of colons', () => {
    expect(resolvedOutcome('body\n\n---\n_Resolved 2026-09-13T10:11:12.000Z: applied to Brand/name.md_\n'))
      .toBe('applied to Brand/name.md');
  });

  it('keeps underscores inside the outcome', () => {
    expect(resolvedOutcome('b\n\n---\n_Resolved 2026-09-13T10:11:12.000Z: idea meal_kits: keep_\n')).toBe('idea meal_kits: keep');
  });

  it('takes the last footer, so a refusal followed by a resolution reads as resolved', () => {
    const body = 'b\n\n---\n_Not applied: no target. Fix it and approve again._\n\n---\n_Resolved 2026-09-13T10:11:12.000Z: rejected_\n';
    expect(resolvedOutcome(body)).toBe('rejected');
  });

  it('is empty for a note nobody has closed', () => {
    expect(resolvedOutcome('# still open\n\nbody')).toBe('');
  });
});

describe('ownerDecide writes the note the way an editor would', () => {
  const file = (rel: string) => vault.readText(rel);

  it('writes approved, chosen and the owner\'s name, and marks the write as the owner\'s', () => {
    const { id, path: rel } = createProposal(vault, { kind: 'brand_change', from: 'ceo', target: 'Brand/name.md', title: 'Three company ideas — pick one', body: THREE }, 'ceo');
    expect(decidedByOwner(vault, rel)).toBe(false);

    const r = ownerDecide(vault, id, { approved: true, chosen: 2 });

    expect(r).toMatchObject({ id, path: rel, kind: 'brand_change', approved: true, chosen: 2, comment: '' });
    const note = findInboxById(vault, id)!;
    expect(note.data.approved).toBe(true);
    expect(note.data.chosen).toBe(2);
    expect((note.data as { approved_by?: string }).approved_by).toBe(OWNER);
    expect(decidedByOwner(vault, rel)).toBe(true);
    expect(vault.writtenBy(rel)).toBe(OWNER);
    // The body is untouched: the owner clicked a chip, they did not rewrite the note.
    expect(file(rel)).toContain('3. Provender');
  });

  it('appends the comment as a trailing owner paragraph and nothing else', () => {
    const { id, path: rel } = createProposal(vault, { kind: 'founder_brief', from: 'ceo', target: 'Memory/founder_brief.md', title: 'The brief', body: '## Proposed content\n\n```md\n# Brief\n```\n\nSet `approved: true` to adopt it.' }, 'ceo');
    ownerDecide(vault, id, { approved: false, comment: 'Too vague. Give me a customer with a name.' });
    const text = file(rel);
    expect(text.trimEnd().endsWith('Too vague. Give me a customer with a name.')).toBe(true);
    // Ruling P8-1 rejected a second `comment:` field — there is exactly one place the comment is written.
    expect(text).not.toMatch(/^comment:/m);
    expect(findInboxById(vault, id)!.data.approved).toBe(false);
  });

  it('refuses a note that does not exist, one already resolved, and a message', () => {
    expect(() => ownerDecide(vault, 'prop_nope', { approved: true })).toThrow(OwnerDecideError);
    const { id: msg } = createProposal(vault, { kind: 'message', from: 'owner', to: 'ceo', title: 'hi', body: 'hi' }, 'owner');
    expect(() => ownerDecide(vault, msg, { approved: true })).toThrow(/is a message/);
    const { id, path: rel } = createProposal(vault, { kind: 'plan_verdict', from: 'ceo', title: 'The plan', body: 'plan' }, 'ceo');
    vault.updateNote(rel, (n) => ({ data: { ...n.data, resolved_at: '2026-09-13T00:00:00.000Z' }, body: n.body }), 'daemon');
    expect(() => ownerDecide(vault, id, { approved: true })).toThrow(/already decided/);
  });

  it('refuses a founder brief the board is still sitting on (ruling R-T3-3)', () => {
    const { id, path: rel } = createProposal(vault, { kind: 'founder_brief', from: 'ceo', target: 'Memory/founder_brief.md', title: 'The brief', body: '## Proposed content\n\n```md\n# Brief\n```\n' }, 'ceo');
    vault.updateNote(rel, (n) => ({ data: { ...n.data, board_pending: true }, body: n.body }), 'daemon');

    // The pressure test is half of what the owner would be deciding on, so there is nothing to adopt yet.
    expect(() => ownerDecide(vault, id, { approved: true })).toThrow(OwnerDecideError);
    expect(() => ownerDecide(vault, id, { approved: true })).toThrow('the board is still pressure-testing this brief; it will be ready to adopt in a moment, with the board\'s findings in it');
    // Sending it back is a decision on the brief too, and it is blocked for the same reason.
    expect(() => ownerDecide(vault, id, { approved: false, comment: 'too vague' })).toThrow(/still sitting/);
    expect(findInboxById(vault, id)!.data.approved).toBeNull();

    // Once the board is off it, the same click lands.
    vault.updateNote(rel, (n) => ({ data: { ...n.data, board_pending: false }, body: n.body }), 'daemon');
    expect(ownerDecide(vault, id, { approved: true }).approved).toBe(true);
  });

  it('the flag blocks a founder brief and nothing else', () => {
    const { id, path: rel } = createProposal(vault, { kind: 'plan_verdict', from: 'ceo', title: 'The plan', body: 'b' }, 'ceo');
    vault.updateNote(rel, (n) => ({ data: { ...n.data, board_pending: true }, body: n.body }), 'daemon');
    expect(ownerDecide(vault, id, { approved: true }).approved).toBe(true);
  });

  it('refuses a chosen that names no option, and one on a note with nothing to choose', () => {
    const { id } = createProposal(vault, { kind: 'brand_change', from: 'ceo', target: 'Brand/name.md', title: 'Pick one', body: THREE }, 'ceo');
    expect(() => ownerDecide(vault, id, { approved: true, chosen: 4 })).toThrow(/matches no option/);
    expect(() => ownerDecide(vault, id, { approved: true, chosen: 1.5 })).toThrow(/whole number/);
    expect(findInboxById(vault, id)!.data.approved).toBeNull();  // nothing was written

    const { id: plan } = createProposal(vault, { kind: 'plan_verdict', from: 'ceo', title: 'The plan', body: 'plan' }, 'ceo');
    expect(() => ownerDecide(vault, plan, { approved: true, chosen: 1 })).toThrow(/nothing to choose between/);
  });

  it('leaves the defaults `listInbox` invents out of a note the owner typed by hand', () => {
    // An owner's own note carries no `to:` and no `id:`; the listing fills them in for the daemon's benefit.
    // Writing those back would put the daemon's idea of the note into a file the owner owns.
    vault.writeText('00 Inbox/mine.md', '---\nkind: file_change\nfrom: owner\ntarget: Docs/x.md\napproved: null\n---\n# Mine\n\n## Proposed content\n\n```\nx\n```\n', 'owner');
    const note = listInbox(vault).find((n) => n.path === '00 Inbox/mine.md')!;
    expect(note.data.to).toBe('ceo');       // invented by the listing, never written back
    ownerDecide(vault, note.data.id, { approved: true });
    const text = file('00 Inbox/mine.md');
    expect(text).not.toMatch(/^to:/m);
    expect(text).not.toMatch(/^created:/m);
    expect(text).toMatch(/^approved: true$/m);
  });
});
