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
    v2.close();
  });
});

describe('daemon lifecycle', () => {
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
    const fc = createProposal(vault, { kind: 'file_change', from: 'cto', target: 'Memory/owner_preferences.md', title: 'x', body: '## Proposed content\n\n```\n# Owner preferences\n\nchanged by proposal\n```\n' }, 'cto');
    const bc = createProposal(vault, { kind: 'brand_change', from: 'ceo', target: 'Brand/name.md', title: 'ideas', body: '1. Bright Ledger — bookkeeping for tiny shops.\n2. Porch Pantry — veg box.\n3. Quiet Desk — timer.' }, 'ceo');
    const q = createProposal(vault, { kind: 'message', from: 'engineer', to: 'owner', title: 'q', body: 'Which colour?', job: 'job_x' }, 'engineer');
    expect(await dispatchProposals(deps)).toBe(0);
    // The owner edits in Obsidian = a raw file write the vault API never saw (sha differs from written_sha).
    const ownerEdit = (rel: string, f: (t: string) => string) => writeFileSync(path.join(dir, rel), f(readFileSync(path.join(dir, rel), 'utf8')));
    ownerEdit(fc.path, (t) => t.replace('approved: null', 'approved: true'));
    ownerEdit(bc.path, (t) => t.replace('approved: null', 'approved: true').replace('chosen: null', 'chosen: 2'));
    ownerEdit(q.path, (t) => t.replace('answered: null', 'answered: true') + '\n## Owner\n\nBlue.\n');
    expect(await dispatchProposals(deps)).toBe(3);
    expect(vault.readText('Memory/owner_preferences.md')).toContain('changed by proposal');
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

  it('owner cancels a running job → worker stops within one step (acceptance test 2)', async () => {
    const vault = Vault.open(dir);
    const id = createJob(vault, { type: 'research', title: 'r', assigned: 'growth', goal: 'g' }, 'owner');
    vault.close();
    let cancelled = false;
    let d!: Daemon;
    const slow: Llm = {
      async chat(req, chat) {
        const base = { content: '', toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 }, provider: 'fake', model: 'fake', tier: 'strong' as const, downgraded: false, parsedToolCalls: [] as { name: string; args: Record<string, unknown> }[] };
        if (!chat.tools) return { ...base, content: 'ok' };
        if (req.roleId !== 'growth') return { ...base, parsedToolCalls: [{ name: 'finish', args: { status: 'done', summary: 'x' } }] };
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
    const ws = new WebSocket('ws://127.0.0.1:47411');
    const msgs: Record<string, unknown>[] = [];
    ws.on('message', (m) => msgs.push(JSON.parse(String(m))));
    await new Promise((r) => ws.once('open', r));
    await waitFor(() => msgs.some((m) => m.op === 'snapshot'));
    const snap = msgs.find((m) => m.op === 'snapshot') as ReturnType<typeof buildSnapshot>;
    expect(snap.roles.map((r) => r.role)).toEqual(expect.arrayContaining(['ceo', 'cto', 'engineer', 'growth', 'coo']));
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
});
