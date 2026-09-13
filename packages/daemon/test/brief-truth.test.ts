import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, loadOrg, readJob, founderBriefTemplate, DISCOVERY_INBOX } from '@cubicle/core';
import { discoveryGoal, enqueueDiscovery } from '../src/discovery.js';

/**
 * FR-4 and FR-5 in the discovery job's own words: the rules that keep the brief honest, and a `done_when` that
 * no longer contradicts the three verdicts by asking for one word.
 */
describe('the discovery job tells the author to say only what a file says (ruling FR-4)', () => {
  const goal = () => discoveryGoal({ founderBrief: 'Memory/founder-brief.md', briefTemplate: founderBriefTemplate(), hasBrief: false, research: 'ceo' });

  it('names each of the three claims the first live run invented', () => {
    const g = goal();
    expect(g).toContain('Say only what a file says');
    expect(g).toContain('If `Brand/name.md` has no name, say the company has no name yet');
    expect(g).toContain('do not describe it as answered');
    expect(g).toContain('"unstated" for Founder-Market Fit');
    expect(g).toContain('asking to be surprised');
    expect(g).toContain('proposal.create` checks all of this against the vault');
  });

  it('asks for the verdict first rather than for one word (ruling FR-5)', () => {
    const g = goal();
    expect(g).not.toMatch(/one word/i);
    expect(g).toContain('end on the verdict line: the verdict first — STRONG, WEAK or PIVOT REQUIRED — then the reasons');
    expect(g).toContain('it has potential, but');           // the banned hedge is untouched
    expect(g).toContain('cites the file it came from');     // and so is the rule that was already there
  });

  it('and the brief template asks the same thing of the Brutal Verdict', () => {
    expect(founderBriefTemplate()).not.toMatch(/one word/i);
    expect(founderBriefTemplate()).toContain('**Brutal Verdict:** the verdict first — STRONG, WEAK or PIVOT REQUIRED — then the reasons.');
  });
});

describe('the discovery job\'s done_when (ruling FR-5)', () => {
  let dir: string; let vault: Vault;
  beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-done-when-')); vault = (await scaffoldVault(dir)).vault; });
  afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

  it('asks for a pressure test that ends on the verdict line, not on one word', () => {
    vault.writeText(`${DISCOVERY_INBOX}/pitch.md`, 'We match creators with sponsors.', 'owner');
    const id = enqueueDiscovery(vault, loadOrg(vault))!;
    const done = String(readJob(vault, id)!.data.done_when);
    expect(done).not.toMatch(/one word/i);
    expect(done).toContain('ends on the verdict line (STRONG, WEAK or PIVOT REQUIRED)');
    expect(done).toContain('all eight sections');
  });
});
