import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { scaffoldVault, Vault, createJob, readJob, listJobs, listInbox, findInboxById, createProposal, updateJob, loadOrg, createStream, writeCiRecord } from '@cubicle/core';
import type { RoutedChatResult, RouteRequest, ChatMessage, ToolSchema } from '@cubicle/router';
import type { Llm } from '@cubicle/harness';
import { Daemon, defaultConfig, runHeartbeat, createHeartbeatJob, dispatchProposals, executeStoredCall, requeueUnblocked, buildSnapshot, NON_WORK_TYPES, HEARTBEAT_STEPS } from '../src/index.js';
import { parseToolsConfig, ToolRegistry, phase3Tools } from '@cubicle/tools';
import { vaultScheduler } from '@cubicle/harness';
import { letTheBoardDecide } from './helpers/board-switch.js';
import { TEST_MS, eventProgress, loadScale, oneMinuteLoad, waitForProgress } from './helpers/load.js';

const root = path.resolve(__dirname, '../../..');
let dir: string;
/** "Has anything happened": the event log's JSONL mirror, which every emitted event appends to. See helpers/load.ts. */
const progress = eventProgress(() => dir);
beforeEach(async () => {
  disposed = false;
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-daemon-'));
  const { vault } = await scaffoldVault(dir);
  // Nobody is at the keyboard in these tests and `board_decides_after_hours` ships off, so a plan would wait for
  // the owner for ever and no division would ever plan. Hand the board the ruling after a fraction of an hour.
  letTheBoardDecide(vault);
  // An engineer.ship cannot finish without a green CI record for its stream (§17), so the scripted dev plan
  // below ships against this one. No source files exist under Workspace/site, so the record never goes stale.
  createStream(vault, { slug: 'site', name: 'Site', problem: 'The company has no site.', customers: 'Everyone who hears about us', outcome_metric: 'a first cut exists', owner_team: 'dev' }, 'ceo');
  writeCiRecord(vault, 'site', { stream: 'site', started: '2026-09-11T09:59:00.000Z', finished: '2026-09-11T10:00:00.000Z', green: true, commit: null, steps: [{ name: 'test', code: 0, ok: true, duration_ms: 5, output: 'ok' }] }, 'backend_engineer');
  vault.close();
});
/**
 * Every daemon this file started, stopped before the vault it writes to is removed — the same ordered,
 * unconditional teardown `planning.test.ts` and `heartbeat-brief.test.ts` already have.
 *
 * A test body vitest has given up on never reaches its own `finally`, so a daemon could outlive `rmSync`: its
 * tick, its watcher's debounce and its workers keep writing into a directory that is gone, which raises ENOENT
 * storms out of `EventLog.emit` attributed to whichever case runs next and starves that one of CPU until it times
 * out too. That is one slow case taking the rest of the file down with it, and it is what this file did — a full
 * run here failed B1 on its 15 s budget with 131 unhandled ENOENT rejections behind it. `d.stop()` clears the
 * tick, awaits `VaultWatcher.stop()` and closes the pool, so after it nothing is left holding the directory.
 */
const daemons: Daemon[] = [];
/**
 * Set the moment teardown begins, so a poll loop belonging to a case that has already been given up on stops
 * touching a vault that is being removed rather than raising under the next case's name.
 */
let disposed = false;
afterEach(async () => {
  disposed = true;
  for (const d of daemons.splice(0)) await d.stop().catch(() => undefined);
  // One turn of the loop, so a callback already queued behind those stops runs before the directory goes.
  await new Promise((r) => setImmediate(r));
  rmSync(dir, { recursive: true, force: true });
});

/** Every `new Daemon` in this file goes through here, so the teardown above can stop what the case started. */
function track<T extends Daemon>(d: T): T {
  daemons.push(d);
  return d;
}

/** The CEO's objectives for the cycle: only the Dev room has work, so only the CTO's division gets a division.plan. */
const PLAN = '---\ncycle: 1\n---\n# Plan\n\n## Objectives\n\n### dev\n- Scaffold the site from Brand/\n';

/**
 * Role-aware scripted LLM for the two-level planning cycle: the CEO writes the company plan, the board always
 * passes (its advisors answer with canned prose and the chair's merge names no VERDICT line, which reads as a
 * pass), the CTO's division.plan enqueues the scaffold job, everyone else finishes immediately.
 */
function fakeLlm(opts: { ctoSteps?: number } = {}): Llm & { calls: { role?: string; tools: boolean }[] } {
  const perJob = new Map<string, number>();
  // The scaffold objective is only real work once; a second cycle (e.g. auto-triggered by jobsCompletedN once the
  // planning jobs push the count over the threshold) sees nothing left to do and writes an empty plan, so the
  // company.plan → board_premortem → division_plans → engineer.ship → team:qa.review → office:operations.verify chain does not run forever.
  let companyPlanCycles = 0;
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
      const jobType = jobMsg.match(/type: (\S+)/)?.[1] ?? '';
      if (jobType === 'company.plan') {
        if (n === 0) companyPlanCycles++;
        const content = companyPlanCycles <= 1 ? PLAN : `---\ncycle: ${companyPlanCycles}\n---\n# Plan\n\n## Objectives\n`;
        return { ...base, parsedToolCalls: [n === 0 ? { name: 'vault.write', args: { path: 'Plans/plan.md', content } } : { name: 'finish', args: { status: 'done', summary: 'objectives written' } }] };
      }
      if (jobType === 'division.plan' && req.roleId === 'cto') {
        return { ...base, parsedToolCalls: [n === 0 ? { name: 'scheduler.request', args: { type: 'engineer.ship', title: 'Scaffold Site/', assigned: 'backend_engineer', goal: 'Create Site/index.html from Brand/.', done_when: 'Site/index.html exists and matches Brand/.', risk: 'low', stream: 'site' } } : { name: 'finish', args: { status: 'done', summary: 'planned' } }] };
      }
      // Gate jobs (team:qa.review, office:operations.verify, requester.review) need an explicit verdict to advance the parent's gate chain.
      const isGate = /\.(review|verify)$/.test(jobType);
      return { ...base, parsedToolCalls: [{ name: 'finish', args: { status: 'done', summary: `${req.roleId} done`, ...(isGate ? { verdict: 'pass' } : {}) } }] };
    },
    promptBudget: () => 6000,
  };
  return llm;
}

function daemonFor(llm: Llm, port = 0) {
  return track(new Daemon(defaultConfig(dir, { CUBICLE_MOCK_TOOLS: '1' } as NodeJS.ProcessEnv, { port, tickMs: 500, maxConcurrentJobs: 2, providersPath: path.join(root, 'config/providers.yaml'), toolsPath: path.join(root, 'config/tools.yaml') }), { llm, disableSleepWatch: true, memory: false, log: () => undefined }));
}

/**
 * Poll a condition on real timers, failing only when the daemon has written **nothing** for the stall budget
 * (`helpers/load.ts`). The wall-clock ceilings these call sites used to carry were the flake, and the load that
 * scaled them was read at import — which under `pnpm -r test` is the one moment that still looks idle. A wait
 * that watches the event log instead is load-independent by construction: a box four times slower takes four
 * times longer while events keep arriving, and a daemon that has genuinely stopped fails here, inside the body,
 * where the `finally` that stops it still runs.
 */
async function waitFor(pred: () => boolean, what = 'a condition'): Promise<void> {
  await waitForProgress(pred, { progress, torn: () => disposed, what });
}

/**
 * Wait until `pred` has held continuously for `stableMs`. "The queue is empty" is momentarily true in the gap
 * between a job finishing and its gate job being enqueued, so a plain waitFor on it can return mid-chain and the
 * assertion after it then races the next gate.
 *
 * `stableMs` does not move with the machine: how long a state has to hold before it counts as settled is a
 * property of the thing being watched, not of how busy the box is. The outer deadline is the flapping guard —
 * a predicate that keeps going true and false again while the daemon works would otherwise never settle — and
 * it reads the load *now*, not at import.
 */
async function waitForStable(pred: () => boolean, stableMs = 1500, what = 'a settled queue'): Promise<void> {
  const deadline = Date.now() + 60_000 * loadScale();
  for (;;) {
    await waitFor(pred, what);
    const held = Date.now();
    while (Date.now() - held < stableMs) {
      await new Promise((r) => setTimeout(r, 100));
      if (!pred()) break;
    }
    if (pred() && Date.now() - held >= stableMs) return;
    if (Date.now() > deadline) throw new Error(`waitForStable: ${what} never held for ${stableMs} ms (1-min load ${oneMinuteLoad().toFixed(2)})`);
  }
}

describe('heartbeat as a resumable job', () => {
  it('runs all steps, awaits company.plan/division.plan, writes Runs/, queue.md, commits, answers the owner, proposes a name', async () => {
    const vault = Vault.open(dir);
    const llm = fakeLlm();
    createProposal(vault, { kind: 'message', from: 'owner', to: 'ceo', title: 'idea', body: 'Bookkeeping for tiny shops' }, 'owner');
    const hb = createHeartbeatJob(vault, 'test');
    // The owner never answers the plan_verdict this cycle files. `board_decides_after_hours` is a fraction of an
    // hour here (beforeEach), so moving the clock on is how this test says "the owner stayed away long enough":
    // the board's pass then stands and the same heartbeat fans the plan out.
    let clock = new Date();
    const deps = { vault, llm, now: () => clock };
    const first = await runHeartbeat(deps, hb);
    expect(first.status).toBe('blocked');
    // Since the whole-branch review's C1, one short line is read as well as asked about (spec §1.3, §5.5): the
    // cycle queues discovery over it and blocks there, before anything is planned against it. Nobody runs the
    // job here, so it is closed by hand and the cycle walks on to the plan it was always about.
    expect(readJob(vault, hb)!.data.checkpoint_step).toBe(HEARTBEAT_STEPS.indexOf('discovery'));
    const disc = listJobs(vault).find((j) => j.type === 'discovery')!;
    expect(first).toEqual({ status: 'blocked', on: { kind: 'job', id: disc.id } });
    updateJob(vault, disc.id, { status: 'done' }, 'daemon');
    expect((await runHeartbeat(deps, hb)).status).toBe('blocked');
    expect(readJob(vault, hb)!.data.checkpoint_step).toBe(HEARTBEAT_STEPS.indexOf('company_plan'));
    const plan = listJobs(vault).find((j) => j.type === 'company.plan')!;
    expect(plan).toBeTruthy();
    // owner message answered + name proposed during step 3
    // `from === 'owner'`: since SP3 the same step also sends the CEO's founder-interview message, which is a
    // `message` too, so the kind alone no longer picks out the note this test is about.
    const msgs = listInbox(vault).filter((n) => n.data.kind === 'message' && n.data.from === 'owner');
    expect(msgs[0].data.answered).toBe(true);
    expect(msgs[0].body).toContain('## CEO');
    expect(listInbox(vault).some((n) => n.data.kind === 'brand_change' && n.data.target === 'Brand/name.md' && n.body.includes('Bright Ledger'))).toBe(true);
    // second visit while company.plan still running → still blocked
    expect((await runHeartbeat(deps, hb)).status).toBe('blocked');
    // finish company.plan via the harness → heartbeat resumes into the board room
    const { runJob } = await import('@cubicle/harness');
    const cfg = parseToolsConfig(readFileSync(path.join(root, 'config/tools.yaml'), 'utf8'));
    const harnessDeps = { vault, llm, toolsConfig: cfg, registry: new ToolRegistry().registerAll(phase3Tools()), scheduler: vaultScheduler(vault), env: {} };
    const planOut = await runJob(harnessDeps, plan.id);
    expect(planOut.status).toBe('done');
    expect(vault.readText('Plans/plan.md')).toContain('Scaffold the site from Brand/');
    expect(requeueUnblocked(vault)).toBe(1);
    // The board room is four model calls inside this step, not a sub-job, so the heartbeat passes straight
    // through board_premortem, rules on the plan, and blocks on the CTO's division.plan instead.
    clock = new Date(clock.getTime() + 3600_000);
    expect((await runHeartbeat(deps, hb)).status).toBe('blocked');
    const boardJob = listJobs(vault).find((j) => j.type === 'board.premortem')!;
    expect(boardJob.status).toBe('done');
    expect(readJob(vault, boardJob.id)!.body).toContain('### The Skeptic');
    expect(existsSync(path.join(dir, 'Decisions'))).toBe(true);
    // finish the CTO's division.plan → it enqueues the scaffold job
    const divisionPlan = listJobs(vault).find((j) => j.type === 'division.plan')!;
    expect(divisionPlan.assigned).toBe('cto');
    expect((await runJob(harnessDeps, divisionPlan.id)).status).toBe('done');
    expect(listJobs(vault).some((j) => j.type === 'engineer.ship')).toBe(true);
    expect(requeueUnblocked(vault)).toBe(1);
    const done = await runHeartbeat(deps, hb);
    expect(done.status).toBe('done');
    const runs = vault.list('Runs', { ext: '.md' });
    expect(runs.length).toBe(1);
    expect(vault.readText(runs[0])).toContain('## What needs you');
    expect(vault.readText(runs[0])).toContain('## Next action per team');
    expect(vault.readText('Jobs/queue.md')).toContain(hb);
    expect(vault.events.count('heartbeat.completed')).toBe(1);
    expect(vault.events.count('job.done')).toBeGreaterThanOrEqual(2);
    expect(vault.events.count('team.planned')).toBe(1);
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
    await runHeartbeat({ vault, llm }, hb); // blocked on company.plan
    rmSync(path.join(dir, '.cubicle/jobs'), { recursive: true, force: true }); // cache wiped: state must come from the vault
    vault.close();
    // "restart": a daemon comes up, marks nothing (heartbeat is blocked, not running), runs the plan job and resumes
    const d = daemonFor(llm);
    await d.start();
    await waitFor(() => d.vault.events.count('heartbeat.completed') >= 1, 'the first heartbeat');
    await d.stop();
    const v2 = Vault.open(dir);
    expect(v2.list('Runs', { ext: '.md' }).length).toBe(1);
    const log = (await import('node:child_process')).execSync('git log --oneline', { cwd: dir }).toString();
    expect(log.split('\n').filter((l) => l.includes('cubicle: heartbeat')).length).toBe(1);
    expect(listJobs(v2).filter((j) => j.type === 'ceo.heartbeat').length).toBe(1);
    expect(listJobs(v2).filter((j) => j.type === 'company.plan').length).toBe(1);
    expect(v2.list('Plans/archive', { ext: '.md' }).length).toBeLessThanOrEqual(1);
    v2.close();
  }, TEST_MS);

  it('a board room with no model still passes the plan and says so in its own record (T9)', async () => {
    const vault = Vault.open(dir);
    const llm = fakeLlm();
    const deps = { vault, llm };
    const hb = createHeartbeatJob(vault, 'test');
    await runHeartbeat(deps, hb); // blocked on company.plan
    const plan = listJobs(vault).find((j) => j.type === 'company.plan')!;
    const { runJob } = await import('@cubicle/harness');
    const cfg = parseToolsConfig(readFileSync(path.join(root, 'config/tools.yaml'), 'utf8'));
    const harnessDeps = { vault, llm, toolsConfig: cfg, registry: new ToolRegistry().registerAll(phase3Tools()), scheduler: vaultScheduler(vault), env: {} };
    await runJob(harnessDeps, plan.id);
    expect(requeueUnblocked(vault)).toBe(1);
    // Every model call fails from here on (no provider key, no Ollama): the board advises, so a board that
    // cannot speak must fail open to pass rather than stall the cycle — and the record must say it was silent.
    llm.chat = (async () => { throw new Error('no provider'); }) as typeof llm.chat;
    await runHeartbeat(deps, hb);
    const board = listJobs(vault).find((j) => j.type === 'board.premortem')!;
    expect(board.status).toBe('done');
    expect(readJob(vault, board.id)!.body).toContain('(no answer: no model was available)');
    expect(vault.readNoteOrNull(`Decisions/premortem-${hb}.md`)!.data.status).toBe('adopted');
    vault.close();
  });
});

/**
 * Acceptance test 4, second clause: "the system still completes a heartbeat with only Ollama".
 * `localFloor` stands in for a Router whose cloud providers are all keyless — the router half of this test
 * (`packages/router/test/router.test.ts`) proves that state leaves exactly one candidate, the local model — so
 * every request, whatever tier the caller asked for, comes back answered by the floor and marked downgraded.
 * (It answers rather than throws for the same reason the real router does: a downgrade is not a failure.)
 */
function localFloor(inner: Llm): Llm & { served: { asked: string; on: string }[] } {
  const wrapped = {
    served: [] as { asked: string; on: string }[],
    async chat(req: Parameters<Llm['chat']>[0], chat: Parameters<Llm['chat']>[1]) {
      const r = await inner.chat({ ...req, tier: 'local' }, chat);
      const out = { ...r, provider: 'ollama', model: 'qwen2.5:7b', tier: 'local' as const, downgraded: req.tier !== 'local' };
      wrapped.served.push({ asked: req.tier, on: out.tier });
      return out;
    },
    promptBudget: () => 6000,
  };
  return wrapped;
}

describe('only the local floor is up', () => {
  it('heartbeat completes on the local tier alone (acceptance test 4)', async () => {
    // A heartbeat needs something to plan for: nothing runs before the owner has typed an idea (spec §12, C1).
    const seed = Vault.open(dir);
    createProposal(seed, { kind: 'message', from: 'owner', to: 'ceo', title: 'idea', body: 'Bookkeeping for tiny shops' }, 'owner');
    seed.close();
    const llm = localFloor(fakeLlm());
    const d = daemonFor(llm);
    await d.start();
    try {
      await waitFor(() => d.vault.events.count('heartbeat.completed') >= 1, 'the first heartbeat');
    } finally { await d.stop(); }
    const vault = Vault.open(dir);
    try {
      // callers did ask for cloud tiers, and every one of them was answered by the floor
      expect(llm.served.length).toBeGreaterThan(0);
      expect(llm.served.some((c) => c.asked !== 'local')).toBe(true);
      expect(llm.served.every((c) => c.on === 'local')).toBe(true);
      // …and the heartbeat still produced its two durable outputs: the brief and the commit
      const runs = vault.list('Runs', { ext: '.md' });
      expect(runs.length).toBe(1);
      expect(vault.readText(runs[0])).toContain('## What happened');
      const done = vault.events.last('heartbeat.completed')!;
      expect(String(done.payload.run)).toBe(runs[0]);
      expect(done.payload.commit).toBeTruthy();
      const log = (await import('node:child_process')).execSync('git log --oneline', { cwd: dir }).toString();
      expect(log).toContain('cubicle: heartbeat');
    } finally { vault.close(); }
  }, TEST_MS);
});

describe('the pre-mortem note survives a crash mid-board-step (D7)', () => {
  it('is written before the board verdict is saved, so a resume can never skip it', async () => {
    const vault = Vault.open(dir);
    const llm = fakeLlm();
    const deps = { vault, llm };
    const hb = createHeartbeatJob(vault, 'test');
    const { runJob } = await import('@cubicle/harness');
    const cfg = parseToolsConfig(readFileSync(path.join(root, 'config/tools.yaml'), 'utf8'));
    const harnessDeps = { vault, llm, toolsConfig: cfg, registry: new ToolRegistry().registerAll(phase3Tools()), scheduler: vaultScheduler(vault), env: {} };

    await runHeartbeat(deps, hb); // blocked on company.plan
    await runJob(harnessDeps, listJobs(vault).find((j) => j.type === 'company.plan')!.id);
    requeueUnblocked(vault);

    // The state key that says "the board has already ruled this cycle" must not become durable before the note
    // it is supposed to have produced: a crash in that window resumes into the already-run branch and the
    // pre-mortem is lost for the cycle. Sample the on-disk state at the instant the note is written.
    const statePath = path.join(dir, '.cubicle', 'jobs', `${hb}.heartbeat.json`);
    let stateAtWrite: string | null = null;
    const off = vault.events.on('vault.wrote', (e) => {
      if (String(e.payload.path).startsWith('Decisions/premortem-') && stateAtWrite === null) stateAtWrite = readFileSync(statePath, 'utf8');
    });
    try { await runHeartbeat(deps, hb); } finally { off(); }

    expect(stateAtWrite).toBeTruthy();
    expect(JSON.parse(stateAtWrite!).boardVerdict).toBeUndefined();
    expect(vault.exists(`Decisions/premortem-${hb}.md`)).toBe(true);
    expect(JSON.parse(readFileSync(statePath, 'utf8')).boardVerdict).toBe('pass');
    vault.close();
  });

  it('writeBoardPremortemDecision overwrites the same note, so a resume rewrites rather than duplicates', async () => {
    const vault = Vault.open(dir);
    const { writeBoardPremortemDecision } = await import('../src/index.js');
    const now = new Date();
    const first = writeBoardPremortemDecision(vault, 'job_hb1', 'job_board1', 'return', ['no metric'], 'advisor_skeptic', now);
    const second = writeBoardPremortemDecision(vault, 'job_hb1', 'job_board2', 'pass', [], 'advisor_skeptic', now);
    expect(second).toBe(first);
    expect(vault.list('Decisions', { ext: '.md' }).filter((r) => r.includes('premortem'))).toHaveLength(1);
    const note = vault.readNoteOrNull(first)!;
    expect(note.data.status).toBe('adopted'); // the verdict the cycle actually ran with
    expect(note.data.decided_by).toBe('advisor_skeptic');
    expect(note.body).toContain('The plan survived the pre-mortem.');
    vault.close();
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
    expect(rec[0].assigned).toBe('backend_engineer');   // resolveRole maps the v1 `engineer` to a worker that carries the build tools
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
    createProposal(vault, { kind: 'spend', from: 'backend_engineer', title: 'Deploy the site', body: 'x' }, 'backend_engineer');
    createProposal(vault, { kind: 'message', from: 'cto', to: 'owner', title: 'Q', body: 'Which colour?' }, 'cto');
    const snap = buildSnapshot(vault);
    expect(snap.brand).toEqual({ name: 'PlateReady', tagline: 'Meal plans for busy parents', url: 'https://plateready.pages.dev' });
    expect(snap.inbox.map((n) => [n.kind, n.title])).toEqual([['spend', 'Deploy the site']]);
    expect(snap.inbox[0].path).toMatch(/^00 Inbox\//);
    expect(snap.pendingProposals).toBe(1);
    writeFileSync(path.join(dir, '00 Inbox/idea.md'), '---\nid: msg_idea\nkind: message\nfrom: owner\nto: ceo\ncreated: 2026-09-03T04:37:00.000Z\nanswered: true\n---\nA meal-planning site.\n\n## CEO\n\nGot it. I proposed **PlateReady**.\n');
    expect(buildSnapshot(vault).chat).toEqual([{ ts: '2026-09-03T04:37:00.000Z', from: 'you', text: 'A meal-planning site.' }, { ts: '2026-09-03T04:37:00.000Z', from: 'ceo', text: 'Got it. I proposed **PlateReady**.' }]);
    expect(snap.teams.map((t) => t.id).sort()).toEqual(['board', 'dev', 'executive', 'operations', 'qa', 'research', 'revenue', 'sales', 'security', 'technology']);
    vault.close();
  });
});

describe('daemon lifecycle', () => {
  it('start logs one line per cloud provider whose API key is unset and emits exactly one provider_key daemon.warning; with keys set it stays quiet', async () => {
    // The live run that motivated this: a blank .env left every call on ollama for three days, and Metrics/quota.md
    // showed Gemini "ok 0/250" — the router's availableProviders() filter had silently removed it.
    const mkDaemon = (env: NodeJS.ProcessEnv, lines: string[]) => track(new Daemon(defaultConfig(dir, env, { port: 0, tickMs: 500, maxConcurrentJobs: 1, providersPath: path.join(root, 'config/providers.yaml'), toolsPath: path.join(root, 'config/tools.yaml') }), { llm: fakeLlm(), disableWs: true, disableSleepWatch: true, memory: false, log: (m) => lines.push(m) }));
    const lines: string[] = [];
    const d = mkDaemon({ CUBICLE_MOCK_TOOLS: '1' }, lines);
    await d.start();
    try {
      const warnings = d.vault.events.query({ types: ['daemon.warning'] }).filter((e) => e.payload.where === 'provider_key');
      expect(warnings).toHaveLength(1);
      expect(warnings[0].payload.providers).toEqual([{ id: 'gemini', env: 'GEMINI_API_KEY' }, { id: 'groq', env: 'GROQ_API_KEY' }, { id: 'openrouter', env: 'OPENROUTER_API_KEY' }]);
      expect(lines).toContain('provider gemini: GEMINI_API_KEY not set — its models are unavailable; set it in .env or the environment');
      expect(lines.filter((l) => /^provider \w+: \w+ not set/.test(l))).toHaveLength(3);
    } finally { await d.stop(); }
    const quiet: string[] = [];
    const d2 = mkDaemon({ CUBICLE_MOCK_TOOLS: '1', GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q', OPENROUTER_API_KEY: 'o' }, quiet);
    await d2.start();
    try {
      expect(d2.vault.events.query({ types: ['daemon.warning'] }).filter((e) => e.payload.where === 'provider_key')).toHaveLength(1); // still the one from the first start
      expect(quiet.some((l) => /not set/.test(l))).toBe(false);
    } finally { await d2.stop(); }
  }, TEST_MS);

  it('an owner note typed while the daemon was down (only kind: message) triggers a heartbeat that answers it', async () => {
    const seed = Vault.open(dir);
    seed.events.emit({ type: 'heartbeat.completed', payload: { id: 'seed' } }); // recent → no startup heartbeat
    seed.close();
    writeFileSync(path.join(dir, '00 Inbox/idea.md'), '---\nkind: message\n---\nA one-page site selling a printable meal-planning template.\n');
    const d = daemonFor(fakeLlm());
    await d.start();
    const v = Vault.open(dir);
    try {
      await waitFor(() => listJobs(v).some((j) => j.type === 'ceo.heartbeat' && /unanswered owner message/.test(j.title)), 'the heartbeat job for the unanswered owner message');
      await waitFor(() => /answered: true/.test(readFileSync(path.join(dir, '00 Inbox/idea.md'), 'utf8')), 'the inbox note to be marked answered');
    } finally { await d.stop(); }
    const text = readFileSync(path.join(dir, '00 Inbox/idea.md'), 'utf8');
    expect(text).toMatch(/## CEO/);
    expect(text).toMatch(/^id: msg_/m);
    expect(text).toMatch(/^created: /m);
    expect(listInbox(v).some((n) => n.data.kind === 'brand_change')).toBe(true);
    expect(listJobs(v).filter((j) => j.type === 'ceo.heartbeat').length).toBe(1); // no re-trigger loop once answered
    v.close();
  }, TEST_MS);

  it('an empty vault runs no heartbeat and seeds nothing until the owner types an idea, then heartbeat #1 does both (C1)', async () => {
    const d = daemonFor(fakeLlm());
    await d.start();
    try {
      // Several ticks with a scaffolded but idealess vault: no company name, no owner note, nothing to plan for.
      await new Promise((r) => setTimeout(r, 2000));
      expect(listJobs(d.vault)).toEqual([]);
      expect(d.vault.events.count('heartbeat.started')).toBe(0);
      expect(d.vault.events.count('heartbeat.completed')).toBe(0);

      // The owner types the idea into the cabin chat.
      createProposal(d.vault, { kind: 'message', from: 'owner', to: 'ceo', title: 'idea', body: 'Bookkeeping for tiny shops' }, 'owner');
      await waitFor(() => d.vault.events.count('heartbeat.completed') >= 1, 'the first heartbeat');

      // Heartbeat #1 is the one that names the company and the one that seeds the three first jobs.
      expect(listJobs(d.vault).filter((j) => j.type === 'ceo.heartbeat')).toHaveLength(1);
      expect(listInbox(d.vault).some((n) => n.data.kind === 'brand_change')).toBe(true);
      const titles = listJobs(d.vault).map((j) => j.title);
      const { FIRST_JOB_TITLES } = await import('../src/index.js');
      for (const t of FIRST_JOB_TITLES) expect(titles).toContain(t);
    } finally { await d.stop(); }
  }, TEST_MS);

  it('first start runs heartbeat #1 from an owner idea with zero outbound events; verify chain terminates; the cycle seeds the offer and channel jobs (D8)', async () => {
    const vault = Vault.open(dir);
    createProposal(vault, { kind: 'message', from: 'owner', to: 'ceo', title: 'idea', body: 'Bookkeeping for tiny shops' }, 'owner');
    vault.close();
    const d = daemonFor(fakeLlm());
    await d.start();
    await waitFor(() => d.vault.events.count('heartbeat.completed') >= 1, 'the first heartbeat');
    // engineer.ship (scaffold) runs and finishes; its office:operations.verify runs; then nothing else is enqueued
    await waitFor(() => listJobs(d.vault).filter((j) => j.type === 'office:operations.verify' && j.status === 'done').length >= 1, 'an operations verify job to finish');
    await waitForStable(() => listJobs(d.vault).filter((j) => ['queued', 'running'].includes(j.status)).length === 0);
    const jobs = listJobs(d.vault);
    // No verify-of-verify chain: a gate job never itself sits under another gate job.
    const gateTypes = ['team:qa.review', 'office:operations.verify', 'requester.review'];
    const byId = new Map(jobs.map((j) => [j.id, j]));
    expect(jobs.filter((j) => gateTypes.includes(j.type)).every((j) => !gateTypes.includes(byId.get(j.parent ?? '')?.type ?? ''))).toBe(true);
    expect(jobs.filter((j) => ['queued', 'running'].includes(j.status)).length).toBe(0);
    expect(d.vault.events.count('email.sent')).toBe(0);
    expect(d.vault.events.count('deploy.done')).toBe(0);
    expect(listInbox(d.vault).some((n) => n.data.kind === 'brand_change')).toBe(true);
    expect(existsSync(path.join(dir, '.cubicle', 'daemon.json'))).toBe(true);

    // D8: whatever the plan said, heartbeat #1 leaves the company with a site, an offer and a channel to work on.
    const offer = jobs.find((j) => j.title === 'Define the offer and price point')!;
    expect(offer).toBeTruthy();
    expect(offer.type).toBe('research');
    expect(offer.for).toBe('cmo');
    expect(readJob(d.vault, offer.id)!.body).toContain('## Done when');
    const channel = jobs.find((j) => j.title === 'Research the first organic channel')!;
    expect(channel).toBeTruthy();
    expect(['growth.seo', 'research']).toContain(channel.type);
    expect(readJob(d.vault, channel.id)!.body).toContain('## Done when');
    // The CTO's team plan queued a two-word "Scaffold Site/", which is not enough to claim the seed's work, so
    // the seed is created too and its Done when spells out what "scaffolded" has to mean.
    const site = jobs.find((j) => j.title === 'Scaffold Site/ from Brand/ (first cut)')!;
    expect(site).toBeTruthy();
    expect(site.type).toBe('engineer.ship');
    expect(readJob(d.vault, site.id)!.body).toContain('## Done when');

    const t0 = Date.now();
    await d.stop();
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(existsSync(path.join(dir, '.cubicle', 'daemon.json'))).toBe(false);
  }, TEST_MS);

  it('a fresh vault whose plan queued nothing still gets all three first jobs, and a second heartbeat seeds nothing (D8)', async () => {
    const vault = Vault.open(dir);
    vault.close();
    const { seedFirstJobs } = await import('../src/index.js');
    const v = Vault.open(dir);
    try {
      createProposal(v, { kind: 'message', from: 'owner', to: 'ceo', title: 'idea', body: 'Bookkeeping for tiny shops' }, 'owner');
      const first = seedFirstJobs(v, loadOrg(v));
      expect(first).toHaveLength(3);
      const titles = listJobs(v).map((j) => j.title);
      expect(titles).toContain('Scaffold Site/ from Brand/ (first cut)');
      expect(titles).toContain('Define the offer and price point');
      expect(titles).toContain('Research the first organic channel');
      const site = listJobs(v).find((j) => j.title === 'Scaffold Site/ from Brand/ (first cut)')!;
      expect(site.type).toBe('engineer.ship');
      expect(site.assigned).toBe('backend_engineer');
      for (const id of first) expect(readJob(v, id)!.body).toContain('## Done when');
      // Idempotent within the first cycle, and silent once a heartbeat has completed.
      expect(seedFirstJobs(v, loadOrg(v))).toEqual([]);
      v.events.emit({ type: 'heartbeat.completed', payload: { id: 'h1' } });
      expect(seedFirstJobs(v, loadOrg(v))).toEqual([]);
    } finally { v.close(); }
  });

  it('a seed is skipped only by a live job whose own first three words match it (D8)', async () => {
    const { seedFirstJobs, FIRST_JOB_TITLES } = await import('../src/index.js');
    const v = Vault.open(dir);
    try {
      createProposal(v, { kind: 'message', from: 'owner', to: 'ceo', title: 'idea', body: 'Bookkeeping for tiny shops' }, 'owner');
      // Same first three words, different wording → the lead already planned it.
      createJob(v, { type: 'engineer.ship', title: 'Scaffold Site/ from Brand/ (v2)', assigned: 'backend_engineer', goal: 'g' }, 'cto');
      // Shorter than three words → not enough to claim the work; must not suppress anything.
      createJob(v, { type: 'research', title: 'Research', assigned: 'research_manager', goal: 'g' }, 'cto');
      createJob(v, { type: 'research', title: 'Define the', assigned: 'research_manager', goal: 'g' }, 'cto');
      // A job nobody will ever run cannot stand in for a seed.
      const dead = createJob(v, { type: 'growth.seo', title: 'Research the first organic channel', assigned: 'cmo', goal: 'g' }, 'cto');
      updateJob(v, dead, { status: 'cancelled' }, 'daemon');

      const seeded = seedFirstJobs(v, loadOrg(v)).map((id) => readJob(v, id)!.data.title);
      expect(seeded).toEqual([FIRST_JOB_TITLES[1], FIRST_JOB_TITLES[2]]);
      expect(seeded).not.toContain(FIRST_JOB_TITLES[0]); // covered by the lead's "Scaffold Site/ from Brand/ (v2)"
    } finally { v.close(); }
  });

  it('a failed job does not stand in for a seed either (D8)', async () => {
    const { seedFirstJobs, FIRST_JOB_TITLES } = await import('../src/index.js');
    const v = Vault.open(dir);
    try {
      createProposal(v, { kind: 'message', from: 'owner', to: 'ceo', title: 'idea', body: 'Bookkeeping for tiny shops' }, 'owner');
      const dead = createJob(v, { type: 'engineer.ship', title: 'Scaffold Site/ from Brand/ (first cut)', assigned: 'backend_engineer', goal: 'g' }, 'cto');
      updateJob(v, dead, { status: 'failed' }, 'daemon');
      expect(seedFirstJobs(v, loadOrg(v)).map((id) => readJob(v, id)!.data.title)).toContain(FIRST_JOB_TITLES[0]);
    } finally { v.close(); }
  });

  it('planning and gate sub-jobs (company.plan, board.premortem, division.plan, team:qa.review, office:operations.verify) never retrigger a second heartbeat on their own (Task 11)', async () => {
    const vault = Vault.open(dir);
    createProposal(vault, { kind: 'message', from: 'owner', to: 'ceo', title: 'idea', body: 'Bookkeeping for tiny shops' }, 'owner');
    vault.close();
    const d = daemonFor(fakeLlm());
    await d.start();
    await waitFor(() => d.vault.events.count('heartbeat.completed') >= 1, 'the first heartbeat');
    // the first heartbeat's own cycle produces company.plan, board.premortem, the seeded first jobs, team:qa.review, office:operations.verify —
    // five of those six are planning/gate jobs; if they counted toward jobsCompletedN (5) a second heartbeat would fire.
    await waitFor(() => listJobs(d.vault).filter((j) => j.type === 'office:operations.verify' && j.status === 'done').length >= 1, 'an operations verify job to finish');
    await new Promise((r) => setTimeout(r, 1500)); // let the tick settle
    const heartbeats = listJobs(d.vault).filter((j) => j.type === 'ceo.heartbeat');
    expect(heartbeats).toHaveLength(1);
    expect(heartbeats[0].title).toMatch(/first start/);
    expect(d.config.heartbeat.jobsCompletedN).toBe(5); // default, unchanged
    await d.stop();
  }, TEST_MS);
  it('research.review is a gate job, not work: it belongs in NON_WORK_TYPES alongside the other review/verify gates', () => {
    expect(NON_WORK_TYPES).toContain('research.review');
    expect(NON_WORK_TYPES).toEqual(expect.arrayContaining(['team:qa.review', 'office:operations.verify', 'requester.review', 'research.review']));
  });

  it('the daemon\'s own recurring sweeps never move the heartbeat trigger: four completed intelligence jobs count as zero work', () => {
    expect(NON_WORK_TYPES).toEqual(expect.arrayContaining(['intelligence', 'research.measure']));
    // The counter in daemon.ts is `events of type job.done/job.failed whose job type is not in NON_WORK_TYPES`.
    // Replay that filter over one cycle's four sweeps plus a follow-up measurement and one real job.
    const types = ['intelligence', 'intelligence', 'intelligence', 'intelligence', 'research.measure', 'engineer.ship'];
    expect(types.filter((t) => !NON_WORK_TYPES.includes(t))).toEqual(['engineer.ship']);
  });

  it('dispatcher: file_change applies the diff; brand_change with chosen sets the name and queues reconcile; message answers route to Messages/', async () => {
    const vault = Vault.open(dir);
    const cfg = parseToolsConfig(readFileSync(path.join(root, 'config/tools.yaml'), 'utf8'));
    const deps = { vault, registry: new ToolRegistry().registerAll(phase3Tools()), toolsConfig: cfg, scheduler: vaultScheduler(vault), env: {} };
    const fc = createProposal(vault, { kind: 'file_change', from: 'cto', target: 'Memory/owner_preferences.md', title: 'x', body: '## Proposed content\n\n```\n# Owner preferences\n\nchanged by proposal\n```\n', call: { tool: 'vault.write', args: { path: 'Memory/owner_preferences.md', content: '# Owner preferences\n\nchanged by proposal\n' }, idempotency_key: 'job_x:1:1', role: 'cto' } }, 'cto');
    // an agent-authored brand_change pointing at the constitution must never be applied, even when approved
    const evil = createProposal(vault, { kind: 'brand_change', from: 'cmo', target: 'Memory/constitution.md', title: 'Tagline tweak', body: '## Proposed content\n\n```\nmax_emails_per_day: 99999\n```\n' }, 'cmo');
    const bc = createProposal(vault, { kind: 'brand_change', from: 'ceo', target: 'Brand/name.md', title: 'ideas', body: '1. Bright Ledger — bookkeeping for tiny shops.\n2. Porch Pantry — veg box.\n3. Quiet Desk — timer.' }, 'ceo');
    const q = createProposal(vault, { kind: 'message', from: 'backend_engineer', to: 'owner', title: 'q', body: 'Which colour?', job: 'job_x' }, 'backend_engineer');
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
    expect(vault.readText('Messages/backend_engineer.md')).toContain(`re:${q.id} Blue.`);
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
    const job = createJob(vault, { type: 'engineer.ship', title: 'ship', assigned: 'backend_engineer', goal: 'x' }, 'cto');
    const p = createProposal(vault, { kind: 'spend', from: 'backend_engineer', job, title: 'deploy', body: 'x', call: { tool: 'deploy.site', args: {}, idempotency_key: `${job}:1:3`, job, role: 'backend_engineer' } }, 'backend_engineer');
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
    vault.updateNote('Roles/cmo.md', (n) => ({ data: { ...n.data, tools: [...(n.data.tools as string[]), 'mock.outbound'] }, body: n.body }), 'owner');
    vault.events.emit({ type: 'heartbeat.completed', payload: { id: 'seed' } });
    const id = createJob(vault, { type: 'growth.outreach', title: 'ask', assigned: 'cmo', goal: 'g' }, 'cto');
    vault.close();
    const askCfg = readFileSync(path.join(root, 'config/tools.yaml'), 'utf8').replace('mock.outbound:         { mode: auto', 'mock.outbound:         { mode: ask');
    const cfgPath = path.join(dir, '.cubicle', 'tools-ask.yaml');
    writeFileSync(cfgPath, askCfg);
    let calls = 0;
    const llm: Llm = {
      async chat(req, chat) {
        const base = { content: 'ok', toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 }, provider: 'fake', model: 'fake', tier: 'strong' as const, downgraded: false, parsedToolCalls: [] as { name: string; args: Record<string, unknown> }[] };
        if (!chat.tools) return base;
        if (req.roleId !== 'cmo') return { ...base, parsedToolCalls: [{ name: 'finish', args: { status: 'done', summary: 'x' } }] };
        calls++;
        const j = readJob(d.vault, id)!.data;
        if (j.side_effects_done.length >= 1) return { ...base, parsedToolCalls: [{ name: 'finish', args: { status: 'done', summary: 'sent' } }] };
        return { ...base, parsedToolCalls: [{ name: 'mock.outbound', args: { to: 'a@x', body: 'hi' } }] };
      },
    };
    const d = track(new Daemon(defaultConfig(dir, { CUBICLE_MOCK_TOOLS: '1' } as NodeJS.ProcessEnv, { port: 0, tickMs: 400, maxConcurrentJobs: 2, providersPath: path.join(root, 'config/providers.yaml'), toolsPath: cfgPath }), { llm, disableWs: true, disableSleepWatch: true, memory: false, log: () => undefined }));
    await d.start();
    // A whole job through the harness — the worker picks it up, calls a model, the ask-mode tool refuses, the
    // proposal is written and the job blocks. Every comparable wait in this file is 20-40 s; this one was 15 s,
    // and it is the case that went red, timing out at 15.4 s. The budget was under-set, not the code slow.
    await waitFor(() => readJob(d.vault, id)!.data.status === 'blocked' && readJob(d.vault, id)!.data.approval === 'pending', 'the ask-mode call to file its proposal and block the job');
    const prop = findInboxById(d.vault, readJob(d.vault, id)!.data.blocked_on!.id)!;
    expect(listInbox(d.vault).filter((n) => n.data.kind === 'outbound_batch').length).toBe(1);
    writeFileSync(path.join(dir, prop.path), readFileSync(path.join(dir, prop.path), 'utf8').replace('approved: null', 'approved: true')); // owner in Obsidian
    // The other half of the same trip: the dispatcher sees the approval, requeues, and the worker runs it out.
    await waitFor(() => readJob(d.vault, id)!.data.status === 'done', 'the approved job to finish');
    const j = readJob(d.vault, id)!.data;
    expect(j.side_effects_done).toEqual([`${id}:1:1`]);
    expect(j.approval).toBe('approved');
    expect(listInbox(d.vault).filter((n) => n.data.kind === 'outbound_batch').length).toBe(1); // no re-ask
    const keys = readFileSync(path.join(dir, '.cubicle/mock-outbound.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).key);
    expect(keys).toEqual([`${id}:1:1`]);
    await d.stop();
  }, TEST_MS);

  it('owner cancels a running job → worker stops within one step (acceptance test 2)', async () => {
    const vault = Vault.open(dir);
    const id = createJob(vault, { type: 'research', title: 'r', assigned: 'cmo', goal: 'g' }, 'owner');
    vault.close();
    // The owner cancels the way Obsidian does: by editing `status:` in the job note on disk, from outside the
    // daemon, while the worker is mid-step. Nothing in the test touches the daemon's own job API.
    let announceMidStep!: () => void;
    const midStep = new Promise<void>((r) => { announceMidStep = r; });
    let releaseStep!: () => void;
    const edited = new Promise<void>((r) => { releaseStep = r; });
    let paused = false;
    const slow: Llm = {
      async chat(req, chat) {
        const base = { content: '', toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 }, provider: 'fake', model: 'fake', tier: 'strong' as const, downgraded: false, parsedToolCalls: [] as { name: string; args: Record<string, unknown> }[] };
        if (!chat.tools) return { ...base, content: 'ok' };
        if (req.roleId !== 'cmo') return { ...base, parsedToolCalls: [{ name: 'finish', args: { status: 'done', summary: 'x' } }] };
        if (!paused) { paused = true; announceMidStep(); await edited; }
        return { ...base, parsedToolCalls: [{ name: 'vault.read', args: { path: 'Plans/plan.md' } }] };
      },
    };
    const d = daemonFor(slow);
    await d.start();
    await midStep;
    const notePath = path.join(dir, 'Jobs', `${id}.md`);
    const before = readFileSync(notePath, 'utf8');
    expect(before).toMatch(/^status: running$/m);
    writeFileSync(notePath, before.replace(/^status: running$/m, 'status: cancelled'));
    releaseStep();
    // Also a whole job through the harness before anything can be cancelled, so it gets the same budget.
    await waitFor(() => d.vault.events.count('job.cancelled') >= 1, 'the cancelled job');
    // "within one step": the model was asked for exactly one tool call and none of it was executed.
    expect(readJob(d.vault, id)!.data.checkpoint_step).toBeLessThanOrEqual(1);
    expect(readJob(d.vault, id)!.data.status).toBe('cancelled');
    expect(d.vault.events.count('agent.tool_call')).toBe(0);
    await d.stop();
  }, TEST_MS);

  it('WS serves a snapshot, broadcasts events, replays, and cabin chat writes a message note', async () => {
    const d = daemonFor(fakeLlm(), 0);
    await d.start();
    const port = d.config.port; // port 0 binds an ephemeral port; the daemon writes the actual bound port back here
    const info = JSON.parse(readFileSync(path.join(dir, '.cubicle/daemon.json'), 'utf8')) as { token: string };
    const bad = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { origin: 'http://evil.example' } });
    const badClosed = await new Promise<boolean>((r) => { bad.once('error', () => r(true)); bad.once('open', () => r(false)); });
    expect(badClosed).toBe(true);
    const noToken = new WebSocket(`ws://127.0.0.1:${port}`);
    expect(await new Promise<boolean>((r) => { noToken.once('error', () => r(true)); noToken.once('open', () => r(false)); })).toBe(true);
    const ws = new WebSocket(`ws://127.0.0.1:${port}?token=${info.token}`);
    const msgs: Record<string, unknown>[] = [];
    ws.on('message', (m) => msgs.push(JSON.parse(String(m))));
    await new Promise((r) => ws.once('open', r));
    await waitFor(() => msgs.some((m) => m.op === 'snapshot'));
    const snap = msgs.find((m) => m.op === 'snapshot') as ReturnType<typeof buildSnapshot>;
    expect(snap.roles.map((r) => r.role)).toEqual(expect.arrayContaining(['ceo', 'cto', 'backend_engineer', 'cmo', 'coo']));
    expect(snap.roles).toHaveLength(38);   // 33 active seats + the five inactive sales placeholders
    ws.send(JSON.stringify({ op: 'chat', text: 'Bookkeeping for tiny shops' }));
    await waitFor(() => msgs.some((m) => m.op === 'chat.ack'));
    expect(listInbox(d.vault).some((n) => n.data.kind === 'message' && n.data.from === 'owner')).toBe(true);
    await waitFor(() => msgs.some((m) => m.op === 'event' && m.type === 'heartbeat.completed'), 'heartbeat.completed on the socket');
    ws.send(JSON.stringify({ op: 'replay', from: '2000-01-01T00:00:00.000Z' }));
    await waitFor(() => msgs.some((m) => m.op === 'replay'));
    const rep = msgs.find((m) => m.op === 'replay') as { events: unknown[] };
    expect(rep.events.length).toBeGreaterThan(5);
    ws.close();
    await d.stop();
  }, TEST_MS);

  it('an old vault is migrated to the default org on start and the brief mentions it', async () => {
    rmSync(path.join(dir, 'Teams'), { recursive: true, force: true });
    const d = daemonFor(fakeLlm());
    await d.start();
    try { expect(existsSync(path.join(dir, 'Teams/dev.md'))).toBe(true); expect(d.vault.events.count('org.changed')).toBe(1); } finally { await d.stop(); }
  }, TEST_MS);
});

describe('an approved call the wrapper vetoes', () => {
  it('reports the block on re-approval instead of "already executed" (C1)', async () => {
    const vault = Vault.open(dir);
    vault.updateNote('Roles/cmo.md', (n) => ({ data: { ...n.data, tools: [...(n.data.tools as string[]), 'mock.outbound'] }, body: n.body }), 'owner');
    const cfg = parseToolsConfig(readFileSync(path.join(root, 'config/tools.yaml'), 'utf8'));
    const job = createJob(vault, { type: 'growth.outreach', title: 'outreach', assigned: 'cmo', goal: 'send' }, 'cto');
    const key = `${job}:1:1`;
    const p = createProposal(vault, { kind: 'outbound_batch', from: 'cmo', job, title: 'send one', body: 'x', call: { tool: 'mock.outbound', args: { to: 'a@x', body: 'hi' }, idempotency_key: key, job, role: 'cmo' } }, 'cmo');
    // The pre-check clears the call; the wrapper, evaluating a moment later, refuses it. That is the race the
    // classifier's non-determinism used to open, and it must not silently consume the owner's approval.
    let seen = 0;
    const guardrails = [{ check: () => (++seen > 1 ? 'constitution: max_emails_per_day (1) reached' : null) }];
    const deps = { vault, registry: new ToolRegistry().registerAll(phase3Tools({ includeMock: true })), toolsConfig: cfg, scheduler: vaultScheduler(vault), env: {}, guardrails };

    const first = await executeStoredCall(deps, findInboxById(vault, p.id)!);
    expect(first.ok).toBe(false);
    expect(first.text).toContain('max_emails_per_day');
    expect(existsSync(path.join(dir, '.cubicle/mock-outbound.jsonl'))).toBe(false); // the handler never ran
    expect(readJob(vault, job)!.data.side_effects_done).toEqual([key]); // at-most-once ledger untouched

    const again = await executeStoredCall(deps, findInboxById(vault, p.id)!);
    expect(again.ok).toBe(false);
    expect(again.text).toContain('blocked');
    expect(again.text).toContain('max_emails_per_day');
    expect(again.text).not.toMatch(/already executed|interrupted/);
    vault.close();
  });
});

describe('local-tier summariser (D1)', () => {
  it('the daemon hands the harness a summarize() that runs on the local tier', async () => {
    const vault = Vault.open(dir);
    vault.events.emit({ type: 'heartbeat.completed', payload: { id: 'seed' } }); // recent → no startup heartbeat
    vault.writeText('Docs/big.md', 'x'.repeat(2000), 'daemon');
    const id = createJob(vault, { type: 'research', title: 'read a lot', assigned: 'cmo', goal: 'g' }, 'cto');
    vault.close();
    const prose: { tier: string; system: string; user: string }[] = [];
    let reads = 0;
    const llm: Llm = {
      async chat(req, chat) {
        const base = { content: '', toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 }, provider: 'fake', model: 'fake', tier: 'strong' as const, downgraded: false, parsedToolCalls: [] as { name: string; args: Record<string, unknown> }[] };
        if (!chat.tools) {
          prose.push({ tier: req.tier, system: String(chat.messages[0]?.content ?? ''), user: String(chat.messages[1]?.content ?? '') });
          return { ...base, content: 'read Docs/big.md repeatedly' };
        }
        if (req.roleId !== 'cmo') return { ...base, parsedToolCalls: [{ name: 'finish', args: { status: 'done', summary: 'x' } }] };
        if (reads++ < 20) return { ...base, parsedToolCalls: [{ name: 'vault.read', args: { path: 'Docs/big.md' } }] };
        return { ...base, parsedToolCalls: [{ name: 'finish', args: { status: 'done', summary: 'read it all' } }] };
      },
      promptBudget: () => 6000,
    };
    const d = track(new Daemon(defaultConfig(dir, { CUBICLE_MOCK_TOOLS: '1' } as NodeJS.ProcessEnv, { port: 0, tickMs: 500, maxConcurrentJobs: 2, providersPath: path.join(root, 'config/providers.yaml'), toolsPath: path.join(root, 'config/tools.yaml') }), { llm, disableWs: true, disableSleepWatch: true, memory: false, log: () => undefined }));
    await d.start();
    try {
      await waitFor(() => prose.some((p) => p.tier === 'local' && p.system.startsWith('Summarize the following observations')), 'the local-tier summary call');
    } finally { await d.stop(); }
    const call = prose.find((p) => p.system.startsWith('Summarize the following observations'))!;
    expect(call.tier).toBe('local');
    expect(call.user).toContain('vault.read');
    expect(readJob(Vault.open(dir), id)).toBeTruthy();
  }, TEST_MS);
});

describe('Brand/logo.png on an existing vault (D10)', () => {
  const LOGO = 'Brand/logo.png';
  const PNG_SIGNATURE = '89504e470d0a1a0a';
  const quietDaemon = () => track(new Daemon(defaultConfig(dir, { CUBICLE_MOCK_TOOLS: '1' } as NodeJS.ProcessEnv, { port: 0, tickMs: 500, maxConcurrentJobs: 1, providersPath: path.join(root, 'config/providers.yaml'), toolsPath: path.join(root, 'config/tools.yaml') }), { llm: fakeLlm(), disableWs: true, disableSleepWatch: true, memory: false, log: () => undefined }));

  it('is drawn at start when missing, and a vault that already has one is untouched', async () => {
    const seed = Vault.open(dir);
    seed.events.emit({ type: 'heartbeat.completed', payload: { id: 'seed' } }); // recent → no startup heartbeat
    seed.close();
    rmSync(path.join(dir, LOGO), { force: true }); // a vault scaffolded before the logo existed

    const d = quietDaemon();
    await d.start();
    let sha: unknown;
    try {
      const png = readFileSync(path.join(dir, LOGO));
      expect(png.subarray(0, 8).toString('hex')).toBe(PNG_SIGNATURE);
      const wrote = d.vault.events.query({ types: ['vault.wrote'] }).filter((e) => e.payload.path === LOGO && e.agent === 'daemon');
      expect(wrote).toHaveLength(1);
      expect(wrote[0].payload.generated).toBe(true);
      sha = wrote[0].payload.sha;
      expect(typeof sha).toBe('string');
    } finally { await d.stop(); }

    const before = readFileSync(path.join(dir, LOGO));
    const d2 = quietDaemon();
    await d2.start();
    try {
      expect(readFileSync(path.join(dir, LOGO)).equals(before)).toBe(true);
      expect(d2.vault.events.query({ types: ['vault.wrote'] }).filter((e) => e.payload.path === LOGO && e.agent === 'daemon')).toHaveLength(1);
    } finally { await d2.stop(); }
  }, TEST_MS);
});
