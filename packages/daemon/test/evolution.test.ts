import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, createJob, createProposal, listJobs, listInbox, findInboxById, JobResult, stringifyNote, updateJob } from '@cubicle/core';
import { parseToolsConfig, ToolRegistry, phase3Tools } from '@cubicle/tools';
import { vaultScheduler, runJob, type Llm } from '@cubicle/harness';
import { dispatchProposals, applyHire, applyFire, freeDesk, activeRoles, maybeEnqueueCharterCompression, enqueueExperimentReviews, collectOwnerFeedback, feedbackFor } from '../src/index.js';

const root = path.resolve(__dirname, '../../..');
const cfg = parseToolsConfig(readFileSync(path.join(root, 'config/tools.yaml'), 'utf8'));
let dir: string; let vault: Vault;
beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-evo-')); vault = (await scaffoldVault(dir)).vault; });
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });
const ownerEdit = (rel: string, f: (t: string) => string) => writeFileSync(path.join(dir, rel), f(readFileSync(path.join(dir, rel), 'utf8')));
const deps = () => ({ vault, registry: new ToolRegistry().registerAll(phase3Tools()), toolsConfig: cfg, scheduler: vaultScheduler(vault), env: {} });

const CHARTER = `---
role: support
display: Support
model_tier: cheap
tools: [vault.read, vault.write, colleague.message, finish]
approval_overrides: {}
active: true
hired: ""
sprite: support
desk: ""
---
# Charter

You answer customer questions kindly.
`;

describe('hire / fire (acceptance test 7, headless)', () => {
  it('a hire proposal with ≥2 job links, approved by the owner, creates the role, desk, inbox, event', async () => {
    const j1 = createJob(vault, { type: 'custom', title: 'a', assigned: 'growth', goal: 'g' }, 'cto');
    const j2 = createJob(vault, { type: 'custom', title: 'b', assigned: 'growth', goal: 'g' }, 'cto');
    updateJob(vault, j1, { status: 'blocked', blocked_on: { kind: 'owner', id: 'x', since: 'now' } }, 'daemon');
    updateJob(vault, j2, { status: 'failed' }, 'daemon');
    const p = createProposal(vault, { kind: 'hire', from: 'ceo', title: 'Hire Support', body: `Growth keeps blocking on [[${j1}]] and [[${j2}]].\n\n\`\`\`markdown\n${CHARTER}\`\`\`\n` }, 'ceo');
    let hired: string | null = null;
    expect(await dispatchProposals({ ...deps(), onRoleHired: (r) => (hired = r) })).toBe(0);
    ownerEdit(p.path, (t) => t.replace('approved: null', 'approved: true'));
    expect(await dispatchProposals({ ...deps(), onRoleHired: (r) => (hired = r) })).toBe(1);
    expect(hired).toBe('support');
    expect(vault.exists('Roles/support.md')).toBe(true);
    expect(vault.exists('Messages/support.md')).toBe(true);
    const role = activeRoles(vault).find((r) => r.role === 'support')!;
    expect(role.desk).toMatch(/^cubicle_\d$/);
    expect(role.hired).toBeTruthy();
    expect(vault.events.count('role.hired')).toBe(1);
    expect(findInboxById(vault, p.id)!.body).toContain('hired support');
    // a support job can now run through the harness
    const id = createJob(vault, { type: 'custom', title: 'answer', assigned: 'support', goal: 'g' }, 'ceo');
    const llm: Llm = { async chat() { return { content: '', toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 }, provider: 'f', model: 'f', tier: 'cheap', downgraded: false, parsedToolCalls: [{ name: 'finish', args: { status: 'done', summary: 'ok', lessons: ['answer within a day'] } }] }; }, promptBudget: () => 6000 };
    expect((await runJob({ vault, llm, toolsConfig: cfg, registry: new ToolRegistry().registerAll(phase3Tools()), scheduler: vaultScheduler(vault), env: {} }, id)).status).toBe('done');
    expect(vault.readText('Memory/lessons.md')).toContain(`[[${id}]] answer within a day (support)`);
  });
  it('rejects hires without justification, over max_roles, or with a bad charter', async () => {
    const p1 = createProposal(vault, { kind: 'hire', from: 'ceo', title: 'x', body: '```markdown\n' + CHARTER + '```' }, 'ceo');
    expect(await applyHire(vault, { ...p1, ...findInboxById(vault, p1.id)! })).toMatch(/at least 2/);
    const j1 = createJob(vault, { type: 'custom', title: 'a', assigned: 'growth', goal: 'g' }, 'cto');
    const j2 = createJob(vault, { type: 'custom', title: 'b', assigned: 'growth', goal: 'g' }, 'cto');
    updateJob(vault, j1, { status: 'failed' }, 'daemon'); updateJob(vault, j2, { status: 'failed' }, 'daemon');
    const dup = createProposal(vault, { kind: 'hire', from: 'ceo', title: 'x', body: `[[${j1}]] [[${j1}]]\n\`\`\`markdown\n${CHARTER}\`\`\`` }, 'ceo');
    expect(await applyHire(vault, findInboxById(vault, dup.id)!)).toMatch(/at least 2 distinct/);
    const bad = createProposal(vault, { kind: 'hire', from: 'ceo', title: 'x', body: `[[${j1}]] [[${j2}]]\n\`\`\`markdown\n---\nrole: Bad Role\n---\n# c\n\`\`\`` }, 'ceo');
    expect(await applyHire(vault, findInboxById(vault, bad.id)!)).toMatch(/invalid/);
    vault.updateNote('Memory/constitution.md', (n) => ({ data: n.data, body: n.body.replace('max_roles: 8', 'max_roles: 5') }), 'owner');
    const full = createProposal(vault, { kind: 'hire', from: 'ceo', title: 'x', body: `[[${j1}]] [[${j2}]]\n\`\`\`markdown\n${CHARTER}\`\`\`` }, 'ceo');
    expect(await applyHire(vault, findInboxById(vault, full.id)!)).toMatch(/max_roles/);
  });
  it('fire deactivates, archives the charter, cancels open jobs; the CEO is protected', async () => {
    const open = createJob(vault, { type: 'custom', title: 'pending', assigned: 'growth', goal: 'g' }, 'cto');
    const p = createProposal(vault, { kind: 'fire', from: 'ceo', target: 'Roles/growth.md', title: 'Fire growth', body: 'no results' }, 'ceo');
    expect(await applyFire(vault, findInboxById(vault, p.id)!)).toMatch(/fired growth/);
    expect(vault.exists('Roles/growth.md')).toBe(false);
    expect(vault.list('Roles/archive', { ext: '.md' }).some((r) => r.includes('growth'))).toBe(true);
    expect(listJobs(vault).find((j) => j.id === open)!.status).toBe('cancelled');
    expect(vault.events.count('role.fired')).toBe(1);
    const ceo = createProposal(vault, { kind: 'fire', from: 'ceo', target: 'Roles/ceo.md', title: 'x', body: 'x' }, 'ceo');
    expect(await applyFire(vault, findInboxById(vault, ceo.id)!)).toMatch(/cannot be fired/);
    expect(freeDesk(vault)).toBe('cubicle_3'); // growth's desk is free again
  });
  it('auto_approve_hire applies agent-created hires without an owner flip', async () => {
    vault.updateNote('Memory/constitution.md', (n) => ({ data: n.data, body: n.body.replace('auto_approve_hire: false', 'auto_approve_hire: true') }), 'owner');
    const j1 = createJob(vault, { type: 'custom', title: 'a', assigned: 'growth', goal: 'g' }, 'cto');
    const j2 = createJob(vault, { type: 'custom', title: 'b', assigned: 'growth', goal: 'g' }, 'cto');
    updateJob(vault, j1, { status: 'failed' }, 'daemon'); updateJob(vault, j2, { status: 'failed' }, 'daemon');
    createProposal(vault, { kind: 'hire', from: 'ceo', title: 'Hire Support', body: `[[${j1}]] [[${j2}]]\n\`\`\`markdown\n${CHARTER}\`\`\`` }, 'ceo');
    expect(await dispatchProposals(deps())).toBe(1);
    expect(vault.exists('Roles/support.md')).toBe(true);
  });
});

describe('charter compression, experiments, owner feedback', () => {
  it('enqueues cto.compress_charters exactly once per 7 heartbeats', () => {
    for (let i = 0; i < 6; i++) vault.events.emit({ type: 'heartbeat.completed', payload: { id: `h${i}` } });
    expect(maybeEnqueueCharterCompression(vault)).toBeNull();
    vault.events.emit({ type: 'heartbeat.completed', payload: { id: 'h7' } });
    const id = maybeEnqueueCharterCompression(vault)!;
    expect(id).toBe('job_compress_7');
    expect(maybeEnqueueCharterCompression(vault)).toBeNull();
    expect(listJobs(vault).find((j) => j.id === id)!.type).toBe('cto.compress_charters');
  });
  it('charter_change proposals with a valid fenced charter are applied on approval (and auto-approved when allowed)', async () => {
    const shorter = CHARTER.replace('role: support', 'role: growth').replace('display: Support', 'display: Growth').replace('sprite: support', 'sprite: growth').replace('desk: ""', 'desk: cubicle_3');
    const p = createProposal(vault, { kind: 'charter_change', from: 'cto', target: 'Roles/growth.md', title: 'Shorter growth charter', body: `## Proposed content\n\n\`\`\`markdown\n${shorter}\`\`\`` }, 'cto');
    expect(await dispatchProposals(deps())).toBe(0);
    ownerEdit(p.path, (t) => t.replace('approved: null', 'approved: true'));
    expect(await dispatchProposals(deps())).toBe(1);
    expect(vault.readText('Roles/growth.md')).toContain('kindly');
    vault.updateNote('Memory/constitution.md', (n) => ({ data: n.data, body: n.body.replace('auto_approve_charter_changes: false', 'auto_approve_charter_changes: true') }), 'owner');
    createProposal(vault, { kind: 'charter_change', from: 'cto', target: 'Roles/growth.md', title: 'v2', body: `## Proposed content\n\n\`\`\`markdown\n${shorter.replace('kindly', 'briskly')}\`\`\`` }, 'cto');
    expect(await dispatchProposals(deps())).toBe(1);
    expect(vault.readText('Roles/growth.md')).toContain('briskly');
  });
  it('running experiments past review_date get one COO judgement job; owner feedback is attributed to roles', () => {
    vault.writeText('Experiments/exp_1.md', stringifyNote({ id: 'exp_1', title: 'Cold email v2', owner: 'growth', status: 'running', metric: 'replies', review_date: '2026-01-01' }, '## Hypothesis\n\nx\n'), 'growth');
    vault.writeText('Experiments/exp_2.md', stringifyNote({ id: 'exp_2', title: 'later', owner: 'growth', status: 'running', review_date: '2099-01-01' }, 'x'), 'growth');
    const first = enqueueExperimentReviews(vault);
    expect(first.length).toBe(1);
    expect(enqueueExperimentReviews(vault)).toEqual([]);
    expect(listJobs(vault).find((j) => j.id === first[0])!.assigned).toBe('coo');
    updateJob(vault, first[0], { status: 'failed' }, 'daemon'); // a failed judgement gets a fresh one
    expect(enqueueExperimentReviews(vault).length).toBe(1);
    // owner comments
    writeFileSync(path.join(dir, 'Plans/plan.md'), '---\ncycle: 1\n---\n# Plan\n\n%%cubicle: too ambitious, cut to one job%%\n');
    vault.events.emit({ type: 'owner.edited', agent: 'owner', payload: { path: 'Plans/plan.md', area: 'Plans' } });
    vault.writeText('Decisions/d1.md', stringifyNote({ id: 'd1', decided_by: 'growth', cycle: 'x', status: 'adopted', owner_rating: 'down' }, '# d'), 'growth');
    const all = collectOwnerFeedback(vault);
    expect(feedbackFor(all, 'cto').map((f) => f.text)).toEqual(['too ambitious, cut to one job']);
    expect(feedbackFor(all, 'growth').some((f) => /rated this decision down/.test(f.text))).toBe(true);
  });
});
