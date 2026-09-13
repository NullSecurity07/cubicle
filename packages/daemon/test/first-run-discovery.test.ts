import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  scaffoldVault, Vault, listJobs, listInbox, readJob, readIdea, updateJob, createProposal, loadOrg, officeHolder,
  DISCOVERY_INBOX, INTERVIEW_PATH, FOUNDER_BRIEF, interviewPhase, INTERVIEW_QUESTIONS,
  renderInterviewAsk, interviewAskTitle,
} from '@cubicle/core';
import type { Llm } from '@cubicle/harness';
import type { RouteRequest, ChatMessage, ToolSchema } from '@cubicle/router';
import { Daemon, defaultConfig, HEARTBEAT_STEPS, PLAN_WAIT_BUDGET_MS, runHeartbeat, createHeartbeatJob } from '../src/index.js';
import { hasIdea, ideaAt } from '../src/first-run.js';   // both live in the daemon, not in core
import { interviewMessageId, openDiscoveryJob, askInterview, interviewMaterial, discoveryStatus, captureInterviewAnswer } from '../src/discovery.js';
import { orgLlm } from '../../../scripts/lib/org-llm.js';
import { letTheBoardDecide } from './helpers/board-switch.js';

const root = path.resolve(__dirname, '../../..');

let dir: string;
let vault: Vault;
beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-sp3-firstrun-'));
  vault = (await scaffoldVault(dir)).vault;
});
// The daemon cases below close `vault` and open their own, so closing twice must not fail the teardown.
afterEach(() => { try { vault.close(); } catch { /* already closed */ } rmSync(dir, { recursive: true, force: true }); });

/** A model that answers every prompt with one line and records what it was asked. */
function recordingLlm(answer = 'Noted.'): Llm & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    async chat(_r: RouteRequest, chat: { messages: ChatMessage[]; tools?: ToolSchema[] }) {
      prompts.push(String(chat.messages.at(-1)?.content ?? ''));
      return { content: answer, toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 }, provider: 'f', model: 'f', tier: 'medium' as const, downgraded: false, parsedToolCalls: [] };
    },
    promptBudget: () => 6000,
  };
}

/**
 * Poll the vault until `pred` holds. The two cases below drive a live `Daemon` on 300 ms ticks, and the ledger
 * already records a real-timer file failing when it ran beside two others at load 20 — so the budget is
 * generous on purpose: it is a ceiling for a stuck run, not a wait a healthy one spends.
 */
async function until(v: Vault, pred: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`${what}: ${listJobs(v).map((j) => `${j.type}=${j.status}`).join(', ')}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * The owner, in a test where nobody is at the keyboard: wait for the founder brief discovery files, check that
 * nothing has been planned off it yet (ruling S-1 — the brief is what every plan is written against), and adopt
 * it the way Obsidian does, with a raw write the vault API never saw so `isOwnerChanged` reads it as theirs.
 */
async function ownerAdoptsTheBrief(v: Vault): Promise<void> {
  await until(v, () => listInbox(v).some((n) => n.data.kind === 'founder_brief' && n.data.approved === null), 180_000, 'no founder brief proposal');
  expect(listJobs(v).some((j) => j.type === 'company.plan')).toBe(false);
  const rel = listInbox(v).find((n) => n.data.kind === 'founder_brief')!.path;
  const abs = path.join(dir, rel);
  writeFileSync(abs, readFileSync(abs, 'utf8').replace(/^approved: .*$/m, 'approved: true'));
}

/** Run one heartbeat from `gather`, exactly as the daemon does, and hand back its id and its outcome. */
async function cycle(v: Vault, llm: Llm): Promise<{ hb: string; out: Awaited<ReturnType<typeof runHeartbeat>> }> {
  const hbId = createHeartbeatJob(v, 'test');
  const out = await runHeartbeat({ vault: v, llm, env: {}, now: () => new Date() }, hbId);
  return { hb: hbId, out };
}

describe('a dropped file is an idea (spec §5)', () => {
  it('starts the company when the owner drops a file and types nothing at all', () => {
    expect(hasIdea(vault)).toBe(false);
    vault.writeText(`${DISCOVERY_INBOX}/pitch.md`, 'We sell meal kits to nurseries.', 'owner');
    expect(hasIdea(vault)).toBe(true);
    expect(ideaAt(vault)).not.toBeNull();
  });

  it('a README the template ships is not an idea', () => {
    // scaffoldVault already wrote Discovery/inbox/README.md; it must not start a company on its own.
    expect(vault.exists(`${DISCOVERY_INBOX}/README.md`)).toBe(true);
    expect(hasIdea(vault)).toBe(false);
  });

  it('the daemon will not start a cycle for an empty vault, and will for one with a file in it', async () => {
    vault.close();
    const d = new Daemon(defaultConfig(dir, { CUBICLE_MOCK_TOOLS: '1' } as NodeJS.ProcessEnv, { port: 0, tickMs: 600_000, providersPath: path.join(root, 'config/providers.yaml'), toolsPath: path.join(root, 'config/tools.yaml') }), { llm: recordingLlm(), disableWs: true, disableSleepWatch: true, memory: false, log: () => undefined });
    await d.start();
    const v = Vault.open(dir);
    try {
      expect(d.requestHeartbeat('nothing yet')).toBeNull();
      v.writeText(`${DISCOVERY_INBOX}/pitch.md`, 'We sell meal kits to nurseries.', 'owner');
      expect(d.requestHeartbeat('the owner dropped a file')).not.toBeNull();
    } finally { v.close(); await d.stop(); }
  }, 120_000);
});

describe('the discovery step asks before it reads (spec §5.1)', () => {
  it('asks the six questions when the vault holds nothing to read, and never asks twice', async () => {
    const v = Vault.open(dir);
    try {
      const ceo = officeHolder(loadOrg(v), 'chief_executive');
      await cycle(v, recordingLlm());
      expect(interviewPhase(v.readTextOrNull(INTERVIEW_PATH))).toBe('asked');
      const asked = listInbox(v).filter((n) => n.data.id === interviewMessageId(ceo));
      expect(asked).toHaveLength(1);
      expect(asked[0].data.from).toBe(ceo);
      expect(asked[0].data.to).toBe('owner');
      // Nothing to read yet, so nothing was queued and no model was spent on discovery.
      expect(listJobs(v).some((j) => j.type === 'discovery')).toBe(false);

      // A second cycle finds the interview out and says so, rather than asking again.
      await cycle(v, recordingLlm());
      expect(listInbox(v).filter((n) => n.data.id === interviewMessageId(ceo))).toHaveLength(1);
      expect(interviewPhase(v.readTextOrNull(INTERVIEW_PATH))).toBe('asked');
      expect(listJobs(v).some((j) => j.type === 'discovery')).toBe(false);
    } finally { v.close(); }
  });

  it('reads the material the owner dropped, asks what it does not answer, and blocks on the job', async () => {
    const v = Vault.open(dir);
    try {
      v.writeText(`${DISCOVERY_INBOX}/pitch.md`, 'We sell meal kits to nurseries. Two already pay us.', 'owner');
      const hbId = createHeartbeatJob(v, 'test');
      const out = await runHeartbeat({ vault: v, llm: recordingLlm(), env: {}, now: () => new Date() }, hbId);

      expect(out.status).toBe('blocked');
      const disc = listJobs(v).filter((j) => j.type === 'discovery');
      expect(disc).toHaveLength(1);
      expect(out).toMatchObject({ on: { kind: 'job', id: disc[0].id } });
      // The owner with a document is interviewed too, about what the document does not say (preflight G2).
      // This one-liner answers none of the six, so all six go out — and discovery reads the file regardless.
      expect(interviewPhase(v.readTextOrNull(INTERVIEW_PATH))).toBe('asked');
      for (const q of INTERVIEW_QUESTIONS) expect(v.readText(INTERVIEW_PATH)).toContain(q);
      // Discovery comes before the plan: the heartbeat stopped at `discovery` and queued nothing later.
      expect(HEARTBEAT_STEPS[v.readNoteOrNull(`Jobs/${hbId}.md`)!.data.checkpoint_step as number]).toBe('discovery');
      expect(listJobs(v).some((j) => j.type === 'company.plan')).toBe(false);
    } finally { v.close(); }
  });

  // Re-review ruling 2: the CEO's message promises "whatever you say next … goes into the founder brief the
  // next plan is written against". That is only true if the answer is read on the day it is given — and the
  // day floor, as first written, deferred it up to 24 hours because cycle one had already read the owner's one
  // line. This drives the two cycles and asserts the ordering the promise depends on: the answer's own
  // discovery job exists, and the heartbeat is still parked at `discovery`, before any plan is written.
  it('reads the interview answer in the cycle it arrives, before that cycle plans anything', async () => {
    const v = Vault.open(dir);
    try {
      createProposal(v, { kind: 'message', from: 'owner', to: 'ceo', title: 'The idea', body: 'Meal kits for nurseries.' }, 'owner');
      await cycle(v, recordingLlm('NAME: PlateReady\nTAGLINE: Lunch, solved.'));
      const first = listJobs(v).filter((j) => j.type === 'discovery');
      expect(first).toHaveLength(1);
      expect(interviewPhase(v.readTextOrNull(INTERVIEW_PATH))).toBe('asked');
      updateJob(v, first[0].id, { status: 'done' }, 'daemon');   // nobody runs jobs in this test

      // An hour later, the same day, the owner answers the six questions in the cabin.
      createProposal(v, { kind: 'message', from: 'owner', to: 'ceo', title: 'Answers', body: 'The nursery manager buys, not the parent. Two already pay us. Ten in three months.' }, 'owner');
      const second = await cycle(v, recordingLlm());

      expect(interviewPhase(v.readTextOrNull(INTERVIEW_PATH))).toBe('answered');
      const jobs = listJobs(v).filter((j) => j.type === 'discovery');
      expect(jobs).toHaveLength(2);                                   // read today, not tomorrow
      const fresh = jobs.find((j) => j.id !== first[0].id)!;
      expect(second.out).toMatchObject({ status: 'blocked', on: { kind: 'job', id: fresh.id } });
      expect(HEARTBEAT_STEPS[readJob(v, second.hb)!.data.checkpoint_step as number]).toBe('discovery');
      expect(listJobs(v).some((j) => j.type === 'company.plan')).toBe(false);
    } finally { v.close(); }
  });

  // Re-review ruling 3: the kill-window recovery blocks on a discovery job found in the vault, and that wait
  // has to be bounded like every other one. A job that never reaches a terminal status would otherwise cost
  // every later cycle its whole budget at this step, and the company would never read anything new again.
  it('leaves a discovery job that never finishes behind, and gets on with the cycle', async () => {
    const v = Vault.open(dir);
    try {
      v.writeText(`${DISCOVERY_INBOX}/pitch.md`, 'We sell meal kits to nurseries.', 'owner');
      const hb = createHeartbeatJob(v, 'test');
      let clock = new Date();
      const stuck = await runHeartbeat({ vault: v, llm: recordingLlm(), env: {}, now: () => clock }, hb);
      const disc = listJobs(v).filter((j) => j.type === 'discovery');
      expect(disc).toHaveLength(1);
      expect(stuck).toMatchObject({ status: 'blocked', on: { kind: 'job', id: disc[0].id } });

      // Nothing ever picks it up. Past the budget this cycle gives up on it and plans from what there is.
      clock = new Date(clock.getTime() + PLAN_WAIT_BUDGET_MS + 60_000);
      await runHeartbeat({ vault: v, llm: recordingLlm(), env: {}, now: () => clock }, hb);
      expect(readJob(v, hb)!.body).toContain('planning from what there is');
      expect(HEARTBEAT_STEPS[readJob(v, hb)!.data.checkpoint_step as number]).not.toBe('discovery');

      // And the next cycle does not start the whole wait again: a job nothing has touched since before the
      // budget is stranded, not "being read", so this heartbeat reads the new material instead of parking on it.
      v.writeText(`${DISCOVERY_INBOX}/more.md`, 'And to schools, from September.', 'owner');
      const next = await runHeartbeat({ vault: v, llm: recordingLlm(), env: {}, now: () => clock }, createHeartbeatJob(v, 'next'));
      const jobs = listJobs(v).filter((j) => j.type === 'discovery');
      expect(jobs).toHaveLength(2);
      expect(next).toMatchObject({ status: 'blocked', on: { kind: 'job', id: jobs.find((j) => j.id !== disc[0].id)!.id } });
    } finally { v.close(); }
  }, 30_000);

  // A discovery job in review has filed its brief and its cards; it is a reviewer's problem, not a reason to
  // hold the whole company at this step.
  it('does not wait on a discovery job that is already in review', async () => {
    const v = Vault.open(dir);
    try {
      v.writeText(`${DISCOVERY_INBOX}/pitch.md`, 'We sell meal kits to nurseries.', 'owner');
      const hb = createHeartbeatJob(v, 'test');
      await runHeartbeat({ vault: v, llm: recordingLlm(), env: {}, now: () => new Date() }, hb);
      const disc = listJobs(v).filter((j) => j.type === 'discovery')[0];
      updateJob(v, disc.id, { status: 'in_review' }, 'daemon');
      expect(openDiscoveryJob(v)).toBeNull();
    } finally { v.close(); }
  });

  it('a kill between the job note and the state write still blocks on the job, not past it', async () => {
    const v = Vault.open(dir);
    try {
      v.writeText(`${DISCOVERY_INBOX}/pitch.md`, 'We sell meal kits to nurseries.', 'owner');
      const hbId = createHeartbeatJob(v, 'test');
      await runHeartbeat({ vault: v, llm: recordingLlm(), env: {}, now: () => new Date() }, hbId);
      const first = listJobs(v).filter((j) => j.type === 'discovery');
      expect(first).toHaveLength(1);

      // The one-write window: the job note is on disk, but neither `state.discoveryJob` nor `blocked_on` names
      // it. `currentDiscoveryStatus` now answers `run: false` ("already read this material"), so a step that
      // trusted it would walk on and plan while discovery is still reading.
      const stateRel = path.join(dir, '.cubicle/jobs', `${hbId}.heartbeat.json`);
      const cached = JSON.parse(readFileSync(stateRel, 'utf8'));
      delete cached.discoveryJob;
      writeFileSync(stateRel, JSON.stringify(cached, null, 2));
      updateJob(v, hbId, { status: 'queued', blocked_on: undefined }, 'daemon');

      const again = await runHeartbeat({ vault: v, llm: recordingLlm(), env: {}, now: () => new Date() }, hbId);
      expect(again).toMatchObject({ status: 'blocked', on: { kind: 'job', id: first[0].id } });
      expect(listJobs(v).filter((j) => j.type === 'discovery')).toHaveLength(1);
      expect(listJobs(v).some((j) => j.type === 'company.plan')).toBe(false);
    } finally { v.close(); }
  });

  it('a cache-less resume re-finds the discovery job from blocked_on instead of queueing a second one', async () => {
    const v = Vault.open(dir);
    try {
      v.writeText(`${DISCOVERY_INBOX}/pitch.md`, 'We sell meal kits to nurseries.', 'owner');
      const hbId = createHeartbeatJob(v, 'test');
      await runHeartbeat({ vault: v, llm: recordingLlm(), env: {}, now: () => new Date() }, hbId);
      const first = listJobs(v).filter((j) => j.type === 'discovery');
      expect(first).toHaveLength(1);

      // The kill: the heartbeat's cache file is gone, but `blocked_on` on the job note is not.
      rmSync(path.join(dir, '.cubicle/jobs', `${hbId}.heartbeat.json`), { force: true });
      updateJob(v, hbId, { status: 'queued' }, 'daemon');
      const again = await runHeartbeat({ vault: v, llm: recordingLlm(), env: {}, now: () => new Date() }, hbId);
      expect(again.status).toBe('blocked');
      expect(listJobs(v).filter((j) => j.type === 'discovery').map((j) => j.id)).toEqual(first.map((j) => j.id));
    } finally { v.close(); }
  });
});

describe('what the owner types next closes the interview (spec §1.4)', () => {
  it('records the answer as a vault write, tells the CEO so, and lets discovery run on it', async () => {
    const v = Vault.open(dir);
    try {
      // Cycle one asks. Nothing else in the vault, so there is nothing to read.
      await cycle(v, recordingLlm());
      expect(interviewPhase(v.readTextOrNull(INTERVIEW_PATH))).toBe('asked');

      // The owner answers in the cabin — six answers, so also a long prompt. Whatever they say closes it.
      const answers = ['Meal kits for nurseries.', 'The nursery manager buys, not the parent.', 'Two nurseries already pay us.', 'Ten paying nurseries in three months.', 'No paid advertising.', 'We do not know whether the kitchens will cook it.'].join('\n');
      createProposal(v, { kind: 'message', from: 'owner', to: 'ceo', title: 'Answers', body: answers }, 'owner');
      const llm = recordingLlm();
      await cycle(v, llm);

      expect(interviewPhase(v.readTextOrNull(INTERVIEW_PATH))).toBe('answered');
      expect(v.readText(INTERVIEW_PATH)).toContain('nursery manager');
      // The reply the CEO drafts is told what happened, so it does not answer as though nothing had been asked.
      expect(llm.prompts.some((p) => p.includes('Discovery/interview.md'))).toBe(true);
      // And the answered interview is material: discovery reads it this same cycle.
      expect(listJobs(v).filter((j) => j.type === 'discovery')).toHaveLength(1);
    } finally { v.close(); }
  });

  it('a long brief goes to discovery instead of to the name-the-company reply', async () => {
    const v = Vault.open(dir);
    try {
      const brief = ['We are building a meal-kit service for nurseries.', 'Two nurseries already pay us a monthly fee.', 'The buyer is the nursery manager, not the parent.', 'We have a waitlist of eleven more in the same county.', 'What we do not know is whether the kitchens will cook it.'].join('\n');
      createProposal(v, { kind: 'message', from: 'owner', to: 'ceo', title: 'The idea', body: brief }, 'owner');
      const llm = recordingLlm();
      await cycle(v, llm);

      // No `NAME:`/`TAGLINE:` squeeze, and no brand_change proposal filed from the first sentence.
      expect(llm.prompts.some((p) => p.includes('NAME:'))).toBe(false);
      expect(listInbox(v).some((n) => n.data.kind === 'brand_change')).toBe(false);
      expect(llm.prompts.some((p) => p.includes('long brief'))).toBe(true);
      // Discovery reads the document *and* the interview goes out over what it leaves open (preflight G2):
      // this brief says what they are building and names a waitlist, but not who the buyer is or what would
      // make three months worth it, and one cue apiece is not an answer.
      expect(interviewPhase(v.readTextOrNull(INTERVIEW_PATH))).toBe('asked');
      expect(v.readText(INTERVIEW_PATH)).toContain(INTERVIEW_QUESTIONS[1]);
      expect(listJobs(v).filter((j) => j.type === 'discovery')).toHaveLength(1);
    } finally { v.close(); }
  });

  it('"skip" typed into the cabin is recorded as a skip, not as an answer', async () => {
    const v = Vault.open(dir);
    try {
      await cycle(v, recordingLlm());
      expect(interviewPhase(v.readTextOrNull(INTERVIEW_PATH))).toBe('asked');

      // What the cabin actually writes: ws.ts sends `title: text.slice(0, 60), body: text`, and createProposal
      // renders the note as `# <title>\n\n<body>`. The raw body is `# skip\n\nskip`, which `isSkip` does not match.
      createProposal(v, { kind: 'message', from: 'owner', to: 'ceo', title: 'skip', body: 'skip' }, 'owner');
      expect(listInbox(v).find((n) => n.data.from === 'owner')!.body).toContain('# skip');

      await cycle(v, recordingLlm());
      expect(interviewPhase(v.readTextOrNull(INTERVIEW_PATH))).toBe('skipped');
      expect(v.readText(INTERVIEW_PATH)).toContain('## Skipped');
      // A skip is not material, so the vault is read as it stands rather than the owner being told they answered.
      expect(listJobs(v).filter((j) => j.type === 'discovery')).toHaveLength(1);
    } finally { v.close(); }
  });

  it('"skip" never names the company', async () => {
    const v = Vault.open(dir);
    try {
      await cycle(v, recordingLlm());
      createProposal(v, { kind: 'message', from: 'owner', to: 'ceo', title: 'skip', body: 'skip' }, 'owner');
      const llm = recordingLlm('NAME: Skip Co\nTAGLINE: nope');
      await cycle(v, llm);
      expect(llm.prompts.some((p) => p.includes('NAME:'))).toBe(false);
      expect(listInbox(v).some((n) => n.data.kind === 'brand_change')).toBe(false);
      // It falls to the general reply, which is told the interview closed.
      expect(llm.prompts.some((p) => p.includes('Discovery/interview.md'))).toBe(true);
    } finally { v.close(); }
  });

  // The spec's headline requirement, in one cycle (§1.3, §5.5): "the owner types one line, the CEO proposes a
  // name, and discovery still runs over that line". All three, or the single-prompt company never plans at all.
  it('a one-line idea gets the name-the-company reply, the six questions AND a discovery job', async () => {
    const v = Vault.open(dir);
    try {
      createProposal(v, { kind: 'message', from: 'owner', to: 'ceo', title: 'The idea', body: 'Meal kits for nurseries.' }, 'owner');
      const llm = recordingLlm('NAME: PlateReady\nTAGLINE: Lunch, solved.');
      const out = await cycle(v, llm);
      expect(listInbox(v).some((n) => n.data.kind === 'brand_change' && n.data.target === 'Brand/name.md')).toBe(true);
      // Asking costs no model call, and the vault is still thin, so the six questions go out too.
      expect(interviewPhase(v.readTextOrNull(INTERVIEW_PATH))).toBe('asked');
      // And the line itself is read: one discovery job, blocked on before anything is planned against it.
      const disc = listJobs(v).filter((j) => j.type === 'discovery');
      expect(disc).toHaveLength(1);
      expect(readJob(v, out.hb)!.data.blocked_on?.id).toBe(disc[0].id);
      expect(listJobs(v).some((j) => j.type === 'company.plan')).toBe(false);
      // A second cycle with nothing new does not queue a second one, and does not ask again.
      await cycle(v, recordingLlm());
      expect(listJobs(v).filter((j) => j.type === 'discovery')).toHaveLength(1);
      expect(interviewPhase(v.readTextOrNull(INTERVIEW_PATH))).toBe('asked');
    } finally { v.close(); }
  });
});

describe('the first cycle reads, then judges, then plans (spec §5.1)', () => {
  it('runs discovery before the plan, and files the founder brief as a proposal', async () => {
    vault.writeText(`${DISCOVERY_INBOX}/pitch.md`, 'We sell meal kits to nurseries. Two already pay us.', 'owner');
    letTheBoardDecide(vault);
    vault.close();
    const d = new Daemon(defaultConfig(dir, { CUBICLE_MOCK_TOOLS: '1' } as NodeJS.ProcessEnv, { port: 0, tickMs: 300, maxConcurrentJobs: 3, providersPath: path.join(root, 'config/providers.yaml'), toolsPath: path.join(root, 'config/tools.yaml') }), { llm: orgLlm({ vetoes: 0 }), disableWs: true, disableSleepWatch: true, memory: false, log: () => undefined });
    await d.start();
    const v = Vault.open(dir);
    try {
      // Nothing plans before the owner adopts the brief (ruling S-1), so this is the owner doing it.
      await ownerAdoptsTheBrief(v);
      // 180 s, not 90: this drives a live daemon on 300 ms polls, and the ledger already records a real-timer
      // file failing under load beside two others. The budget is a ceiling, not a wait — a healthy run reaches
      // the plan in a few seconds.
      await until(v, () => listJobs(v).some((j) => j.type === 'company.plan'), 180_000, 'no company.plan');
      const disc = listJobs(v).find((j) => j.type === 'discovery')!;
      const plan = listJobs(v).find((j) => j.type === 'company.plan')!;
      expect(disc).toBeTruthy();
      // The whole point of the step: nothing is planned until the owner's material has been read.
      expect(disc.created < plan.created).toBe(true);
      // The heartbeat only walks past `discovery` on done/failed/cancelled, and this one succeeded.
      expect(disc.status).toBe('done');
      // And what discovery leaves behind is the brief the owner rules on, plus a card for the board. The card's
      // provenance comes from the job type, not from an argument, so `source: discovery` proves the real path.
      expect(listInbox(v).some((n) => n.data.kind === 'founder_brief' && n.data.target === FOUNDER_BRIEF)).toBe(true);
      const cards = v.list('Ideas', { ext: '.md' }).filter((p) => !p.endsWith('_template.md'));
      expect(cards.length).toBeGreaterThan(0);
      expect(v.readNoteOrNull(cards[0])!.data.source).toBe('discovery');
    } finally { v.close(); await d.stop(); }
  }, 240_000);

  // The spec's own last acceptance test — "a first run that goes discovery → board → plan in one cycle" — and
  // the single claim the whole step ordering exists for. Every earlier test proves one link of it; this one
  // drives the live daemon end to end on the scripted model: discovery files a card with its research half,
  // the finance office prices it, the score completes, the board sits, the owner is asked, and only then is
  // the plan written.
  it('goes discovery → card → estimate → board → verdict → plan, in one cycle', async () => {
    vault.writeText(`${DISCOVERY_INBOX}/pitch.md`, 'We sell meal kits to nurseries. Two already pay us.', 'owner');
    letTheBoardDecide(vault);
    vault.close();
    const d = new Daemon(defaultConfig(dir, { CUBICLE_MOCK_TOOLS: '1' } as NodeJS.ProcessEnv, { port: 0, tickMs: 300, maxConcurrentJobs: 3, providersPath: path.join(root, 'config/providers.yaml'), toolsPath: path.join(root, 'config/tools.yaml') }), { llm: orgLlm({ vetoes: 0, ideaVerdict: 'pass' }), disableWs: true, disableSleepWatch: true, memory: false, log: () => undefined });
    await d.start();
    const v = Vault.open(dir);
    try {
      // The one link this ordering gained in the second run: read → card → estimate → board → **brief** → plan.
      await ownerAdoptsTheBrief(v);
      await until(v, () => listJobs(v).some((j) => j.type === 'company.plan'), 180_000, 'no company.plan');
      const jobs = listJobs(v);
      const disc = jobs.find((j) => j.type === 'discovery')!;
      const estimate = jobs.find((j) => j.type === 'finance.estimate')!;
      const session = jobs.find((j) => j.type === 'board.session')!;
      const plan = jobs.find((j) => j.type === 'company.plan')!;
      expect(disc.status).toBe('done');
      expect(estimate).toBeTruthy();
      expect(session).toBeTruthy();
      // In order, and all of it before the plan: read, price, judge, ask, then plan.
      expect(disc.created < estimate.created).toBe(true);
      expect(estimate.created <= session.created).toBe(true);
      expect(session.created <= plan.created).toBe(true);

      // The card carries both halves and a score, and the board's verdict is on it.
      const cards = v.list('Ideas', { ext: '.md' }).filter((p) => !p.endsWith('_template.md'));
      expect(cards).toHaveLength(1);
      const slug = cards[0].slice(cards[0].lastIndexOf('/') + 1).replace(/\.md$/, '');
      const card = readIdea(v, slug)!;
      expect(card.data.score).toBe(48);                     // 4×4 + 3×4 + 3×4 + 2×4
      expect(card.data.board_verdict).toBe('pass');
      expect(card.data.research).toBeTruthy();
      expect(card.data.estimate).toBeTruthy();
      // And the owner is the one who rules: an idea_verdict note, filed by the board session, recommending keep.
      const verdict = listInbox(v).find((n) => n.data.kind === 'idea_verdict' && n.data.target === `Ideas/${slug}.md`)!;
      expect(verdict).toBeTruthy();
      expect((verdict.data as { band?: string }).band).toBe('keep');
      expect(verdict.data.job).toBeTruthy();
    } finally { v.close(); await d.stop(); }
  }, 240_000);
});

describe('the CEO asks only what the owner has not already said (spec §5)', () => {
  it('asks all six when the vault is empty, exactly as it always did', () => {
    const id = askInterview(vault, 'ceo', new Date('2026-09-12T09:00:00.000Z'));
    expect(id).toBeTruthy();
    expect(interviewPhase(vault.readTextOrNull(INTERVIEW_PATH))).toBe('asked');
    const msg = listInbox(vault).find((n) => n.data.id === id)!;
    // The title is the note's `# ` line: `createProposal` writes it into the body, not the frontmatter.
    expect(msg.body.split('\n')[0]).toBe('# Six questions, while I get started');
    for (const q of INTERVIEW_QUESTIONS) expect(msg.body).toContain(q);
  });

  it('asks three of six when the owner\'s cabin message answered the other three', () => {
    createProposal(vault, {
      kind: 'message', from: 'owner', to: 'ceo', title: 'what we are doing',
      body: 'We are building a weekly meal-kit box. The product is a Saturday delivery.\n\nWe already have a waitlist of 90 people and the domain.\n\nWe tried a Facebook group and it did not work, so we abandoned it.',
    }, 'owner');
    const id = askInterview(vault, 'ceo', new Date('2026-09-12T09:00:00.000Z'))!;
    const msg = listInbox(vault).find((n) => n.data.id === id)!;
    expect(msg.body.split('\n')[0]).toBe('# Three questions, while I get started');
    expect(msg.body).toContain('you have answered 3 of my six questions');
    expect(msg.body).toContain(INTERVIEW_QUESTIONS[1]);
    expect(msg.body).not.toContain(INTERVIEW_QUESTIONS[0]);
    // The transcript records the three it asked, so the owner's answer closes exactly those.
    const t = vault.readText(INTERVIEW_PATH);
    expect(interviewPhase(t)).toBe('asked');
    expect(t).toContain(INTERVIEW_QUESTIONS[5]);
    expect(t).not.toContain(INTERVIEW_QUESTIONS[2]);
  });

  it('reads the inbox files as well as the cabin', () => {
    vault.writeText(`${DISCOVERY_INBOX}/notes.md`, 'It is for independent nursery managers. Today they use a shared spreadsheet.', 'owner');
    expect(interviewMaterial(vault).text).toContain('nursery managers');
    expect(askInterview(vault, 'ceo', new Date())).toBeTruthy();
    expect(vault.readText(INTERVIEW_PATH)).not.toContain(INTERVIEW_QUESTIONS[1]);
  });

  // Preflight G2: the gate used to refuse to interview any vault that held a file at all, which made this
  // route unreachable in a live run. A dropped file is material, and the questions it answers are not asked.
  it('asks exactly three when an inbox file answers the other three', () => {
    vault.writeText(`${DISCOVERY_INBOX}/pitch.md`, [
      'We are building a weekly meal-kit box. The product is a Saturday delivery of five prepped dinners.',
      'We already have a waitlist of 90 people and the domain.',
      'We tried a Facebook group first and it did not work, so we abandoned it.',
    ].join('\n\n'), 'owner');
    const id = askInterview(vault, 'ceo', new Date('2026-09-12T09:00:00.000Z'))!;
    const msg = listInbox(vault).find((n) => n.data.id === id)!;
    expect(msg.body.split('\n')[0]).toBe('# Three questions, while I get started');
    expect(msg.body).toContain('you have answered 3 of my six questions');
    for (const i of [1, 3, 5]) expect(msg.body).toContain(INTERVIEW_QUESTIONS[i]);
    for (const i of [0, 2, 4]) expect(msg.body).not.toContain(INTERVIEW_QUESTIONS[i]);
  });

  it('asks nothing at all when an adopted founder brief answers all six (Decision 16)', () => {
    vault.writeText(FOUNDER_BRIEF, [
      '## What the company is', '', 'A weekly meal-kit box delivered to nurseries before seven in the morning, priced per child.', '',
      '## Who it is for', '', 'Independent nursery managers running twenty to sixty places, who plan menus on a shared spreadsheet.', '',
      // The one question no heading answers: it is covered by its cues, in the brief's own prose.
      '## What already exists', '', 'A waitlist of ninety and the domain. We tried a Facebook group first and it did not work.', '',
      '## What success looks like', '', 'Ten paying nurseries in three months, at forty pounds a week each, or it was not worth it.', '',
      '## Constraints', '', 'No paid ads and no investors: the owner will not raise, and cold outreach is off the table.', '',
      '## Candidate ideas', '', 'One card, `Ideas/meal-kits.md`, filed from the owner\'s own note about nurseries.', '',
      '## What we do not know', '', 'Whether a nursery kitchen will reheat what we send, which decides the whole packaging question.', '',
      '## Pressure test', '', 'Core Assumption: nurseries buy food centrally. Brutal Verdict: WEAK.', '',
    ].join('\n'), 'owner');

    expect(askInterview(vault, 'ceo', new Date('2026-09-12T09:00:00.000Z'))).toBeNull();
    const t = vault.readText(INTERVIEW_PATH);
    expect(interviewPhase(t)).toBe('covered');
    expect(t).toContain('already answered all 6 questions');
    // Nobody was asked anything: no cabin message went out, and it is not recorded as a skip the owner chose.
    expect(listInbox(vault).some((n) => n.data.from === 'ceo')).toBe(false);
    expect(t).not.toContain('## Skipped');
  });

  // Review T4, Important 2. Coverage made both writes material-dependent, which turned the one-write gap
  // between the message and the transcript from harmless into two ways to strand the owner.
  it('a kill after the message resumes into the transcript, and never into `covered`', () => {
    // Exactly the vault a kill in that gap leaves: the CEO's three questions are in the inbox, no transcript.
    const open = [INTERVIEW_QUESTIONS[1], INTERVIEW_QUESTIONS[3], INTERVIEW_QUESTIONS[5]];
    createProposal(vault, {
      id: interviewMessageId('ceo'), kind: 'message', from: 'ceo', to: 'owner',
      title: interviewAskTitle(open.length), body: renderInterviewAsk(open, 3),
    }, 'ceo');
    expect(vault.readTextOrNull(INTERVIEW_PATH)).toBeNull();

    // And the material has since grown to answer all six, which is what used to reach the covered branch.
    vault.writeText(FOUNDER_BRIEF, [
      '## What the company is', '', 'A weekly meal-kit box delivered to nurseries before seven in the morning, priced per child.', '',
      '## Who it is for', '', 'Independent nursery managers running twenty to sixty places, who plan menus on a shared spreadsheet.', '',
      '## What already exists', '', 'A waitlist of ninety and the domain. We tried a Facebook group first and it did not work.', '',
      '## What success looks like', '', 'Ten paying nurseries in three months, at forty pounds a week each, or it was not worth it.', '',
      '## Constraints', '', 'No paid ads and no investors: the owner will not raise, and cold outreach is off the table.', '',
      '## Candidate ideas', '', 'One card, `Ideas/meal-kits.md`, filed from the owner\'s own note about nurseries.', '',
      '## What we do not know', '', 'Whether a nursery kitchen will reheat what we send, which decides the packaging.', '',
    ].join('\n'), 'owner');

    expect(askInterview(vault, 'ceo', new Date('2026-09-12T09:00:00.000Z'))).toBeNull();   // no second message
    const t = vault.readText(INTERVIEW_PATH);
    // Not `covered`: the owner is looking at a message, and only an `asked` transcript can be closed by their
    // reply — `captureInterviewAnswer` would otherwise never record it, whatever they typed.
    expect(interviewPhase(t)).toBe('asked');
    expect(captureInterviewAnswer(vault, 'The buyer is the nursery manager, and she is the one who signs off the menu.', new Date())).toBe(true);
    expect(listInbox(vault).filter((n) => n.data.id === interviewMessageId('ceo'))).toHaveLength(1);
  });

  it('the resumed transcript records the questions the owner is reading, not the ones still open', () => {
    // `createProposal` replays idempotently and does *not* rewrite the body, so a resume that re-derived the
    // open questions would record one set and leave the owner reading another.
    const open = [INTERVIEW_QUESTIONS[1], INTERVIEW_QUESTIONS[3], INTERVIEW_QUESTIONS[5]];
    createProposal(vault, {
      id: interviewMessageId('ceo'), kind: 'message', from: 'ceo', to: 'owner',
      title: interviewAskTitle(open.length), body: renderInterviewAsk(open, 3),
    }, 'ceo');
    // Material arrives that answers one of the three the owner was actually asked.
    vault.writeText(`${DISCOVERY_INBOX}/notes.md`, 'It is for independent nursery managers. Today they use a shared spreadsheet.', 'owner');

    askInterview(vault, 'ceo', new Date('2026-09-12T09:00:00.000Z'));
    const t = vault.readText(INTERVIEW_PATH);
    for (const q of open) expect(t).toContain(q);                       // all three, including the covered one
    expect(t).not.toContain(INTERVIEW_QUESTIONS[0]);                    // and none the message did not carry
    expect(t).not.toContain(INTERVIEW_QUESTIONS[2]);
  });

  it('the gate lets the interview through whatever the vault holds, so the coverage check is reachable (preflight G2)', () => {
    const base = { briefProposalOpen: false, everRun: false, alreadyRun: false, ranToday: false, unread: { newInput: false, newInterview: false, longPrompt: false, anyPrompt: false } };
    const nothing = { ...base, hasBrief: false, inputs: 0, interview: 'none' as const };
    expect(discoveryStatus(nothing).ask).toBe(true);
    expect(discoveryStatus({ ...nothing, inputs: 3 }).ask).toBe(true);                                  // a file no longer silences it
    expect(discoveryStatus({ ...nothing, hasBrief: true }).ask).toBe(true);                             // nor does an adopted brief
    expect(discoveryStatus({ ...nothing, unread: { ...base.unread, longPrompt: true, anyPrompt: true } }).ask).toBe(true);  // nor a typed document
    // Asked once, ever: every phase but `none` closes it, `covered` included.
    for (const interview of ['asked', 'answered', 'skipped', 'covered'] as const) {
      expect(discoveryStatus({ ...nothing, interview }).ask, interview).toBe(false);
    }
  });
});
