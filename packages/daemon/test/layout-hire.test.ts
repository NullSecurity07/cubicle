/**
 * A hire takes a desk on the floor, and a fire takes its lines off it (SP9b).
 *
 * Approving a hire has to leave someone who can work: a new desk with no line to anybody could not message its
 * own lead and could not use a tool whose station stands on the campus. So the applied hire is wired the way the
 * org already implies, and put where the owner dropped it when the proposal says where that was.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  scaffoldVault, Vault, createJob, createProposal, findInboxById, updateJob, loadOrg, loadCampusMap, readLayout,
  connected, stationId, applyLayout,
} from '@cubicle/core';
import { applyHire, applyFire } from '../src/evolution.js';

const root = path.resolve(__dirname, '../../..');
let dir: string, vault: Vault;
beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-layout-hire-')); vault = (await scaffoldVault(dir)).vault; });
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

const layout = () => readLayout(vault, loadCampusMap(), loadOrg(vault))!.layout;

/** A hire proposal the dispatcher will accept: a hireable charter and two jobs that justify it. */
function hireProposal(at?: { x: number; y: number }) {
  const charter = readFileSync(path.join(root, 'vault-template/Roles/_hireable/support.md'), 'utf8');
  const j1 = createJob(vault, { type: 'custom', title: 'a', assigned: 'cso', goal: 'g' }, 'ceo');
  const j2 = createJob(vault, { type: 'custom', title: 'b', assigned: 'cso', goal: 'g' }, 'ceo');
  updateJob(vault, j1, { status: 'failed' }, 'daemon');
  updateJob(vault, j2, { status: 'failed' }, 'daemon');
  const p = createProposal(vault, { kind: 'hire', from: 'ceo', title: 'Hire Support', body: `[[${j1}]] [[${j2}]]\n\`\`\`markdown\n${charter}\`\`\``, at }, 'ceo');
  return findInboxById(vault, p.id)!;
}

describe('a hire on the floor', () => {
  it('is wired to its lead, its room and the stations its charter needs', async () => {
    expect(await applyHire(vault, hireProposal())).toMatch(/^hired support/);
    const org = loadOrg(vault);
    const desk = org.roles.support.desk;
    const l = layout();
    expect(connected(l, desk, org.roles.cso.desk)).toBe(true);        // the lead of the room it joined
    expect(org.roles.support.tools.some((t) => t.startsWith('email.'))).toBe(true);
    expect(connected(l, desk, stationId('email'))).toBe(true);        // and the station its charter needs
    expect(connected(l, desk, stationId('deploy'))).toBe(false);      // and nothing it does not
  });

  it('stands where the owner dropped it', async () => {
    const at = { x: 9, y: 6 };
    expect(await applyHire(vault, hireProposal(at))).toMatch(/^hired support/);
    const desk = loadOrg(vault).roles.support.desk;
    const l = layout();
    expect(l.nodes[desk]).toEqual(at);
    expect(applyLayout(loadCampusMap(), l).desks[desk].rect.x0).toBe(9);
  });

  it('a hire with no position named leaves the desk where the campus put it', async () => {
    await applyHire(vault, hireProposal());
    expect(layout().nodes[loadOrg(vault).roles.support.desk]).toBeUndefined();
  });

  it('a fire takes the desk\'s lines off the floor', async () => {
    const org = loadOrg(vault);
    const desk = org.roles.qa_lead.desk;
    expect(layout().connections.some((c) => c.from === desk || c.to === desk)).toBe(true);
    const { path: p } = createProposal(vault, { kind: 'fire', from: 'ceo', title: 'Fire the QA lead', body: 'role: qa_lead', target: 'Roles/qa_lead.md' }, 'ceo');
    const n = vault.readNoteOrNull(p)!;
    expect(await applyFire(vault, { path: p, data: n.data as never, body: n.body })).toMatch(/^fired/);
    expect(layout().connections.some((c) => c.from === desk || c.to === desk)).toBe(false);
  });
});
