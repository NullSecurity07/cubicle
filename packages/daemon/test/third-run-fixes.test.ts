/**
 * The third live run's defects (the owner's AltStack run, 2026-09-13), each pinned by the behaviour the owner
 * saw — ledger `sdd/2026-09-13-sp8/progress.md`:
 *
 * D1 (ruling P8-14) the owner picked one of the three ideas **from the Decisions sheet**. `ownerDecide` writes
 *    through the vault and records the sha, so the watcher emitted no `owner.edited`,
 *    `inboxEditWakesHeartbeat` never ran, no heartbeat followed the pick, and discovery never started: step 5
 *    of the next cycle said only "the founder interview is waiting for an answer". A decision taken in the
 *    office now wakes the company exactly as the same decision saved in Obsidian would.
 *
 * D2 (ruling P8-15) the brief step's first-run seeds — scaffold the site, define the offer, research a channel —
 *    ran with no adopted founder brief, and the company did eighteen jobs for an idea the board had not judged.
 *    They wait for the brief like every other plan, and are created on the first heartbeat after adoption.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import {
  scaffoldVault, Vault, createProposal, createJob, listJobs, listInbox, listStreams, findInboxById, loadOrg,
  readJob, nowIso, FOUNDER_BRIEF, BRAND_NAME_PATH, INTERVIEW_PATH,
} from '@cubicle/core';
import type { RoutedChatResult, RouteRequest, ChatMessage, ToolSchema } from '@cubicle/router';
import type { Llm } from '@cubicle/harness';
import { Daemon, defaultConfig, runHeartbeat, createHeartbeatJob, seedFirstJobs, briefAdoptedAt, FIRST_JOB_TITLES, WAITING_FOR_BRIEF } from '../src/index.js';
import { noLocalModel } from './helpers/no-local-model.js';
import { ADOPTED_BRIEF, adoptFounderBrief } from './helpers/brief.js';

const root = path.resolve(__dirname, '../../..');
let dir: string; let vault: Vault;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-third-run-'));
  vault = (await scaffoldVault(dir)).vault;
  noLocalModel(vault);
});
afterEach(() => { try { vault.close(); } catch { /* already closed */ } rmSync(dir, { recursive: true, force: true }); });

/** A model that answers with whatever it was asked, so nothing in these cases leaves the process. */
function echoLlm(): Llm {
  return {
    async chat(_req: RouteRequest, chat: { messages: ChatMessage[]; tools?: ToolSchema[] }): Promise<RoutedChatResult> {
      return { content: String(chat.messages.at(-1)?.content ?? '').slice(0, 200), toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 }, provider: 'fake', model: 'fake', tier: 'cheap', downgraded: false, parsedToolCalls: [] };
    },
    promptBudget: () => 6000,
  };
}

/** Poll on real timers: these cases drive a live daemon and assert on what it has written. */
async function waitUntil(pred: () => boolean, what: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`waited ${ms} ms for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

// ---------------------------------------------------------------------------------------------------------
// D1 / P8-14: a decision taken in the office wakes the company
// ---------------------------------------------------------------------------------------------------------

describe('P8-14: a decision taken through the office wakes the company as an Obsidian edit would', () => {
  const daemons: Daemon[] = [];
  afterEach(async () => { for (const d of daemons.splice(0)) await d.stop().catch(() => undefined); });

  /**
   * A real daemon with its WS server up and **no worker slots**: `maxConcurrentJobs: 0` means the pool never
   * starts a job, so what these cases count is what the decide path queued and not what a cycle then did.
   * The heartbeat cadence is off (spec §8's triggers all disabled) for the same reason — the only heartbeat in
   * the vault is the one the decision asked for.
   */
  async function daemonUp(): Promise<{ d: Daemon; sock: WebSocket; seen: Record<string, unknown>[] }> {
    // A cycle has already completed, so neither the startup trigger nor the elapsed-hours trigger fires and
    // `requestHeartbeat`'s §12 gate (nothing runs before the owner has said anything) is open.
    vault.events.emit({ type: 'heartbeat.completed', payload: { id: 'seed' } });
    vault.close();
    const d = new Daemon(
      defaultConfig(dir, { CUBICLE_MOCK_TOOLS: '1' } as NodeJS.ProcessEnv, {
        port: 0, tickMs: 60_000, maxConcurrentJobs: 0,
        heartbeat: { maxElapsedHours: 999, jobsCompletedN: Number.MAX_SAFE_INTEGER, startupAwayHours: 999 },
        providersPath: path.join(root, 'config/providers.yaml'), toolsPath: path.join(root, 'config/tools.yaml'),
      }),
      { llm: echoLlm(), disableSleepWatch: true, disablePantry: true, memory: false, log: () => undefined, closeDbOnStop: false },
    );
    daemons.push(d);
    await d.start();
    const { token } = JSON.parse(readFileSync(path.join(dir, '.cubicle/daemon.json'), 'utf8')) as { token: string };
    const sock = new WebSocket(`ws://127.0.0.1:${d.config.port}?token=${token}`);
    const seen: Record<string, unknown>[] = [];
    sock.on('message', (m) => seen.push(JSON.parse(String(m))));
    await new Promise((r) => sock.once('open', r));
    await waitUntil(() => seen.some((m) => m.op === 'snapshot'), 'the snapshot');
    return { d, sock, seen };
  }

  const heartbeats = (v: Vault) => listJobs(v).filter((j) => j.type === 'ceo.heartbeat');
  const decide = (sock: WebSocket, id: string, approved: boolean, chosen?: number) => sock.send(JSON.stringify({ op: 'decide', id, approved, ...(chosen === undefined ? {} : { chosen }) }));

  it('approving the pick from the Decisions sheet queues a heartbeat that names the note (D1)', async () => {
    const { d, sock, seen } = await daemonUp();
    const { id } = createProposal(d.vault, {
      kind: 'brand_change', from: 'ceo', to: 'owner', target: BRAND_NAME_PATH, title: 'Three company ideas — pick one',
      body: '1. Northwind — kits for nursery kitchens.\n2. Tuckbox — a weekly box.\n3. Provender — per child per week.\n\nSet `chosen: 1|2|3` and `approved: true`.',
    }, 'ceo');

    decide(sock, id, true, 2);
    await waitUntil(() => seen.some((m) => m.op === 'decide.ack'), 'the ack');
    await waitUntil(() => heartbeats(d.vault).length === 1, 'the heartbeat the pick asked for');

    expect(heartbeats(d.vault)[0].title).toBe(`Heartbeat (decided ${id})`);
    expect(findInboxById(d.vault, id)!.data.chosen).toBe(2);
    sock.close();
  }, 60_000);

  it('rejecting the founder brief wakes a cycle too — the rewrite has to reach the CEO', async () => {
    const { d, sock, seen } = await daemonUp();
    const { id } = createProposal(d.vault, {
      kind: 'founder_brief', from: 'ceo', to: 'owner', target: FOUNDER_BRIEF, title: 'The founder brief',
      body: `## Proposed content\n\n\`\`\`md\n${ADOPTED_BRIEF}\`\`\`\n\nSet \`approved: true\` to adopt it.`,
    }, 'ceo');

    decide(sock, id, false);
    await waitUntil(() => seen.some((m) => m.op === 'decide.ack'), 'the ack');
    await waitUntil(() => heartbeats(d.vault).length === 1, 'the heartbeat the rejection asked for');
    expect(heartbeats(d.vault)[0].title).toBe(`Heartbeat (decided ${id})`);
    sock.close();
  }, 60_000);

  it('approving a plan verdict wakes nothing: the tick applies an approval within seconds (ruling S-4)', async () => {
    const { d, sock, seen } = await daemonUp();
    // An idea on file, so nothing here is refused by the §12 gate: what keeps the company asleep is the *kind*
    // of decision, not the state of the vault.
    createProposal(d.vault, { kind: 'brand_change', from: 'ceo', to: 'owner', target: BRAND_NAME_PATH, title: 'A name', body: 'Northwind.' }, 'ceo');
    const { id } = createProposal(d.vault, { kind: 'plan_verdict', from: 'ceo', to: 'owner', title: "Approve this cycle's plan", body: '1. bet one\n2. bet two' }, 'ceo');

    decide(sock, id, true);
    await waitUntil(() => seen.some((m) => m.op === 'decide.ack'), 'the ack');
    await d.runTick('settle');

    expect(findInboxById(d.vault, id)!.data.approved).toBe(true);
    expect(heartbeats(d.vault)).toEqual([]);
    sock.close();
  }, 60_000);

  it('the Obsidian path still wakes one, and a second decision does not make it two', async () => {
    const { d, sock, seen } = await daemonUp();
    const pick = createProposal(d.vault, { kind: 'brand_change', from: 'ceo', to: 'owner', target: BRAND_NAME_PATH, title: 'Pick one', body: '1. Northwind.\n2. Tuckbox.\n3. Provender.' }, 'ceo');
    const { path: rel } = createProposal(d.vault, {
      kind: 'founder_brief', from: 'ceo', to: 'owner', target: FOUNDER_BRIEF, title: 'The founder brief',
      body: `## Proposed content\n\n\`\`\`md\n${ADOPTED_BRIEF}\`\`\`\n\nSet \`approved: true\` to adopt it.`,
    }, 'ceo');

    // The owner turns the brief down in Obsidian: a write the daemon did not make, which the watcher reads as
    // an owner edit (1.5 s debounce) and `inboxEditWakesHeartbeat` turns into a cycle. Unchanged by P8-14.
    const onDisk = readFileSync(path.join(dir, rel), 'utf8');
    writeFileSync(path.join(dir, rel), onDisk.replace(/^approved:.*$/m, 'approved: false') + '\nNot this one.\n');
    await waitUntil(() => heartbeats(d.vault).length === 1, 'the heartbeat the Obsidian edit asked for');
    expect(heartbeats(d.vault)[0].title).toBe(`Heartbeat (owner edited ${rel})`);

    // …and now a decision through the office, in the same window. `requestHeartbeat` is idempotent while one
    // heartbeat is open, so the company wakes once however many paths said so.
    decide(sock, pick.id, true, 1);
    await waitUntil(() => seen.some((m) => m.op === 'decide.ack'), 'the ack');
    await d.runTick('settle');
    expect(heartbeats(d.vault)).toHaveLength(1);
    sock.close();
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------------------
// D2 / P8-15: the first-run seeds wait for the founder brief
// ---------------------------------------------------------------------------------------------------------

describe('P8-15: the first stream and the first jobs wait for the adopted founder brief', () => {
  /** A company with an idea, a plan the gate will stand, and a founder brief filed but not yet adopted. */
  function companyAwaitingTheBrief(v: Vault): string {
    v.updateNote(BRAND_NAME_PATH, (n) => ({ data: { ...n.data, name: 'PlateReady' }, body: n.body }), 'owner');
    // The interview has been asked and the owner has not answered: discovery reads nothing, so the cycle runs
    // to the brief step instead of blocking on a discovery job (the state the live run was in).
    v.writeText(INTERVIEW_PATH, '# Founder interview\n\n## Answers\n\n1. A meal-kit service for nurseries. _(from the idea)_\n', 'daemon');
    // A fresh, substantive plan with work still open: the re-planning gate stands it, so no company.plan
    // sub-job blocks the cycle before the brief step (see planningGate).
    v.writeText('Plans/plan.md', `---\nupdated: "${nowIso()}"\ncycle: 1\n---\n# Plan\n\n## Objectives\n\n### dev\n- Ship the staging branch\n`, 'ceo');
    createJob(v, { type: 'engineer.ship', title: 'Ship the staging branch', assigned: 'backend_engineer', goal: 'g' }, 'cto');
    const { id } = createProposal(v, {
      kind: 'founder_brief', from: 'ceo', to: 'owner', target: FOUNDER_BRIEF, title: 'The founder brief',
      body: `## Proposed content\n\n\`\`\`md\n${ADOPTED_BRIEF}\`\`\`\n\nSet \`approved: true\` to adopt it.`,
    }, 'ceo');
    // A cycle has already completed before the brief is adopted — the very thing that made the old `ideaAt`
    // anchor suppress the seeds for ever.
    v.events.emit({ type: 'heartbeat.completed', payload: { id: 'seed' } });
    return id;
  }

  /** Adopt the brief exactly as the dispatcher does when the owner approves the proposal. */
  function adopt(v: Vault, proposalId: string): void {
    adoptFounderBrief(v);
    const note = findInboxById(v, proposalId)!;
    v.updateNote(note.path, (n) => ({ data: { ...n.data, approved: true, resolved_at: nowIso() }, body: n.body }), 'daemon');
  }

  const cycle = async (v: Vault, trigger: string) => runHeartbeat({ vault: v, llm: echoLlm(), env: {}, planMaxAgeDays: 3 }, createHeartbeatJob(v, trigger));
  const seeds = (v: Vault) => listJobs(v).filter((j) => FIRST_JOB_TITLES.includes(j.title as typeof FIRST_JOB_TITLES[number]));
  const briefStepLog = (v: Vault, jobId: string) => (readJob(v, jobId)!.body.match(/^- step \d+ brief: .*$/gm) ?? []);

  it('seeds nothing while the brief is waiting for the owner, and says so once a cycle', async () => {
    companyAwaitingTheBrief(vault);

    const first = await cycle(vault, 'cycle one');
    expect(first.status).toBe('done');
    const second = await cycle(vault, 'cycle two');
    expect(second.status).toBe('done');

    expect(seeds(vault)).toEqual([]);
    expect(listStreams(vault)).toEqual([]);
    const hb = listJobs(vault).filter((j) => j.type === 'ceo.heartbeat');
    expect(hb).toHaveLength(2);
    for (const j of hb) {
      const lines = briefStepLog(vault, j.id);
      expect(lines.filter((l) => l.includes(WAITING_FOR_BRIEF))).toHaveLength(1);
      expect(lines.some((l) => /seeded|created the first stream/.test(l))).toBe(false);
    }
  }, 120_000);

  it('the first heartbeat after adoption seeds the three jobs and the stream, and no later one seeds again', async () => {
    const proposal = companyAwaitingTheBrief(vault);
    await cycle(vault, 'cycle one');
    expect(seeds(vault)).toEqual([]);

    adopt(vault, proposal);
    const after = await cycle(vault, 'cycle two');
    expect(after.status).toBe('done');
    expect(seeds(vault).map((j) => j.title).sort()).toEqual([...FIRST_JOB_TITLES].sort());
    expect(listStreams(vault)).toHaveLength(1);
    // Every seed points at the stream this cycle created.
    expect(seeds(vault).every((j) => j.stream === listStreams(vault)[0].slug)).toBe(true);

    await cycle(vault, 'cycle three');
    expect(seeds(vault)).toHaveLength(3);
    expect(listStreams(vault)).toHaveLength(1);
  }, 120_000);

  describe('briefAdoptedAt: the anchor the seeds hang on', () => {
    it('is null with no brief, the brief\'s own write once there is one, and never moves', () => {
      expect(briefAdoptedAt(vault)).toBeNull();
      expect(seedFirstJobs(vault, loadOrg(vault))).toEqual([]);

      adoptFounderBrief(vault);
      const at = briefAdoptedAt(vault)!;
      const wrote = vault.events.query({ types: ['vault.wrote'] }).find((e) => e.payload.path === FOUNDER_BRIEF)!;
      expect(at).toBe(wrote.ts);

      // A heartbeat from *before* the adoption cannot suppress the seeds — the D2 regression.
      expect(seedFirstJobs(vault, loadOrg(vault))).toHaveLength(3);
      expect(briefAdoptedAt(vault)).toBe(at);
    });

    it('falls back to the proposal the owner approved when the log no longer carries the write', () => {
      const resolved = '2026-09-13T08:00:00.000Z';
      const { id } = createProposal(vault, { kind: 'founder_brief', from: 'ceo', to: 'owner', target: FOUNDER_BRIEF, title: 'The founder brief', body: 'b' }, 'ceo');
      const note = findInboxById(vault, id)!;
      vault.updateNote(note.path, (n) => ({ data: { ...n.data, approved: true, resolved_at: resolved }, body: n.body }), 'daemon');
      // The file is there and nothing in the log says when it arrived (a trimmed log, or a vault restored from
      // a backup): the note the owner signed is the other record of the same moment.
      writeFileSync(path.join(dir, FOUNDER_BRIEF), ADOPTED_BRIEF);
      expect(briefAdoptedAt(vault)).toBe(resolved);
    });
  });

  it('a heartbeat that completed since the adoption is what stops a second seeding', () => {
    adoptFounderBrief(vault);
    vault.events.emit({ type: 'heartbeat.completed', payload: { id: 'h1' } });
    expect(seedFirstJobs(vault, loadOrg(vault))).toEqual([]);
    expect(listInbox(vault).filter((n) => n.data.kind === 'founder_brief')).toEqual([]);
  });
});
