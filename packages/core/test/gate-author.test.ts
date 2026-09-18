/**
 * Ruling W4-12: a gate never resolves to the job's own author.
 *
 * The 2026-09-14 dry run logged three `daemon.warning`s reading "gate research.review resolved to the job's own
 * author research_manager; reassigned to researcher". The reassignment worked; that it kept happening is the
 * roster saying "review your own work" three times and something downstream having to say no each time. It is
 * decided where the gate is resolved now, so the research office's own shape — `research` jobs assigned to the
 * room's lead, `research.review` resolving to the same lead — no longer produces a self-review at all.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault } from '../src/template.js';
import { Vault } from '../src/vault.js';
import { loadOrg, type Org } from '../src/org.js';
import { gateAssignee, otherEyesFor } from '../src/gates.js';

let dir: string; let vault: Vault; let org: Org;
beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-gate-author-'));
  vault = (await scaffoldVault(dir)).vault;
  org = loadOrg(vault);
});
afterAll(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

describe('gateAssignee excludes the author (W4-12)', () => {
  it('research.review on a research_manager job lands on another member of the research room, not the author', () => {
    // The shipped roster: `Teams/research.md` is led by research_manager, and the room's first member is the
    // researcher. This is the exact pair the live warnings named.
    expect(gateAssignee('research.review', { assigned: 'research_manager' }, org)).toBe('researcher');
    // …and with no author given, or an author who is not the resolved reviewer, nothing changes.
    expect(gateAssignee('research.review', {}, org)).toBe('research_manager');
    expect(gateAssignee('research.review', { assigned: 'researcher' }, org)).toBe('research_manager');
  });

  it('holds for every gate, whoever the author is: an office holder does not verify their own work', () => {
    for (const [gate, author] of [['office:operations.verify', 'coo'], ['office:security.review', 'ciso'], ['team:qa.review', 'qa_lead']] as const) {
      const who = gateAssignee(gate, { assigned: author }, org);
      expect(who).not.toBe(author);
      expect(org.roles[who]).toBeTruthy();          // …and it is somebody who actually works here
    }
    // requester.review: the decision owner asked for the work and is not the one who did it — unless they are.
    expect(gateAssignee('requester.review', { for: 'cfo', assigned: 'cfo' }, org)).not.toBe('cfo');
    expect(gateAssignee('requester.review', { for: 'cfo', assigned: 'researcher' }, org)).toBe('cfo');
  });

  it('with only a team-lead lookup there is no roster to choose from, so the resolution stands', () => {
    const lookup = (t: string) => (t === 'research' ? 'research_manager' : null);
    expect(gateAssignee('research.review', { assigned: 'research_manager' }, lookup)).toBe('research_manager');
  });

  it('otherEyesFor returns null when the author is genuinely the only person who could look', () => {
    const alone: Org = {
      ...org,
      roles: { research_manager: org.roles.research_manager },
      teams: { research: { ...org.teams.research, members: [], lead: 'research_manager' } },
    };
    expect(otherEyesFor('research.review', 'research_manager', 'research_manager', alone)).toBeNull();
    // …and a gate with nobody left resolves to the author rather than to nobody: a self-review beats no review.
    expect(gateAssignee('research.review', { assigned: 'research_manager' }, alone)).toBe('research_manager');
  });
});
