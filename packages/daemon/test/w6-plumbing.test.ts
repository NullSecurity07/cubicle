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
import { renderQuotaMarkdown, quotaRowStatus } from '@cubicle/router';
import { dispatchProposals, buildSnapshot, writeQueueMd, statusFacts, agoInWords, blockedInWords, planObjectiveLines } from '../src/index.js';

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

// ---------------------------------------------------------------------------------------------------------
// W6-3 / W6-8 / W6-9 — the status answer and the run brief are true about the present
// ---------------------------------------------------------------------------------------------------------

describe('W6-3: the status answer is true about the present', () => {
  const writePlan = (body: string) => vault.writeText('Plans/plan.md', `---\nupdated: "${nowIso().slice(0, 10)}"\ncycle: 1\n---\n${body}`, 'ceo');

  /** The live plan, objective for objective, including the `idea:` marker that runs into the sentence. */
  const LIVE_PLAN = [
    '# Plan', '', '## Objectives', '',
    '### technology',
    '- Ship the initial page speed audit engine prototype with a sequential queue idea: [[Ideas/pagespeedaudit]]', '',
    '### operations',
    '- Verify zero-error onboarding flow and infrastructure stability idea: [[Ideas/pagespeedaudit]]', '',
    '### revenue',
    '- Secure 50 pre-committed signups from agency and indie hacker sites idea: [[Ideas/pagespeedaudit]]', '',
  ].join('\n');

  it("reads the objectives off Plans/plan.md as it stands, with core's own parser", () => {
    writePlan(LIVE_PLAN);
    const facts = statusFacts(vault, new Date()).join('\n');
    expect(facts).not.toContain('Plan objectives: the plan has none');
    expect(facts).toContain('technology — Ship the initial page speed audit engine prototype');
    expect(facts).toContain('operations —');
    expect(facts).toContain('revenue —');
  });

  it("never says nothing is running while the company's own cycle is running and blocked", () => {
    // The live moment: a `ceo.heartbeat` marked blocked 3.7 seconds earlier and a `company.plan` running. Both
    // are NON_WORK_TYPES, so the answer the owner got to "what's happening right now" was "there are no running
    // or blocked jobs" — the one checkably false thing in the run.
    const hb = createJob(vault, { type: 'ceo.heartbeat', title: 'Heartbeat (startup after 2.3 h away)', assigned: 'ceo', goal: 'g' }, 'daemon');
    const plan = createJob(vault, { type: 'company.plan', title: 'Write the company plan', assigned: 'ceo', goal: 'g' }, 'daemon');
    updateJob(vault, hb, { status: 'blocked', blocked_on: { kind: 'job', id: plan, since: nowIso() } }, 'daemon');
    updateJob(vault, plan, { status: 'running' }, 'daemon');

    const facts = statusFacts(vault, new Date()).join('\n');
    expect(facts).toContain('Write the company plan');
    expect(facts).toContain('Heartbeat (startup after 2.3 h away)');
    // The company's own work is still reported separately — the owner asked what is happening, not how much
    // was shipped — but "none" may never be the whole of either line while something is open.
    expect(facts).not.toMatch(/Jobs running now: none\.$/m);
    expect(facts).not.toMatch(/Jobs blocked: none\.$/m);
  });

  it("says a quota block in the owner's words, not the machine's", () => {
    const j = createJob(vault, { type: 'discovery', title: 'Read what the owner gave us', assigned: 'research_manager', goal: 'g' }, 'daemon');
    updateJob(vault, j, { status: 'blocked', blocked_on: { kind: 'quota', id: 'all-providers', since: nowIso() } }, 'daemon');

    const facts = statusFacts(vault, new Date()).join('\n');
    expect(facts).toContain('Read what the owner gave us — waiting for model quota');
    expect(facts).not.toContain('stopped on quota');
  });

  it('mentions the last decision the owner took, and how long ago', () => {
    const { id } = createProposal(vault, { kind: 'plan_verdict', from: 'ceo', title: 'The plan for this cycle', body: 'b' }, 'ceo');
    ownerDecide(vault, id, { approved: true });
    const rel = findInboxById(vault, id)!.path;
    vault.updateNote(rel, (n) => ({ data: { ...n.data, resolved_at: new Date(Date.now() - 4 * 60_000).toISOString() }, body: n.body }), 'daemon');

    const facts = statusFacts(vault, new Date()).join('\n');
    expect(facts).toContain('The last thing you decided: The plan for this cycle — you approved it 4 minutes ago.');
  });

  it("and never reports the constitution's own auto-approval as the owner's decision", () => {
    const { id } = createProposal(vault, { kind: 'plan_verdict', from: 'ceo', title: 'Auto', body: 'b' }, 'ceo');
    vault.updateNote(findInboxById(vault, id)!.path, (n) => ({ data: { ...n.data, approved: true, approved_by: 'constitution', resolved_at: nowIso() }, body: n.body }), 'daemon');
    expect(statusFacts(vault, new Date()).join('\n')).not.toContain('The last thing you decided');
  });

  it('agoInWords is a sentence, not a log line', () => {
    expect(agoInWords(3_000)).toBe('just now');
    expect(agoInWords(60_000)).toBe('1 minute ago');
    expect(agoInWords(4 * 60_000)).toBe('4 minutes ago');
    expect(agoInWords(3 * 3600_000)).toBe('3 hours ago');
    expect(agoInWords(5 * 24 * 3600_000)).toBe('5 days ago');
  });
});

describe('W6-8 / W6-9: quota and the run brief tell the same truth', () => {
  it('a model at any of its limits is not "ok"', () => {
    const limits = { rpm: 15, rpd: 500, tpm: 250_000, tpd: 0 };
    const base = { provider: 'gemini', model: 'gemini-3.5-flash-lite', rpm_used: 0, rpd_used: 0, tpm_used: 0, tpd_used: 0, cooling_until: null, limits };
    // The live row: 15/15 calls a minute, 161/500 a day — refused by `hasHeadroom` on every call, printed "ok".
    expect(quotaRowStatus({ ...base, rpm_used: 15, rpd_used: 161, tpm_used: 52_691 })).toBe('at its minute limit');
    expect(quotaRowStatus({ ...base, rpd_used: 500 })).toBe('out for today');
    expect(quotaRowStatus({ ...base, rpd_used: 20, limits: { ...limits, rpd: 20 } })).toBe('out for today');
    expect(quotaRowStatus({ ...base, tpm_used: 250_000 })).toBe('at its token-a-minute limit');
    expect(quotaRowStatus({ ...base, rpd_used: 460 })).toBe('nearly out');
    expect(quotaRowStatus({ ...base, rpd_used: 10 })).toBe('ok');
    expect(quotaRowStatus({ ...base, cooling_until: '2026-09-18T11:57:14.000Z' })).toContain('cooling until');
    expect(quotaRowStatus({ ...base, missing_key: true })).toBe('no key');
  });

  it('and the note says a job is stopped for want of one', () => {
    const md = renderQuotaMarkdown([], new Date(), [{ id: 'job_discovery_af6f903cc2a7', title: 'Read what the owner gave us', since: '2026-09-18T09:31:54.026Z' }]);
    expect(md).toContain('1 job is stopped waiting for model quota');
    expect(md).toContain('job_discovery_af6f903cc2a7');
    expect(renderQuotaMarkdown([], new Date())).not.toContain('stopped waiting for model quota');
  });

  it('blockedInWords says why, in words', () => {
    expect(blockedInWords({ kind: 'quota', id: 'all-providers', since: nowIso() })).toBe('waiting for model quota');
    expect(blockedInWords({ kind: 'message', id: 'msg_1', since: nowIso() })).toContain('colleague');
    expect(blockedInWords({ kind: 'owner', id: 'j', since: nowIso() })).toContain('waiting for you');
    expect(blockedInWords(undefined)).toBe('stopped');
  });

  it('the facts block carries the objectives one line each, never Plans/plan.md whole', () => {
    vault.writeText('Plans/plan.md', '---\nupdated: "2026-09-18"\ncycle: 1\n---\n# Plan\n\n## Objectives\n\n### technology\n- Ship the audit engine idea: [[Ideas/pagespeedaudit]]\n', 'ceo');
    const lines = planObjectiveLines(vault);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('technology — Ship the audit engine idea: [[Ideas/pagespeedaudit]]');
    expect(lines.join('\n')).not.toContain('---');
    expect(lines.join('\n')).not.toContain('cycle:');
    expect(lines.join('')).not.toContain('# Plan');
  });
});
