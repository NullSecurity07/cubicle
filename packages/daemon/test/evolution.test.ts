import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, createJob, readJob, parseNote, createProposal, listJobs, listInbox, findInboxById, JobResult, stringifyNote, updateJob } from '@cubicle/core';
import { parseToolsConfig, ToolRegistry, phase3Tools } from '@cubicle/tools';
import { vaultScheduler, runJob, type Llm } from '@cubicle/harness';
import { Daemon, defaultConfig, runHeartbeat, createHeartbeatJob, requeueUnblocked, dispatchProposals, applyHire, applyFire, freeDesk, activeRoles, maybeEnqueueCharterCompression, enqueueExperimentReviews, collectOwnerFeedback, collectOfflineOwnerComments, feedbackFor } from '../src/index.js';

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
    const j1 = createJob(vault, { type: 'custom', title: 'a', assigned: 'head_of_growth', goal: 'g' }, 'cto');
    const j2 = createJob(vault, { type: 'custom', title: 'b', assigned: 'head_of_growth', goal: 'g' }, 'cto');
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
    const j1 = createJob(vault, { type: 'custom', title: 'a', assigned: 'head_of_growth', goal: 'g' }, 'cto');
    const j2 = createJob(vault, { type: 'custom', title: 'b', assigned: 'head_of_growth', goal: 'g' }, 'cto');
    updateJob(vault, j1, { status: 'failed' }, 'daemon'); updateJob(vault, j2, { status: 'failed' }, 'daemon');
    const dup = createProposal(vault, { kind: 'hire', from: 'ceo', title: 'x', body: `[[${j1}]] [[${j1}]]\n\`\`\`markdown\n${CHARTER}\`\`\`` }, 'ceo');
    expect(await applyHire(vault, findInboxById(vault, dup.id)!)).toMatch(/at least 2 distinct/);
    const bad = createProposal(vault, { kind: 'hire', from: 'ceo', title: 'x', body: `[[${j1}]] [[${j2}]]\n\`\`\`markdown\n---\nrole: Bad Role\n---\n# c\n\`\`\`` }, 'ceo');
    expect(await applyHire(vault, findInboxById(vault, bad.id)!)).toMatch(/invalid/);
    vault.updateNote('Memory/constitution.md', (n) => ({ data: n.data, body: n.body.replace('max_roles: 12', 'max_roles: 9') }), 'owner');
    const full = createProposal(vault, { kind: 'hire', from: 'ceo', title: 'x', body: `[[${j1}]] [[${j2}]]\n\`\`\`markdown\n${CHARTER}\`\`\`` }, 'ceo');
    expect(await applyHire(vault, findInboxById(vault, full.id)!)).toMatch(/max_roles/);
  });
  it('fire deactivates, archives the charter, cancels open jobs; the CEO is protected', async () => {
    const open = createJob(vault, { type: 'custom', title: 'pending', assigned: 'head_of_growth', goal: 'g' }, 'cto');
    const p = createProposal(vault, { kind: 'fire', from: 'ceo', target: 'Roles/head_of_growth.md', title: 'Fire head_of_growth', body: 'no results' }, 'ceo');
    expect(await applyFire(vault, findInboxById(vault, p.id)!)).toMatch(/fired head_of_growth/);
    expect(vault.exists('Roles/head_of_growth.md')).toBe(false);
    expect(vault.list('Roles/archive', { ext: '.md' }).some((r) => r.includes('head_of_growth'))).toBe(true);
    expect(listJobs(vault).find((j) => j.id === open)!.status).toBe('cancelled');
    expect(vault.events.count('role.fired')).toBe(1);
    expect(vault.events.last('job.cancelled')!.job).toBe(open);
    const ceo = createProposal(vault, { kind: 'fire', from: 'ceo', target: 'Roles/ceo.md', title: 'x', body: 'x' }, 'ceo');
    expect(await applyFire(vault, findInboxById(vault, ceo.id)!)).toMatch(/cannot be fired/);
    expect(freeDesk(vault)).toBe('cubicle_3'); // growth's desk is free again
  });
  it('auto_approve_hire applies agent-created hires without an owner flip', async () => {
    vault.updateNote('Memory/constitution.md', (n) => ({ data: n.data, body: n.body.replace('auto_approve_hire: false', 'auto_approve_hire: true') }), 'owner');
    const j1 = createJob(vault, { type: 'custom', title: 'a', assigned: 'head_of_growth', goal: 'g' }, 'cto');
    const j2 = createJob(vault, { type: 'custom', title: 'b', assigned: 'head_of_growth', goal: 'g' }, 'cto');
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
    const shorter = CHARTER.replace('role: support', 'role: head_of_growth').replace('display: Support', 'display: Head of Growth').replace('sprite: support', 'sprite: growth').replace('desk: ""', 'desk: cubicle_3');
    const p = createProposal(vault, { kind: 'charter_change', from: 'cto', target: 'Roles/head_of_growth.md', title: 'Shorter head_of_growth charter', body: `## Proposed content\n\n\`\`\`markdown\n${shorter}\`\`\`` }, 'cto');
    expect(await dispatchProposals(deps())).toBe(0);
    ownerEdit(p.path, (t) => t.replace('approved: null', 'approved: true'));
    expect(await dispatchProposals(deps())).toBe(1);
    expect(vault.readText('Roles/head_of_growth.md')).toContain('kindly');
    vault.updateNote('Memory/constitution.md', (n) => ({ data: n.data, body: n.body.replace('auto_approve_charter_changes: false', 'auto_approve_charter_changes: true') }), 'owner');
    createProposal(vault, { kind: 'charter_change', from: 'cto', target: 'Roles/head_of_growth.md', title: 'v2', body: `## Proposed content\n\n\`\`\`markdown\n${shorter.replace('kindly', 'briskly')}\`\`\`` }, 'cto');
    expect(await dispatchProposals(deps())).toBe(1);
    expect(vault.readText('Roles/head_of_growth.md')).toContain('briskly');
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

/** A model nothing in these tests actually calls: the daemon needs one to construct its worker pool. */
const idleLlm: Llm = {
  async chat() { return { content: 'ok', toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 }, provider: 'f', model: 'f', tier: 'cheap', downgraded: false, parsedToolCalls: [] }; },
  promptBudget: () => 6000,
};

function daemonFor(llm: Llm) {
  return new Daemon(defaultConfig(dir, { CUBICLE_MOCK_TOOLS: '1' } as NodeJS.ProcessEnv, { port: 0, tickMs: 500, maxConcurrentJobs: 1, providersPath: path.join(root, 'config/providers.yaml'), toolsPath: path.join(root, 'config/tools.yaml') }), { llm, disableWs: true, disableSleepWatch: true, memory: false, log: () => undefined });
}

describe('owner comments left while the daemon was off (D4)', () => {
  it('are swept up at startup as owner.edited { offline: true } and reach the note\'s author role', async () => {
    vault.writeText('Plans/plan.md', '---\ncycle: 1\n---\n# Plan\n\n## Objectives\n\n### engineering\n- Ship it\n', 'cto');
    vault.events.emit({ type: 'heartbeat.completed', payload: { id: 'seed' } }); // recent → no startup heartbeat
    // The owner types into Obsidian with the daemon stopped: a raw write the watcher never sees.
    writeFileSync(path.join(dir, 'Plans/plan.md'), readFileSync(path.join(dir, 'Plans/plan.md'), 'utf8') + '\n%%cubicle: shorter briefs%%\n');

    const d = daemonFor(idleLlm);
    await d.start();
    try {
      const offline = d.vault.events.query({ types: ['owner.edited'] }).filter((e) => e.payload.offline === true);
      expect(offline.map((e) => e.payload.path)).toContain('Plans/plan.md');
      expect(feedbackFor(collectOwnerFeedback(d.vault), 'cto').map((f) => f.text)).toContain('shorter briefs');
    } finally { await d.stop(); }
  });

  it('a comment the system itself wrote is not mistaken for the owner', async () => {
    vault.writeText('Plans/plan.md', '---\ncycle: 1\n---\n# Plan\n\n%%cubicle: written by an agent%%\n', 'cto');
    vault.events.emit({ type: 'heartbeat.completed', payload: { id: 'seed' } });
    const d = daemonFor(idleLlm);
    await d.start();
    try {
      expect(d.vault.events.query({ types: ['owner.edited'] }).filter((e) => e.payload.offline === true)).toEqual([]);
    } finally { await d.stop(); }
  });
});

describe('preference feedback is delivered once (D5)', () => {
  /** A cycle with no team sections in the plan: one company.plan sub-job, no critic, no team plans. */
  const EMPTY_PLAN = '---\ncycle: 1\n---\n# Plan\n\n## Objectives\n';
  const per = new Map<string, number>();
  const planLlm: Llm = {
    async chat(_req, chat) {
      const base = { content: 'ok', toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 }, provider: 'f', model: 'f', tier: 'cheap' as const, downgraded: false, parsedToolCalls: [] as { name: string; args: Record<string, unknown> }[] };
      if (!chat.tools) return base;
      const jobMsg = String(chat.messages[1]?.content ?? '');
      const jobId = jobMsg.match(/Jobs\/(job_\w+)\.md/)?.[1] ?? 'x';
      const n = per.get(jobId) ?? 0; per.set(jobId, n + 1);
      if (/type: company\.plan/.test(jobMsg) && n === 0) return { ...base, parsedToolCalls: [{ name: 'vault.write', args: { path: 'Plans/plan.md', content: EMPTY_PLAN } }] };
      return { ...base, parsedToolCalls: [{ name: 'finish', args: { status: 'done', summary: 'done', verdict: 'pass' } }] };
    },
    promptBudget: () => 6000,
  };

  const setFeedback = (entries: string[]) => {
    const rel = path.join(dir, 'Memory/owner_preferences.md');
    writeFileSync(rel, readFileSync(rel, 'utf8').replace(/feedback: \[[^\]]*\]/, `feedback: [${entries.map((e) => JSON.stringify(e)).join(', ')}]`));
  };

  /** Start a heartbeat: gather has run and the CEO's company.plan job exists. Returns its id and its goal text. */
  async function beginCycle(): Promise<{ hb: string; goal: string }> {
    const hb = createHeartbeatJob(vault, 'test');
    expect((await runHeartbeat({ vault, llm: planLlm }, hb)).status).toBe('blocked');
    const plan = listJobs(vault).filter((j) => j.type === 'company.plan').at(-1)!;
    return { hb, goal: readJob(vault, plan.id)!.body };
  }

  /** Finish the company.plan job and let the heartbeat run through to commit. */
  async function endCycle(hb: string): Promise<void> {
    const harnessDeps = { vault, llm: planLlm, toolsConfig: cfg, registry: new ToolRegistry().registerAll(phase3Tools()), scheduler: vaultScheduler(vault), env: {} };
    const plan = listJobs(vault).filter((j) => j.type === 'company.plan').at(-1)!;
    expect((await runJob(harnessDeps, plan.id)).status).toBe('done');
    requeueUnblocked(vault);
    expect((await runHeartbeat({ vault, llm: planLlm }, hb)).status).toBe('done');
  }

  /** Run one whole heartbeat; returns the goal text the CEO's company.plan job was given. */
  async function runCycle(): Promise<string> {
    const { hb, goal } = await beginCycle();
    await endCycle(hb);
    return goal;
  }

  it('a feedback: entry reaches the CEO once and is never re-delivered; a new entry is delivered once too', async () => {
    setFeedback(['shorter briefs']);
    expect(await runCycle()).toContain('shorter briefs');
    expect(vault.events.query({ types: ['owner.feedback_delivered'] })).toHaveLength(1);

    expect(await runCycle()).not.toContain('shorter briefs');

    setFeedback(['shorter briefs', 'more experiments']);
    const third = await runCycle();
    expect(third).toContain('more experiments');
    expect(third).not.toContain('shorter briefs');

    const delivered = vault.events.query({ types: ['owner.feedback_delivered'] });
    expect(delivered).toHaveLength(2);
    expect(delivered.every((e) => typeof e.payload.sha === 'string' && e.payload.source === 'Memory/owner_preferences.md')).toBe(true);
    expect(new Set(delivered.map((e) => e.payload.sha)).size).toBe(2);

    expect(await runCycle()).not.toContain('more experiments');
  });

  it('an entry the owner adds mid-cycle is not marked by that cycle, and reaches the CEO in the next one', async () => {
    setFeedback([]);
    const { hb, goal } = await beginCycle(); // gather ran against an empty feedback list
    expect(goal).not.toContain('ship smaller');
    setFeedback(['ship smaller']); // Memory/ is not a heartbeat-wake area, so this cycle never sees it
    await endCycle(hb);

    // Nothing was shown, so nothing may be marked — otherwise the line is lost for good.
    expect(vault.events.query({ types: ['owner.feedback_delivered'] })).toEqual([]);

    const next = await runCycle();
    expect(next).toContain('ship smaller');
    expect(vault.events.query({ types: ['owner.feedback_delivered'] })).toHaveLength(1);
    expect(await runCycle()).not.toContain('ship smaller');
  });

  it('a swept offline comment is retired by the cycle that delivered it, so a second restart does not re-deliver it (I1)', async () => {
    setFeedback([]);
    // A note the system writes once and never rewrites — a brief, a decision, a skill. Its comment baseline is
    // recorded at that write, and nothing else ever moves it, so the startup sweep kept finding the same comment.
    vault.writeText('Runs/2026-01-01-aaaa.md', '---\nheartbeat: hb_a\n---\n# Since you were away\n\nWe shipped.\n', 'ceo');
    ownerEdit('Runs/2026-01-01-aaaa.md', (t) => t + '\n%%cubicle: too long, three bullets max%%\n');

    // Restart 1: the sweep finds it and the cycle shows it to the CEO.
    expect(collectOfflineOwnerComments(vault)).toContain('Runs/2026-01-01-aaaa.md');
    expect(await runCycle()).toContain('too long, three bullets max');

    // Restart 2: the comment is the same text in the same unmodified file, and it must not come round again.
    expect(collectOfflineOwnerComments(vault)).not.toContain('Runs/2026-01-01-aaaa.md');
    expect(await runCycle()).not.toContain('too long, three bullets max');

    // Restart 3, and a genuinely new comment on the same note still gets through.
    expect(collectOfflineOwnerComments(vault)).not.toContain('Runs/2026-01-01-aaaa.md');
    ownerEdit('Runs/2026-01-01-aaaa.md', (t) => t + '\n%%cubicle: name the customer%%\n');
    expect(collectOfflineOwnerComments(vault)).toContain('Runs/2026-01-01-aaaa.md');
    const third = await runCycle();
    expect(third).toContain('name the customer');
    expect(third).not.toContain('too long, three bullets max');
  });
});

describe('charter_change proposals show a diff (D6)', () => {
  it('the CTO\'s compression proposal gains a ## Diff section, before ## Proposed content, showing the changed line', async () => {
    for (let i = 0; i < 7; i++) vault.events.emit({ type: 'heartbeat.completed', payload: { id: `h${i}` } });
    const jobId = maybeEnqueueCharterCompression(vault)!;
    const target = 'Roles/head_of_growth.md';
    const current = vault.readNoteOrNull(target)!;
    const oldLine = current.body.split('\n').find((l) => l.trim().length > 20 && !l.startsWith('#'))!;
    const newLine = 'You keep this charter short.';
    const proposed = stringifyNote(current.data, current.body.replace(oldLine, newLine));

    const per = new Map<string, number>();
    const llm: Llm = {
      async chat(_req, chat) {
        const base = { content: 'ok', toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 }, provider: 'f', model: 'f', tier: 'cheap' as const, downgraded: false, parsedToolCalls: [] as { name: string; args: Record<string, unknown> }[] };
        if (!chat.tools) return base;
        const id = String(chat.messages[1]?.content ?? '').match(/Jobs\/(job_\w+)\.md/)?.[1] ?? 'x';
        const n = per.get(id) ?? 0; per.set(id, n + 1);
        if (n === 0) return { ...base, parsedToolCalls: [{ name: 'proposal.create', args: { kind: 'charter_change', target, title: 'Shorter head_of_growth charter', body: `One line says it better.\n\n## Proposed content\n\n\`\`\`markdown\n${proposed}\`\`\`\n` } }] };
        return { ...base, parsedToolCalls: [{ name: 'finish', args: { status: 'done', summary: 'one proposal filed' } }] };
      },
      promptBudget: () => 6000,
    };
    await runJob({ vault, llm, toolsConfig: cfg, registry: new ToolRegistry().registerAll(phase3Tools()), scheduler: vaultScheduler(vault), env: {} }, jobId);

    const filed = listInbox(vault).find((nn) => nn.data.kind === 'charter_change')!;
    expect(filed).toBeTruthy();
    expect(await dispatchProposals(deps())).toBe(0); // still unapproved: the sweep only annotates

    const body = listInbox(vault).find((nn) => nn.data.id === filed.data.id)!.body;
    expect(body).toContain('## Diff');
    expect(body.indexOf('## Diff')).toBeLessThan(body.indexOf('## Proposed content'));
    expect(body).toContain(`-${oldLine}`);
    expect(body).toContain(`+${newLine}`);
    expect(body).toContain(`--- ${target} (current)`);
    expect(body).toContain(`+++ ${target} (proposed)`);

    // Annotating is a system write, so the owner's later approval still reads as an owner flip.
    ownerEdit(filed.path, (t) => t.replace('approved: null', 'approved: true'));
    expect(await dispatchProposals(deps())).toBe(1);
    expect(vault.readText(target)).toContain(newLine);
  });

  it('a proposal that changes nothing, and one with no fenced content, still get a ## Diff so the sweep settles', async () => {
    const target = 'Roles/coo.md';
    const current = vault.readNoteOrNull(target)!;
    const identical = createProposal(vault, { kind: 'charter_change', from: 'cto', target, title: 'No-op', body: `Tidy.\n\n## Proposed content\n\n\`\`\`markdown\n${stringifyNote(current.data, current.body)}\`\`\`\n` }, 'cto');
    const noFence = createProposal(vault, { kind: 'charter_change', from: 'cto', target: 'Roles/engineer.md', title: 'Forgot the fence', body: 'I meant to paste the charter here.\n' }, 'cto');

    expect(await dispatchProposals(deps())).toBe(0);

    const identicalBody = findInboxById(vault, identical.id)!.body;
    expect(identicalBody).toContain('## Diff');
    expect(identicalBody).toMatch(/no change/i);
    expect(identicalBody.indexOf('## Diff')).toBeLessThan(identicalBody.indexOf('## Proposed content'));

    const noFenceBody = findInboxById(vault, noFence.id)!.body;
    expect(noFenceBody).toContain('## Diff');
    expect(noFenceBody).toMatch(/nothing to compare/i);

    // The marker settles the sweep: a second tick leaves both notes byte-identical.
    const shas = [identical, noFence].map((p) => vault.currentSha(findInboxById(vault, p.id)!.path));
    expect(await dispatchProposals(deps())).toBe(0);
    expect([identical, noFence].map((p) => vault.currentSha(findInboxById(vault, p.id)!.path))).toEqual(shas);
  });

  it('a changed line containing $& or $1 lands in the diff verbatim', async () => {
    const target = 'Roles/engineer.md';
    const current = vault.readNoteOrNull(target)!;
    const oldLine = current.body.split('\n').find((l) => l.trim().length > 20 && !l.startsWith('#'))!;
    const newLine = 'Escape shell arguments: use "$@", never $& or $1.';
    // Function replacement here too: `$&` in the new line would otherwise be expanded by String.replace itself.
    const proposed = stringifyNote(current.data, current.body.replace(oldLine, () => newLine));
    createProposal(vault, { kind: 'charter_change', from: 'cto', target, title: 'Shell rule', body: `Tighter.\n\n## Proposed content\n\n\`\`\`markdown\n${proposed}\`\`\`\n` }, 'cto');

    expect(await dispatchProposals(deps())).toBe(0);

    const body = listInbox(vault).find((nn) => nn.data.kind === 'charter_change')!.body;
    expect(body).toContain(`+${newLine}`);
    expect(body.indexOf('## Diff')).toBeLessThan(body.indexOf('## Proposed content'));
  });
});
