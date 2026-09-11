import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  scaffoldVault, Vault, listJobs, listInbox, readJob, readIdea, updateJob, createProposal, loadOrg, officeHolder,
  DISCOVERY_INBOX, INTERVIEW_PATH, FOUNDER_BRIEF, interviewPhase,
} from '@cubicle/core';
import type { Llm } from '@cubicle/harness';
import type { RouteRequest, ChatMessage, ToolSchema } from '@cubicle/router';
import { Daemon, defaultConfig, HEARTBEAT_STEPS, runHeartbeat, createHeartbeatJob } from '../src/index.js';
import { hasIdea, ideaAt } from '../src/first-run.js';   // both live in the daemon, not in core
import { interviewMessageId } from '../src/discovery.js';
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

  it('reads the material instead of interviewing when the owner dropped a file, and blocks on the job', async () => {
    const v = Vault.open(dir);
    try {
      v.writeText(`${DISCOVERY_INBOX}/pitch.md`, 'We sell meal kits to nurseries. Two already pay us.', 'owner');
      const hbId = createHeartbeatJob(v, 'test');
      const out = await runHeartbeat({ vault: v, llm: recordingLlm(), env: {}, now: () => new Date() }, hbId);

      expect(out.status).toBe('blocked');
      const disc = listJobs(v).filter((j) => j.type === 'discovery');
      expect(disc).toHaveLength(1);
      expect(out).toMatchObject({ on: { kind: 'job', id: disc[0].id } });
      // The owner with a document is never also sent a questionnaire.
      expect(interviewPhase(v.readTextOrNull(INTERVIEW_PATH))).toBe('none');
      // Discovery comes before the plan: the heartbeat stopped at `discovery` and queued nothing later.
      expect(HEARTBEAT_STEPS[v.readNoteOrNull(`Jobs/${hbId}.md`)!.data.checkpoint_step as number]).toBe('discovery');
      expect(listJobs(v).some((j) => j.type === 'company.plan')).toBe(false);
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
      // It is a document, so discovery reads it rather than interviewing the owner about it.
      expect(interviewPhase(v.readTextOrNull(INTERVIEW_PATH))).toBe('none');
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
