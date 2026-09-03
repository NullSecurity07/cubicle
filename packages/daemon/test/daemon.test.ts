import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { scaffoldVault, Vault, createJob, readJob, listJobs, listInbox, findInboxById, createProposal, updateJob } from '@cubicle/core';
import type { RoutedChatResult, RouteRequest, ChatMessage, ToolSchema } from '@cubicle/router';
import type { Llm } from '@cubicle/harness';
import { Daemon, defaultConfig, runHeartbeat, createHeartbeatJob, dispatchProposals, requeueUnblocked, buildSnapshot } from '../src/index.js';
import { parseToolsConfig, ToolRegistry, phase3Tools } from '@cubicle/tools';
import { vaultScheduler } from '@cubicle/harness';

const root = path.resolve(__dirname, '../../..');
let dir: string;
beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-daemon-')); const { vault } = await scaffoldVault(dir); vault.close(); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Role-aware scripted LLM: CTO writes the plan and enqueues jobs, everyone else finishes immediately; CEO prose calls get canned text. */
function fakeLlm(opts: { ctoSteps?: number } = {}): Llm & { calls: { role?: string; tools: boolean }[] } {
  const perJob = new Map<string, number>();
  const llm = {
    calls: [] as { role?: string; tools: boolean }[],
    async chat(req: RouteRequest, chat: { messages: ChatMessage[]; tools?: ToolSchema[] }): Promise<RoutedChatResult> {
      llm.calls.push({ role: req.roleId, tools: !!chat.tools });
      const base = { content: '', toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 5, completion_tokens: 1 }, provider: 'fake', model: 'fake', tier: 'strong' as const, downgraded: false, parsedToolCalls: [] as { name: string; args: Record<string, unknown> }[] };
      if (!chat.tools) {
        const u = String(chat.messages[chat.messages.length - 1].content);
        if (/NAME:/.test(u)) return { ...base, content: 'NAME: Bright Ledger\nTAGLINE: Bookkeeping for tiny shops.' };
        if (/three one-line business ideas/.test(u)) return { ...base, content: '1. Bright Ledger — bookkeeping for tiny shops.\n2. Porch Pantry — weekly veg box.\n3. Quiet Desk — focus timer.' };
        if (/since you were away/.test(u)) return { ...base, content: '## What happened\n- Planned the cycle.\n\n## What\'s next\n- Scaffold the site.\n\n## What needs you\n- Approve the name.' };
        return { ...base, content: 'Understood.' };
      }
      const jobMsg = String(chat.messages[1]?.content ?? '');
      const jobId = jobMsg.match(/Jobs\/(job_\w+)\.md/)?.[1] ?? 'x';
      const n = perJob.get(jobId) ?? 0; perJob.set(jobId, n + 1);
      if (req.roleId === 'cto') {
        const steps = [
          { name: 'vault.write', args: { path: 'Plans/plan.md', content: '---\ncycle: 1\n---\n# Plan\n\n## Objective\nShip a landing page.\n\n## This cycle\n- [ ] scaffold Site/\n' } },
          { name: 'scheduler.request', args: { type: 'engineer.ship', title: 'Scaffold Site/', assigned: 'engineer', goal: 'Create Site/index.html from Brand/.' } },
          { name: 'finish', args: { status: 'done', summary: 'Planned one job.' } },
        ];
        return { ...base, parsedToolCalls: [steps[Math.min(n, steps.length - 1)]] };
      }
      return { ...base, parsedToolCalls: [{ name: 'finish', args: { status: 'done', summary: `${req.roleId} done` } }] };
    },
    promptBudget: () => 6000,
  };
  return llm;
}

function daemonFor(llm: Llm, port = 0) {
  return new Daemon(defaultConfig(dir, { CUBICLE_MOCK_TOOLS: '1' } as NodeJS.ProcessEnv, { port, tickMs: 500, maxConcurrentJobs: 2, providersPath: path.join(root, 'config/providers.yaml'), toolsPath: path.join(root, 'config/tools.yaml') }), { llm, disableSleepWatch: true, memory: false, log: () => undefined });
}

async function waitFor(pred: () => boolean, ms = 15000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 100)); }
}

describe('heartbeat as a resumable job', () => {
  it('runs all steps, awaits cto.plan, writes Runs/, queue.md, commits, answers the owner, proposes a name', async () => {
    const vault = Vault.open(dir);
    const llm = fakeLlm();
    createProposal(vault, { kind: 'message', from: 'owner', to: 'ceo', title: 'idea', body: 'Bookkeeping for tiny shops' }, 'owner');
    const hb = createHeartbeatJob(vault, 'test');
    const deps = { vault, llm };
    const first = await runHeartbeat(deps, hb);
    expect(first.status).toBe('blocked');
    expect(readJob(vault, hb)!.data.checkpoint_step).toBe(4);
    const plan = listJobs(vault).find((j) => j.type === 'cto.plan')!;
    expect(plan).toBeTruthy();
    // owner message answered + name proposed during step 3
    const msgs = listInbox(vault).filter((n) => n.data.kind === 'message');
    expect(msgs[0].data.answered).toBe(true);
    expect(msgs[0].body).toContain('## CEO');
    expect(listInbox(vault).some((n) => n.data.kind === 'brand_change' && n.data.target === 'Brand/name.md' && n.body.includes('Bright Ledger'))).toBe(true);
    // second visit while plan still running → still blocked
    expect((await runHeartbeat(deps, hb)).status).toBe('blocked');
    // finish the plan job via the harness
    const { runJob } = await import('@cubicle/harness');
    const cfg = parseToolsConfig(readFileSync(path.join(root, 'config/tools.yaml'), 'utf8'));
    const out = await runJob({ vault, llm, toolsConfig: cfg, registry: new ToolRegistry().registerAll(phase3Tools()), scheduler: vaultScheduler(vault), env: {} }, plan.id);
    expect(out.status).toBe('done');
    expect(vault.readText('Plans/plan.md')).toContain('Ship a landing page');
    expect(listJobs(vault).some((j) => j.type === 'engineer.ship')).toBe(true);
    expect(requeueUnblocked(vault)).toBe(1);
    const done = await runHeartbeat(deps, hb);
    expect(done.status).toBe('done');
    const runs = vault.list('Runs', { ext: '.md' });
    expect(runs.length).toBe(1);
    expect(vault.readText(runs[0])).toContain('## What needs you');
    expect(vault.readText('Jobs/queue.md')).toContain(hb);
    expect(vault.events.count('heartbeat.completed')).toBe(1);
    expect(vault.events.count('job.done')).toBeGreaterThanOrEqual(2);
    const { lastCommitHash } = await import('@cubicle/core');
    const log = (await import('node:child_process')).execSync('git log --oneline', { cwd: dir }).toString();
    expect(log).toContain('cubicle: heartbeat');
    expect(await lastCommitHash(dir)).toBeTruthy();
    vault.close();
  });

  it('kill during planning → restart → exactly one Runs/ note and one heartbeat commit', async () => {
    const vault = Vault.open(dir);
    const llm = fakeLlm();
    const hb = createHeartbeatJob(vault, 'test');
    await runHeartbeat({ vault, llm }, hb); // blocked on cto.plan
    rmSync(path.join(dir, '.cubicle/jobs'), { recursive: true, force: true }); // cache wiped: state must come from the vault
    vault.close();
    // "restart": a daemon comes up, marks nothing (heartbeat is blocked, not running), runs the plan job and resumes
    const d = daemonFor(llm);
    await d.start();
    await waitFor(() => d.vault.events.count('heartbeat.completed') >= 1, 20000);
    await d.stop();
    const v2 = Vault.open(dir);
    expect(v2.list('Runs', { ext: '.md' }).length).toBe(1);
    const log = (await import('node:child_process')).execSync('git log --oneline', { cwd: dir }).toString();
    expect(log.split('\n').filter((l) => l.includes('cubicle: heartbeat')).length).toBe(1);
    expect(listJobs(v2).filter((j) => j.type === 'ceo.heartbeat').length).toBe(1);
    expect(listJobs(v2).filter((j) => j.type === 'cto.plan').length).toBe(1);
    expect(v2.list('Plans/archive', { ext: '.md' }).length).toBeLessThanOrEqual(1);
    v2.close();
  });
});

describe('brand reconcile (acceptance test 3, heartbeat half)', () => {
  it('owner edits Brand/palette.md → next heartbeat enqueues "Reconcile site with brand" once', async () => {
    const vault = Vault.open(dir);
    const llm = fakeLlm();
    // seed a completed heartbeat so "since" is meaningful, then an owner edit
    vault.events.emit({ type: 'heartbeat.completed', payload: { id: 'seed' } });
    writeFileSync(path.join(dir, 'Brand/palette.md'), readFileSync(path.join(dir, 'Brand/palette.md'), 'utf8').replace('#f59e0b', '#0ea5e9'));
    vault.events.emit({ type: 'owner.edited', agent: 'owner', payload: { path: 'Brand/palette.md', area: 'Brand', wakes_heartbeat: true } });
    const hb = createHeartbeatJob(vault, 'owner edited Brand/palette.md');
    await runHeartbeat({ vault, llm }, hb);
    const rec = listJobs(vault).filter((j) => /reconcile site with brand/i.test(j.title));
    expect(rec.length).toBe(1);
    expect(rec[0].assigned).toBe('engineer');
    expect(rec[0].type).toBe('engineer.ship');
    // a second heartbeat while it is still open does not duplicate it
    const hb2 = createHeartbeatJob(vault, 'again');
    vault.events.emit({ type: 'owner.edited', agent: 'owner', payload: { path: 'Brand/voice.md', area: 'Brand', wakes_heartbeat: true } });
    await runHeartbeat({ vault, llm }, hb2);
    expect(listJobs(vault).filter((j) => /reconcile site with brand/i.test(j.title)).length).toBe(1);
    vault.close();
  });
});

describe('snapshot for the office', () => {
  it('carries the brand and the pending proposals (title, kind, path), never plain messages', () => {
    const vault = Vault.open(dir);
    writeFileSync(path.join(dir, 'Brand/name.md'), '---\nname: "PlateReady"\ntagline: "Meal plans for busy parents"\nurl: "https://plateready.pages.dev"\n---\n# PlateReady\n');
    createProposal(vault, { kind: 'spend', from: 'engineer', title: 'Deploy the site', body: 'x' }, 'engineer');
    createProposal(vault, { kind: 'message', from: 'cto', to: 'owner', title: 'Q', body: 'Which colour?' }, 'cto');
    const snap = buildSnapshot(vault);
    expect(snap.brand).toEqual({ name: 'PlateReady', tagline: 'Meal plans for busy parents', url: 'https://plateready.pages.dev' });
    expect(snap.inbox.map((n) => [n.kind, n.title])).toEqual([['spend', 'Deploy the site']]);
    expect(snap.inbox[0].path).toMatch(/^00 Inbox\//);
    expect(snap.pendingProposals).toBe(1);
    writeFileSync(path.join(dir, '00 Inbox/idea.md'), '---\nid: msg_idea\nkind: message\nfrom: owner\nto: ceo\ncreated: 2026-09-03T04:37:00.000Z\nanswered: true\n---\nA meal-planning site.\n\n## CEO\n\nGot it. I proposed **PlateReady**.\n');
    expect(buildSnapshot(vault).chat).toEqual([{ ts: '2026-09-03T04:37:00.000Z', from: 'you', text: 'A meal-planning site.' }, { ts: '2026-09-03T04:37:00.000Z', from: 'ceo', text: 'Got it. I proposed **PlateReady**.' }]);
    vault.close();
  });
});

describe('daemon lifecycle', () => {
  it('an owner note typed while the daemon was down (only kind: message) triggers a heartbeat that answers it', async () => {
    const seed = Vault.open(dir);
    seed.events.emit({ type: 'heartbeat.completed', payload: { id: 'seed' } }); // recent → no startup heartbeat
    seed.close();
    writeFileSync(path.join(dir, '00 Inbox/idea.md'), '---\nkind: message\n---\nA one-page site selling a printable meal-planning template.\n');
    const d = daemonFor(fakeLlm());
    await d.start();
    const v = Vault.open(dir);
    try {
      await waitFor(() => listJobs(v).some((j) => j.type === 'ceo.heartbeat' && /unanswered owner message/.test(j.title)), 10000);
      await waitFor(() => /answered: true/.test(readFileSync(path.join(dir, '00 Inbox/idea.md'), 'utf8')), 20000);
    } finally { await d.stop(); }
    const text = readFileSync(path.join(dir, '00 Inbox/idea.md'), 'utf8');
    expect(text).toMatch(/## CEO/);
    expect(text).toMatch(/^id: msg_/m);
    expect(text).toMatch(/^created: /m);
    expect(listInbox(v).some((n) => n.data.kind === 'brand_change')).toBe(true);
    expect(listJobs(v).filter((j) => j.type === 'ceo.heartbeat').length).toBe(1); // no re-trigger loop once answered
    v.close();
  });

  it('first start runs heartbeat #1 from an owner idea with zero outbound events; verify chain terminates', async () => {
    const vault = Vault.open(dir);
    createProposal(vault, { kind: 'message', from: 'owner', to: 'ceo', title: 'idea', body: 'Bookkeeping for tiny shops' }, 'owner');
    vault.close();
    const d = daemonFor(fakeLlm());
    await d.start();
    await waitFor(() => d.vault.events.count('heartbeat.completed') >= 1, 20000);
    // engineer.ship (scaffold) runs and finishes; its coo.verify runs; then nothing else is enqueued
    await waitFor(() => listJobs(d.vault).filter((j) => j.type === 'coo.verify' && j.status === 'done').length >= 1, 20000);
    await new Promise((r) => setTimeout(r, 1500));
    const jobs = listJobs(d.vault);
    expect(jobs.filter((j) => j.type === 'coo.verify').length).toBe(1); // no verify-of-verify chain
    expect(jobs.filter((j) => ['queued', 'running'].includes(j.status)).length).toBe(0);
    expect(d.vault.events.count('email.sent')).toBe(0);
    expect(d.vault.events.count('deploy.done')).toBe(0);
    expect(listInbox(d.vault).some((n) => n.data.kind === 'brand_change')).toBe(true);
    expect(existsSync(path.join(dir, '.cubicle', 'daemon.json'))).toBe(true);
    const t0 = Date.now();
    await d.stop();
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(existsSync(path.join(dir, '.cubicle', 'daemon.json'))).toBe(false);
  });

  it('dispatcher: file_change applies the diff; brand_change with chosen sets the name and queues reconcile; message answers route to Messages/', async () => {
    const vault = Vault.open(dir);
    const cfg = parseToolsConfig(readFileSync(path.join(root, 'config/tools.yaml'), 'utf8'));
    const deps = { vault, registry: new ToolRegistry().registerAll(phase3Tools()), toolsConfig: cfg, scheduler: vaultScheduler(vault), env: {} };
    const fc = createProposal(vault, { kind: 'file_change', from: 'cto', target: 'Memory/owner_preferences.md', title: 'x', body: '## Proposed content\n\n```\n# Owner preferences\n\nchanged by proposal\n```\n', call: { tool: 'vault.write', args: { path: 'Memory/owner_preferences.md', content: '# Owner preferences\n\nchanged by proposal\n' }, idempotency_key: 'job_x:1:1', role: 'cto' } }, 'cto');
    // an agent-authored brand_change pointing at the constitution must never be applied, even when approved
    const evil = createProposal(vault, { kind: 'brand_change', from: 'growth', target: 'Memory/constitution.md', title: 'Tagline tweak', body: '## Proposed content\n\n```\nmax_emails_per_day: 99999\n```\n' }, 'growth');
    const bc = createProposal(vault, { kind: 'brand_change', from: 'ceo', target: 'Brand/name.md', title: 'ideas', body: '1. Bright Ledger — bookkeeping for tiny shops.\n2. Porch Pantry — veg box.\n3. Quiet Desk — timer.' }, 'ceo');
    const q = createProposal(vault, { kind: 'message', from: 'engineer', to: 'owner', title: 'q', body: 'Which colour?', job: 'job_x' }, 'engineer');
    expect(await dispatchProposals(deps)).toBe(0);
    // The owner edits in Obsidian = a raw file write the vault API never saw (sha differs from written_sha).
    const ownerEdit = (rel: string, f: (t: string) => string) => writeFileSync(path.join(dir, rel), f(readFileSync(path.join(dir, rel), 'utf8')));
    ownerEdit(fc.path, (t) => t.replace('approved: null', 'approved: true'));
    ownerEdit(bc.path, (t) => t.replace('approved: null', 'approved: true').replace('chosen: null', 'chosen: 2'));
    ownerEdit(q.path, (t) => t.replace('answered: null', 'answered: true') + '\n## Owner\n\nBlue.\n');
    ownerEdit(evil.path, (t) => t.replace('approved: null', 'approved: true'));
    expect(await dispatchProposals(deps)).toBe(3);
    expect(vault.readText('Memory/owner_preferences.md')).toContain('changed by proposal');
    expect(vault.readText('Memory/constitution.md')).toContain('max_emails_per_day: 20');
    expect(findInboxById(vault, evil.id)!.data.resolved_at).toBeNull();
    expect(findInboxById(vault, evil.id)!.body).toContain('Not applied');
    expect(vault.readText('Brand/name.md')).toContain('name: Porch Pantry');
    expect(listJobs(vault).some((j) => /reconcile site with brand/i.test(j.title))).toBe(true);
    expect(vault.readText('Messages/engineer.md')).toContain(`re:${q.id} Blue.`);
    expect(findInboxById(vault, fc.id)!.data.resolved_at).toBeTruthy();
    expect(vault.events.count('proposal.resolved')).toBe(3);
    expect(await dispatchProposals(deps)).toBe(0); // idempotent
    // A flip written through the system (e.g. an agent that somehow wrote the note) is ignored with guardrail.blocked
    const forged = createProposal(vault, { kind: 'file_change', from: 'cto', target: 'Memory/lessons.md', title: 'f', body: 'x', call: { tool: 'vault.write', args: { path: 'Memory/lessons.md', content: 'forged' }, idempotency_key: 'k' } }, 'cto');
    vault.updateNote(forged.path, (n) => ({ data: { ...n.data, approved: true }, body: n.body }), 'cto');
    expect(await dispatchProposals(deps)).toBe(0);
    expect(vault.readText('Memory/lessons.md')).not.toContain('forged');
    expect(vault.events.count('guardrail.blocked')).toBeGreaterThanOrEqual(1);
    vault.close();
  });

  it('approved spend proposal executes the stored deploy exactly once via the dispatcher (R17/R31)', async () => {
    const vault = Vault.open(dir);
    const { phase6Tools } = await import('@cubicle/tools');
    const cfg = parseToolsConfig(readFileSync(path.join(root, 'config/tools.yaml'), 'utf8'));
    const deps = { vault, registry: new ToolRegistry().registerAll([...phase3Tools(), ...phase6Tools()]), toolsConfig: cfg, scheduler: vaultScheduler(vault), env: {} };
    const { mkdirSync } = await import('node:fs');
    mkdirSync(path.join(dir, 'Site/dist'), { recursive: true }); writeFileSync(path.join(dir, 'Site/dist/index.html'), '<h1>v1</h1>');
    const job = createJob(vault, { type: 'engineer.ship', title: 'ship', assigned: 'engineer', goal: 'x' }, 'cto');
    const p = createProposal(vault, { kind: 'spend', from: 'engineer', job, title: 'deploy', body: 'x', call: { tool: 'deploy.site', args: {}, idempotency_key: `${job}:1:3`, job, role: 'engineer' } }, 'engineer');
    writeFileSync(path.join(dir, p.path), readFileSync(path.join(dir, p.path), 'utf8').replace('approved: null', 'approved: true'));
    expect(await dispatchProposals(deps)).toBe(1);
    expect(vault.events.count('deploy.done')).toBe(1);
    expect(readJob(vault, job)!.data.side_effects_done).toEqual([`${job}:1:3`]);
    expect(await dispatchProposals(deps)).toBe(0);
    expect(vault.events.count('deploy.done')).toBe(1);
    const mock = readFileSync(path.join(dir, '.cubicle/mock/deploy.jsonl'), 'utf8').trim().split('\n');
    expect(mock.length).toBe(1);
    vault.close();
  });

  it('ask-mode call: owner approves → dispatcher requeues → worker executes the stored call exactly once (B1)', async () => {
    const vault = Vault.open(dir);
    vault.updateNote('Roles/head_of_growth.md', (n) => ({ data: { ...n.data, tools: [...(n.data.tools as string[]), 'mock.outbound'] }, body: n.body }), 'owner');
    vault.events.emit({ type: 'heartbeat.completed', payload: { id: 'seed' } });
    const id = createJob(vault, { type: 'growth.outreach', title: 'ask', assigned: 'head_of_growth', goal: 'g' }, 'cto');
    vault.close();
    const askCfg = readFileSync(path.join(root, 'config/tools.yaml'), 'utf8').replace('mock.outbound:         { mode: auto', 'mock.outbound:         { mode: ask');
    const cfgPath = path.join(dir, '.cubicle', 'tools-ask.yaml');
    writeFileSync(cfgPath, askCfg);
    let calls = 0;
    const llm: Llm = {
      async chat(req, chat) {
        const base = { content: 'ok', toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 }, provider: 'fake', model: 'fake', tier: 'strong' as const, downgraded: false, parsedToolCalls: [] as { name: string; args: Record<string, unknown> }[] };
        if (!chat.tools) return base;
        if (req.roleId !== 'head_of_growth') return { ...base, parsedToolCalls: [{ name: 'finish', args: { status: 'done', summary: 'x' } }] };
        calls++;
        const j = readJob(d.vault, id)!.data;
        if (j.side_effects_done.length >= 1) return { ...base, parsedToolCalls: [{ name: 'finish', args: { status: 'done', summary: 'sent' } }] };
        return { ...base, parsedToolCalls: [{ name: 'mock.outbound', args: { to: 'a@x', body: 'hi' } }] };
      },
    };
    const d = new Daemon(defaultConfig(dir, { CUBICLE_MOCK_TOOLS: '1' } as NodeJS.ProcessEnv, { port: 0, tickMs: 400, maxConcurrentJobs: 2, providersPath: path.join(root, 'config/providers.yaml'), toolsPath: cfgPath }), { llm, disableWs: true, disableSleepWatch: true, memory: false, log: () => undefined });
    await d.start();
    await waitFor(() => readJob(d.vault, id)!.data.status === 'blocked' && readJob(d.vault, id)!.data.approval === 'pending', 15000);
    const prop = findInboxById(d.vault, readJob(d.vault, id)!.data.blocked_on!.id)!;
    expect(listInbox(d.vault).filter((n) => n.data.kind === 'outbound_batch').length).toBe(1);
    writeFileSync(path.join(dir, prop.path), readFileSync(path.join(dir, prop.path), 'utf8').replace('approved: null', 'approved: true')); // owner in Obsidian
    await waitFor(() => readJob(d.vault, id)!.data.status === 'done', 20000);
    const j = readJob(d.vault, id)!.data;
    expect(j.side_effects_done).toEqual([`${id}:1:1`]);
    expect(j.approval).toBe('approved');
    expect(listInbox(d.vault).filter((n) => n.data.kind === 'outbound_batch').length).toBe(1); // no re-ask
    const keys = readFileSync(path.join(dir, '.cubicle/mock-outbound.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).key);
    expect(keys).toEqual([`${id}:1:1`]);
    await d.stop();
  });

  it('owner cancels a running job → worker stops within one step (acceptance test 2)', async () => {
    const vault = Vault.open(dir);
    const id = createJob(vault, { type: 'research', title: 'r', assigned: 'head_of_growth', goal: 'g' }, 'owner');
    vault.close();
    let cancelled = false;
    let d!: Daemon;
    const slow: Llm = {
      async chat(req, chat) {
        const base = { content: '', toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 }, provider: 'fake', model: 'fake', tier: 'strong' as const, downgraded: false, parsedToolCalls: [] as { name: string; args: Record<string, unknown> }[] };
        if (!chat.tools) return { ...base, content: 'ok' };
        if (req.roleId !== 'head_of_growth') return { ...base, parsedToolCalls: [{ name: 'finish', args: { status: 'done', summary: 'x' } }] };
        if (!cancelled) { cancelled = true; updateJob(d.vault, id, { status: 'cancelled' }, 'owner'); }
        return { ...base, parsedToolCalls: [{ name: 'vault.read', args: { path: 'Plans/plan.md' } }] };
      },
    };
    d = daemonFor(slow);
    await d.start();
    await waitFor(() => d.vault.events.count('job.cancelled') >= 1, 15000);
    expect(readJob(d.vault, id)!.data.checkpoint_step).toBeLessThanOrEqual(1);
    expect(readJob(d.vault, id)!.data.status).toBe('cancelled');
    await d.stop();
  });

  it('WS serves a snapshot, broadcasts events, replays, and cabin chat writes a message note', async () => {
    const d = daemonFor(fakeLlm(), 0);
    d.config.port = 47411;
    await d.start();
    const info = JSON.parse(readFileSync(path.join(dir, '.cubicle/daemon.json'), 'utf8')) as { token: string };
    const bad = new WebSocket('ws://127.0.0.1:47411', { headers: { origin: 'http://evil.example' } });
    const badClosed = await new Promise<boolean>((r) => { bad.once('error', () => r(true)); bad.once('open', () => r(false)); });
    expect(badClosed).toBe(true);
    const noToken = new WebSocket('ws://127.0.0.1:47411');
    expect(await new Promise<boolean>((r) => { noToken.once('error', () => r(true)); noToken.once('open', () => r(false)); })).toBe(true);
    const ws = new WebSocket(`ws://127.0.0.1:47411?token=${info.token}`);
    const msgs: Record<string, unknown>[] = [];
    ws.on('message', (m) => msgs.push(JSON.parse(String(m))));
    await new Promise((r) => ws.once('open', r));
    await waitFor(() => msgs.some((m) => m.op === 'snapshot'));
    const snap = msgs.find((m) => m.op === 'snapshot') as ReturnType<typeof buildSnapshot>;
    expect(snap.roles.map((r) => r.role)).toEqual(expect.arrayContaining(['ceo', 'cto', 'engineer', 'head_of_growth', 'coo']));
    ws.send(JSON.stringify({ op: 'chat', text: 'Bookkeeping for tiny shops' }));
    await waitFor(() => msgs.some((m) => m.op === 'chat.ack'));
    expect(listInbox(d.vault).some((n) => n.data.kind === 'message' && n.data.from === 'owner')).toBe(true);
    await waitFor(() => msgs.some((m) => m.op === 'event' && m.type === 'heartbeat.completed'), 20000);
    ws.send(JSON.stringify({ op: 'replay', from: '2000-01-01T00:00:00.000Z' }));
    await waitFor(() => msgs.some((m) => m.op === 'replay'));
    const rep = msgs.find((m) => m.op === 'replay') as { events: unknown[] };
    expect(rep.events.length).toBeGreaterThan(5);
    ws.close();
    await d.stop();
  });

  it('an old vault is migrated to the default org on start and the brief mentions it', async () => {
    rmSync(path.join(dir, 'Teams'), { recursive: true, force: true });
    const d = daemonFor(fakeLlm());
    await d.start();
    try { expect(existsSync(path.join(dir, 'Teams/engineering.md'))).toBe(true); expect(d.vault.events.count('org.changed')).toBe(1); } finally { await d.stop(); }
  });
});
