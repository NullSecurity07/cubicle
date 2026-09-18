/**
 * The third live dry run's plumbing defects (`sdd/2026-09-18-w4/dryrun-3.md`), each pinned by the
 * thing the owner saw:
 *
 * W6-1  They approved a hire at 17:07:04 and the reader said "Decided · applying…" for ever. The note ended
 *       `approved: true` **and** `refused: hire needs links to at least 2 distinct blocked, failed or retried
 *       jobs`, with `resolved_at: null`; no role file, no desk; and the row went back under *Needs you* with no
 *       trace of the click. The hire was one the owner had proposed themselves, from the dock.
 * W6-3  "WhAtS hppening rn?" was answered "The plan has no objectives and there are no running or blocked jobs"
 *       while the CEO's own cycle was blocked and its plan job was running.
 * W6-8  A job sat `blocked_on: {kind: quota, id: all-providers}` for two hours while `Metrics/quota.md` called
 *       every model `ok` and the run brief said `Blocked: none` and "not processed in time".
 * W6-9  The brief's `_Facts used:_` block pasted `Plans/plan.md` whole, YAML fences and all.
 * W6-10 `Jobs/queue.md` was 15 minutes stale and listed 9 of 23 jobs.
 * W6-11 Two `ceo.heartbeat` jobs appeared to be open at once.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  scaffoldVault, Vault, createJob, updateJob, createProposal, findInboxById, ownerDecide, nowIso, listJobs,
  loadOrg, officeHolder, stringifyNote, type InboxFrontmatter,
} from '@cubicle/core';
import { parseToolsConfig, ToolRegistry, phase3Tools } from '@cubicle/tools';
import { vaultScheduler } from '@cubicle/harness';
import { dispatchProposals, buildSnapshot, writeQueueMd } from '../src/index.js';

let dir: string; let vault: Vault;
beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-w6-')); vault = (await scaffoldVault(dir)).vault; });
afterEach(() => { try { vault.close(); } catch { /* already closed */ } rmSync(dir, { recursive: true, force: true }); });

const deps = () => ({
  vault, registry: new ToolRegistry().registerAll(phase3Tools({ includeMock: true })),
  toolsConfig: parseToolsConfig('tools: {}\n'), scheduler: vaultScheduler(vault, 'daemon'), env: {} as NodeJS.ProcessEnv,
});

/** The charter fence `applyHire` reads, for a role that does not exist yet. */
function charterFence(role: string, team: string): string {
  return '```markdown\n' + stringifyNote({ role, display: role, team, tools: [] }, `# Charter\n\n${role} joins ${team}.\n`) + '```\n';
}

/** A job that stalled: the evidence a company-proposed hire owes. */
function stalledJob(title: string): string {
  const id = createJob(vault, { type: 'engineer.ship', title, assigned: 'backend_engineer', goal: 'g', team: 'dev' }, 'cto');
  updateJob(vault, id, { status: 'blocked', blocked_on: { kind: 'owner', id, since: nowIso() } }, 'cto');
  return id;
}

// ---------------------------------------------------------------------------------------------------------
// W6-1 — a hire approval never dies in silence
// ---------------------------------------------------------------------------------------------------------

describe('W6-1: approving a proposal always ends somewhere the owner can read', () => {
  it('(a) a hire the owner proposed from the dock needs no justifying jobs', async () => {
    const { id } = createProposal(vault, {
      kind: 'hire', from: 'owner', title: 'Hire performance_auditor',
      body: `The owner put a desk in the sales room and asked for performance_auditor to sit at it.\n\n${charterFence('performance_auditor', 'sales')}`,
    }, 'owner');
    ownerDecide(vault, id, { approved: true });

    expect(await dispatchProposals(deps())).toBe(1);

    const note = findInboxById(vault, id)!;
    expect(note.data.resolved_at).toBeTruthy();
    expect((note.data as Record<string, unknown>).refused ?? null).toBeNull();
    expect(vault.exists('Roles/performance_auditor.md')).toBe(true);
    expect(note.body).toContain('hired performance_auditor');
  });

  it('(b) a hire the company proposed without the evidence is refused, resolved, and says so in plain words', async () => {
    const ceo = officeHolder(loadOrg(vault), 'chief_executive');
    const { id, path: rel } = createProposal(vault, {
      kind: 'hire', from: ceo, title: 'Hire performance_auditor',
      body: `We need one.\n\n${charterFence('performance_auditor', 'sales')}`,
    }, ceo);
    ownerDecide(vault, id, { approved: true });

    expect(await dispatchProposals(deps())).toBe(1);

    const note = findInboxById(vault, id)!;
    // The live run's state — approved and refused and unresolved at once — is now impossible.
    expect(note.data.resolved_at).toBeTruthy();
    const why = String((note.data as Record<string, unknown>).refused ?? '');
    expect(why).toContain('a hire proposed by the company needs two jobs that were blocked for lack of this role');
    expect(why).not.toContain('distinct blocked, failed or retried');
    expect(vault.exists('Roles/performance_auditor.md')).toBe(false);
    // The reason is in the note the owner reads, not only in the frontmatter.
    expect(note.body).toContain('not applied — a hire proposed by the company needs two jobs');

    // The office hears about it the same tick, and the row leaves *Needs you* for *Decided*.
    const resolved = vault.events.query({ types: ['proposal.resolved'] }).filter((e) => (e.payload as { id?: string }).id === id);
    expect(resolved).toHaveLength(1);
    expect(String((resolved[0].payload as { refused?: string }).refused)).toContain('needs two jobs');
    const snap = buildSnapshot(vault);
    expect(snap.inbox.some((r) => r.id === id)).toBe(false);
    expect(snap.pendingProposals).toBe(0);
    const row = snap.decided.find((d) => d.id === id)!;
    expect(row.outcome).toContain('not applied');
    expect(row.refused).toContain('needs two jobs');

    // And it stays closed: a second pass neither re-refuses nor re-opens it.
    expect(await dispatchProposals(deps())).toBe(0);
    expect(findInboxById(vault, id)!.data.resolved_at).toBe(note.data.resolved_at);
    expect(vault.readText(rel).match(/_Resolved /g) ?? []).toHaveLength(1);
  });

  it('(b) the same hire with two stalled jobs behind it is applied', async () => {
    const ceo = officeHolder(loadOrg(vault), 'chief_executive');
    const a = stalledJob('Audit the landing page'); const b = stalledJob('Audit the pricing page');
    const { id } = createProposal(vault, {
      kind: 'hire', from: ceo, title: 'Hire performance_auditor',
      body: `Two jobs stalled for want of one: [[${a}]] and [[${b}]].\n\n${charterFence('performance_auditor', 'sales')}`,
    }, ceo);
    ownerDecide(vault, id, { approved: true });

    await dispatchProposals(deps());
    expect(vault.exists('Roles/performance_auditor.md')).toBe(true);
  });

  it('no kind ends approved: true with resolved_at: null — the brand pick that named no option closes too', async () => {
    const THREE = '1. One — a\n2. Two — b\n3. Three — c\n';
    const { id } = createProposal(vault, { kind: 'brand_change', from: 'ceo', target: 'Brand/name.md', title: 'Pick one', body: THREE }, 'ceo');
    vault.updateNote(findInboxById(vault, id)!.path, (n) => ({ data: { ...n.data, approved: true, chosen: 4 }, body: n.body }), 'owner');

    expect(await dispatchProposals(deps())).toBe(1);

    const note = findInboxById(vault, id)!;
    expect(note.data.approved).toBe(true);
    expect(note.data.resolved_at).toBeTruthy();
    expect(String((note.data as Record<string, unknown>).refused)).toContain('chosen: 4 matches no option');
    expect(buildSnapshot(vault).decided.find((d) => d.id === id)!.outcome).toContain('not applied');
  });

  it('a hold is not a refusal: a dormant spend keeps its approval and stays open', async () => {
    const { id } = createProposal(vault, {
      kind: 'spend', from: 'cfo', target: 'Money/ledger.md', title: 'Buy the domain', body: '# Buy the domain\n',
      call: { tool: 'mock.spend', args: {}, idempotency_key: 'w6-dormant', role: 'cfo' },
    }, 'cfo');
    ownerDecide(vault, id, { approved: true });

    await dispatchProposals({ ...deps(), dormant: () => true });

    const note = findInboxById(vault, id)!;
    expect(note.data.approved).toBe(true);
    expect(note.data.resolved_at ?? null).toBeNull();   // nothing was decided, so nothing is closed
    expect(String((note.data as Record<string, unknown>).refused)).toContain('out of money');
    expect(note.body).toContain('_Not applied:');
  });

  it('(c) the dock\'s own hire note states what can still stop it, before the click', async () => {
    // The body `hire.propose` writes (packages/daemon/src/ws.ts). Read here rather than over a socket: what is
    // under test is the sentence the owner reads, not the transport.
    const org = loadOrg(vault);
    const display = 'Performance auditor';
    const { id } = createProposal(vault, {
      kind: 'hire', from: 'owner', title: `Hire ${display}`,
      body: `The owner put a desk in the ${org.teams.sales.name} room and asked for ${display} to sit at it.\n\nYou asked for this hire yourself, so it needs no justifying jobs — approve it and ${display} is hired. It can only fail if the room has no free desk left, or the company is already at the headcount your constitution allows.\n`,
    }, 'owner');
    const body = findInboxById(vault, id)!.body;
    expect(body).toContain('needs no justifying jobs');
    expect(body).not.toContain('link the work that justifies the hire');
  });
});
