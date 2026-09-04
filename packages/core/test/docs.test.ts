/**
 * `docs/events.md` and `docs/vault-schema.md` are generated from the schemas so they cannot drift from the code.
 * Nothing enforced that until now, so a hand edit to either file survived — and the next `pnpm docs` silently
 * threw it away. This runs the generator into a temp directory and requires the committed pair to match it byte
 * for byte: a schema change fails here until the docs are regenerated, and a hand edit fails here immediately.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(__dirname, '../../..');
const GENERATED = ['events.md', 'vault-schema.md'];

describe('generated docs', () => {
  it('scripts/gen-docs.ts reproduces the committed docs/ files exactly', () => {
    const out = mkdtempSync(path.join(tmpdir(), 'cubicle-docs-'));
    try {
      const r = spawnSync(process.execPath, ['--import', 'tsx/esm', '--conditions=development', path.join(root, 'scripts', 'gen-docs.ts'), out], { cwd: root, encoding: 'utf8' });
      expect(r.status, `${r.stdout ?? ''}${r.stderr ?? ''}`).toBe(0);
      for (const f of GENERATED) {
        const fresh = readFileSync(path.join(out, f), 'utf8');
        const committed = readFileSync(path.join(root, 'docs', f), 'utf8');
        // A mismatch means one of two things: a schema/generator change nobody regenerated, or a hand edit to a
        // generated file. Both are fixed the same way — `node --import tsx/esm --conditions=development
        // scripts/gen-docs.ts`, then commit docs/ — never by editing docs/ to match.
        expect(committed, `docs/${f} is stale; re-run scripts/gen-docs.ts and commit the result`).toBe(fresh);
      }
    } finally { rmSync(out, { recursive: true, force: true }); }
  }, 60_000);

  it('the generated docs carry the facts the schemas cannot state on their own', () => {
    const events = readFileSync(path.join(root, 'docs', 'events.md'), 'utf8');
    const schema = readFileSync(path.join(root, 'docs', 'vault-schema.md'), 'utf8');
    // Each of these was once written by hand into a generated file and lost on the next run.
    expect(events).toMatch(/`owner\.feedback_delivered` \| sha \(sha1 of the trimmed `feedback:` line\)/);
    expect(events).toMatch(/`vault\.wrote` \|.*generated\?/);
    expect(events).toMatch(/`job\.checkpoint` \| `in_review`.*`summary`/);
    expect(schema).toMatch(/`colleague\.answer` \(a question a colleague asked/);
    expect(schema).toMatch(/`rating_seen` \| string \(optional, ISO timestamp\)/);
    // M5: nothing schedules a decision's review_date; the doc must not promise the resurfacing it once claimed.
    expect(schema).toMatch(/`review_date` \| string \(optional\) \| optional date the author records for a second look/);
    expect(schema).not.toMatch(/the decision is resurfaced/);
    // M4: the two payload notes E8/C1 changed and the generator had not caught up with.
    expect(events).toMatch(/`job\.cancelled` \| at_step, reason/);
    expect(events).toMatch(/`guardrail\.blocked` \| tool, reason —.*add step and approved: true/);
    expect(schema).toMatch(/the filename is authoritative: `Jobs\/<id>\.md`/);
    expect(schema).toMatch(/^\| `created` \| string \|/m);   // a zod pipe, not the word "pipe"
  });
});
