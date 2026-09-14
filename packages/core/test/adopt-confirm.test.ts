import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault } from '../src/template.js';
import type { Vault } from '../src/vault.js';
import { createProposal, findInboxById } from '../src/proposals.js';
import { ownerDecide, OwnerDecideError, noteVerdict, needsConfirm } from '../src/decide.js';
import { FOUNDER_BRIEF } from '../src/discovery.js';

let dir: string; let vault: Vault;
beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-confirm-')); vault = (await scaffoldVault(dir)).vault; });
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

/**
 * A founder brief note shaped exactly like the one the third live run adopted: the covering note says what the
 * board ruled, and the `## Pressure test` is the last section *inside* the fence, ending on its verdict line.
 */
function briefNote(verdict: string): string {
  return [
    '# The founder brief',
    '',
    `The board pressure-tested this before you saw it and ruled **${verdict}**.`,
    '',
    '## Proposed content',
    '',
    '````',
    '## What the company is',
    '',
    'AltStack — a directory of open-source alternatives.',
    '',
    '## Pressure test',
    '',
    '**Core Assumption:** unstated',
    '**Three Fatal Flaws:** the buyers optimise for zero spend.',
    '**Problem Validation:** unstated',
    '**Founder-Market Fit:** unstated',
    `**Brutal Verdict:** ${verdict} — the static directory model does not capture value.`,
    '````',
    '',
    'Set `approved: true` to adopt it.',
  ].join('\n');
}

function fileBrief(verdict: string): string {
  return createProposal(vault, { kind: 'founder_brief', from: 'research_manager', target: FOUNDER_BRIEF, title: 'The founder brief', body: briefNote(verdict) }, 'research_manager').id;
}

describe('the verdict is read off the note, not off a second field', () => {
  it('reads PIVOT REQUIRED out of the pressure test inside the fence', () => {
    expect(noteVerdict(briefNote('PIVOT REQUIRED'))).toBe('PIVOT REQUIRED');
    expect(noteVerdict(briefNote('WEAK'))).toBe('WEAK');
    expect(noteVerdict(briefNote('STRONG'))).toBe('STRONG');
  });

  it('is empty for a note that carries no pressure test at all', () => {
    expect(noteVerdict('# A file change\n\n## Proposed content\n\n```\nhello\n```\n')).toBe('');
  });

  it('asks for confirmation only on the brief, and only on the two verdicts that are not a yes', () => {
    expect(needsConfirm('founder_brief', briefNote('PIVOT REQUIRED'))).toBe(true);
    expect(needsConfirm('founder_brief', briefNote('WEAK'))).toBe(true);
    expect(needsConfirm('founder_brief', briefNote('STRONG'))).toBe(false);
    // A file_change that happened to quote a pressure test is still a file change.
    expect(needsConfirm('file_change', briefNote('PIVOT REQUIRED'))).toBe(false);
  });
});

describe('adopting a brief the board would not stand behind (ruling W3-3)', () => {
  it('is refused without confirm, and the refusal names the verdict', () => {
    const id = fileBrief('PIVOT REQUIRED');
    expect(() => ownerDecide(vault, id, { approved: true })).toThrow(OwnerDecideError);
    try { ownerDecide(vault, id, { approved: true }); } catch (err) {
      expect((err as Error).message).toContain('PIVOT REQUIRED');
      expect((err as Error).message).toContain('confirm: true');
    }
    // Nothing was written: the note is exactly as the company left it.
    expect(findInboxById(vault, id)!.data.approved).toBeNull();
  });

  it('is applied with confirm, as the owner', () => {
    const id = fileBrief('PIVOT REQUIRED');
    const d = ownerDecide(vault, id, { approved: true, confirm: true, comment: 'I know. Do it anyway.' });
    expect(d.approved).toBe(true);
    const note = findInboxById(vault, id)!;
    expect(note.data.approved).toBe(true);
    expect(note.data.approved_by).toBe('owner');
    expect(note.body).toContain('I know. Do it anyway.');
  });

  it('needs nothing extra to send it back: agreeing with the board is not overruling it', () => {
    const id = fileBrief('WEAK');
    const d = ownerDecide(vault, id, { approved: false, comment: 'Find a business people pay for.' });
    expect(d.approved).toBe(false);
  });

  it('adopts a STRONG brief on one click, as it always did', () => {
    const id = fileBrief('STRONG');
    expect(ownerDecide(vault, id, { approved: true }).approved).toBe(true);
  });
});
