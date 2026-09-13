import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, templateDir } from '../src/template.js';
import { migrateOrg } from '../src/org.js';
import { PRESSURE_HANDBOOK_PATH } from '../src/pressure.js';

/**
 * FR-5. The wording of the pressure-test handbook changed after a live vault had already been scaffolded from
 * it, and `copyMissing` — which is all `copyDir('Docs')` does — copies a doc once and never looks at it again.
 * A live vault would therefore go on telling its board to answer "in one word" for ever.
 */
describe('migrateOrg re-copies the pressure-test handbook when the template changed', () => {
  it('replaces a stale handbook, leaves a current one alone, and stays idempotent', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cubicle-handbook-migrate-'));
    const { vault } = await scaffoldVault(dir);
    try {
      const current = vault.readText(PRESSURE_HANDBOOK_PATH);

      // A vault already on the template's text is not rewritten, and nothing else about migration moves.
      expect(migrateOrg(vault, templateDir()).changed).not.toContain(PRESSURE_HANDBOOK_PATH);

      // The vault as the owner's live one is: the handbook as it was before the rewrite.
      vault.writeText(PRESSURE_HANDBOOK_PATH, current.replace(/Give \*\*the verdict first.*/s, 'Answer in **one word first**, then justify.\n'), 'daemon');
      expect(vault.readText(PRESSURE_HANDBOOK_PATH)).toMatch(/one word/i);

      const r = migrateOrg(vault, templateDir());
      expect(r.changed).toContain(PRESSURE_HANDBOOK_PATH);
      expect(vault.readText(PRESSURE_HANDBOOK_PATH)).toBe(current);
      expect(vault.readText(PRESSURE_HANDBOOK_PATH)).not.toMatch(/one word/i);

      // Twice in a row writes nothing: the comparison is on content, not on a flag.
      expect(migrateOrg(vault, templateDir()).changed).toEqual([]);
    } finally { vault.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('archives an owner-edited handbook before replacing it, so their words are not lost', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cubicle-handbook-owner-'));
    const { vault } = await scaffoldVault(dir);
    try {
      const current = vault.readText(PRESSURE_HANDBOOK_PATH);
      // An owner edit is made in Obsidian, not through the write API — which is exactly how `isOwnerChanged` knows.
      writeFileSync(path.join(dir, PRESSURE_HANDBOOK_PATH), `${current}\n\n## The owner's own rule\n\nNever fund a marketplace.\n`);
      const r = migrateOrg(vault, templateDir());
      expect(r.changed).toContain(PRESSURE_HANDBOOK_PATH);
      const archived = r.changed.find((c) => c.startsWith('Docs/archive/pressure-test-handbook-'));
      expect(archived).toBeTruthy();
      expect(vault.readText(archived!)).toContain('Never fund a marketplace.');
      expect(vault.readText(PRESSURE_HANDBOOK_PATH)).toBe(current);
    } finally { vault.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
