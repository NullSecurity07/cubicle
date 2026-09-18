import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, createJob, updateJob, readJob, listInbox, loadOrg, officeHolder, INTERVIEW_PATH, interviewPhase, ownerInstruction, namesAFieldToEdit } from '@cubicle/core';
import type { Llm } from '@cubicle/harness';
import { Daemon, defaultConfig } from '../src/index.js';
import { answerOwnerMessages, unansweredOwnerMessages, completeIdeaLines, createHeartbeatJob, SURPRISE_FAILED, SURPRISE_RETRY_TOKENS } from '../src/heartbeat.js';
import { currentDiscoveryStatus, askInterview, captureInterviewAnswer, enqueueDiscovery } from '../src/discovery.js';
import { noLocalModel } from './helpers/no-local-model.js';
import WebSocket from 'ws';

/**
 * The first live run's defects, each pinned by the behaviour the owner saw (ledger
 * `sdd/2026-09-13-first-run-fixes/progress.md`):
 *
 * FR-1 the owner's follow-up went unanswered for a whole run because answering was a step of a heartbeat that
 *      was blocked on discovery, and the tick would not look while a heartbeat was open.
 * FR-2 the three-ideas reply was cut off mid-sentence and the half of it that arrived was filed as the
 *      proposal the owner was asked to pick from.
 * FR-3 discovery ran on the note that said "surprise me" and fabricated a founder brief out of nothing.
 * FR-6 the interview closed on whatever the owner said next, so a complaint would have become the six answers.
 */

const root = path.resolve(__dirname, '../../..');
let dir: string; let vault: Vault;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-first-run-fixes-'));
  vault = (await scaffoldVault(dir)).vault;
  noLocalModel(vault);
});
afterEach(() => { try { vault.close(); } catch { /* already closed */ } rmSync(dir, { recursive: true, force: true }); });

/** A model that says what the test told it to, in order, and echoes the prompt once the script runs out. */
function scriptedLlm(replies: (string | null)[] = []): Llm & { prompts: string[]; maxTokens: (number | undefined)[] } {
  const prompts: string[] = [];
  const maxTokens: (number | undefined)[] = [];
  return {
    prompts,
    maxTokens,
    async chat(_req, chat) {
      const user = String(chat.messages.at(-1)?.content ?? '');
      prompts.push(user);
      maxTokens.push(chat.maxTokens);
      const next = replies.length ? replies.shift() : user;
      return { content: next ?? '', toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 }, provider: 'fake', model: 'fake', tier: 'cheap', downgraded: false, parsedToolCalls: [] };
    },
    promptBudget: () => 6000,
  };
}

/** The same, but every answer waits on a gate the test opens: the window two callers used to overlap in. */
function heldLlm(): Llm & { prompts: string[]; release: () => void } {
  const prompts: string[] = [];
  let open: () => void = () => undefined;
  const gate = new Promise<void>((r) => { open = r; });
  return {
    prompts,
    release: () => open(),
    async chat(_req, chat) {
      prompts.push(String(chat.messages.at(-1)?.content ?? ''));
      await gate;
      return { content: 'Nothing is stuck: the research office is reading your material now.', toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 }, provider: 'fake', model: 'fake', tier: 'cheap', downgraded: false, parsedToolCalls: [] };
    },
    promptBudget: () => 6000,
  };
}

let msgSeq = 0;
/** One note in the cabin, exactly as the owner's window writes it: a `# title` line and their words. */
function ownerSays(v: Vault, text: string, at = '2026-09-13T09:00:00.000Z'): string {
  const id = `msg_own${++msgSeq}`;
  const p = `00 Inbox/${at.slice(0, 10)}-${id}.md`;
  v.writeText(p, `---\nid: ${id}\nkind: message\nfrom: owner\nto: ceo\ncreated: ${at}\n---\n# ${text.split('\n')[0].slice(0, 40)}\n\n${text}\n`, 'owner');
  return p;
}

/** Poll on real timers: these cases drive a live daemon and assert on what it has written. */
async function waitUntil(pred: () => boolean, what: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`waited ${ms} ms for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const ceoSection = (v: Vault, p: string) => (v.readNoteOrNull(p)!.body.split(/^## CEO\s*$/m)[1] ?? '').trim();

describe('FR-1: the owner is answered on the tick, whatever the heartbeat is doing', () => {
  it('answers a new message while the cycle is blocked on discovery, and answers nothing twice', async () => {
    // A company that has already run a cycle, so the startup trigger and the elapsed-hours trigger stay quiet
    // and the only heartbeat in the vault is the blocked one this test puts there.
    vault.events.emit({ type: 'heartbeat.completed', payload: { id: 'seed' } });
    // …and one that already has a name, so the follow-up is an ordinary question rather than the first idea.
    vault.updateNote('Brand/name.md', (n) => ({ data: { ...n.data, name: 'GreenCrate' }, body: n.body }), 'owner');
    vault.close();
    const llm = scriptedLlm(['Nothing is stuck: the research office is reading your material now.']);
    const d = new Daemon(
      defaultConfig(dir, { CUBICLE_MOCK_TOOLS: '1' } as NodeJS.ProcessEnv, {
        port: 0, tickMs: 60_000, maxConcurrentJobs: 1,
        heartbeat: { maxElapsedHours: 999, jobsCompletedN: Number.MAX_SAFE_INTEGER, startupAwayHours: 999 },
        providersPath: path.join(root, 'config/providers.yaml'), toolsPath: path.join(root, 'config/tools.yaml'),
      }),
      { llm, disableWs: true, disableSleepWatch: true, disablePantry: true, memory: false, log: () => undefined, closeDbOnStop: false },
    );
    await d.start();
    try {
      const v = d.vault;
      // The vault the owner was actually looking at: a discovery job being worked on, the cycle parked on it.
      const disc = createJob(v, { type: 'discovery', title: 'Read what the owner gave us', assigned: 'research_manager', priority: 1, goal: 'Read the material.' }, 'ceo');
      updateJob(v, disc, { status: 'running' }, 'research_manager');
      const hb = createHeartbeatJob(v, 'test');
      updateJob(v, hb, { status: 'blocked', blocked_on: { kind: 'job', id: disc, since: new Date().toISOString() } }, 'ceo');
      const note = ownerSays(v, 'Is anything actually happening? I have not heard from you.');

      await d.runTick('test');

      const after = v.readNoteOrNull(note)!;
      expect(after.data.answered).toBe(true);
      expect(after.body).toContain('## CEO');
      expect(ceoSection(v, note)).toContain('research office');
      // And the cycle is still parked exactly where it was: answering pre-empts nothing.
      expect(v.readNoteOrNull(`Jobs/${hb}.md`)!.data.status).toBe('blocked');

      const spokeOnce = v.events.query({ types: ['agent.spoke'] }).length;
      await d.runTick('test-2');
      expect(v.events.query({ types: ['agent.spoke'] }).length).toBe(spokeOnce);
      expect(unansweredOwnerMessages(v)).toEqual([]);
    } finally { await d.stop(); }
  }, 120_000);
});

describe('FR-1c: one note is answered once, whoever gets to it (review, Important 1)', () => {
  it('two answers racing on one note cost one model call, one reply and one ## CEO section', async () => {
    const p = ownerSays(vault, 'Is anything actually happening? I have not heard from you.');
    vault.updateNote('Brand/name.md', (n) => ({ data: { ...n.data, name: 'GreenCrate' }, body: n.body }), 'owner');
    const llm = heldLlm();

    // The reviewer's proof, verbatim: the note was read unanswered by both, and written by both, with a model
    // call in between. The claim is stamped between the read and the first `await`, so the second caller sees it.
    const both = Promise.all([
      answerOwnerMessages({ vault, llm }, vault, unansweredOwnerMessages(vault), { jobId: 'job_a' }),
      answerOwnerMessages({ vault, llm }, vault, unansweredOwnerMessages(vault), { jobId: 'job_b' }),
    ]);
    llm.release();
    const [a, b] = await both;

    expect(a + b).toBe(1);
    expect(llm.prompts.length).toBe(1);
    expect(vault.events.query({ types: ['agent.spoke'] }).length).toBe(1);
    expect(vault.readNoteOrNull(p)!.body.match(/^## CEO$/gm)!.length).toBe(1);
    // And the claim is gone, so nothing in the note says an answer is still on its way.
    expect(vault.readNoteOrNull(p)!.data.answering).toBeUndefined();
    expect(vault.readNoteOrNull(p)!.data.answered).toBe(true);
  });

  it('the heartbeat step finds the note claimed while the cabin is still waiting on the model', async () => {
    vault.events.emit({ type: 'heartbeat.completed', payload: { id: 'seed' } });
    vault.updateNote('Brand/name.md', (n) => ({ data: { ...n.data, name: 'GreenCrate' }, body: n.body }), 'owner');
    vault.close();
    const llm = heldLlm();
    const d = new Daemon(
      defaultConfig(dir, { CUBICLE_MOCK_TOOLS: '1' } as NodeJS.ProcessEnv, {
        port: 0, tickMs: 60_000, maxConcurrentJobs: 1,
        heartbeat: { maxElapsedHours: 999, jobsCompletedN: Number.MAX_SAFE_INTEGER, startupAwayHours: 999 },
        providersPath: path.join(root, 'config/providers.yaml'), toolsPath: path.join(root, 'config/tools.yaml'),
      }),
      { llm, disableWs: true, disableSleepWatch: true, disablePantry: true, memory: false, log: () => undefined, closeDbOnStop: false },
    );
    await d.start();
    try {
      const v = d.vault;
      // The cycle is parked, so nothing but this test drives the daemon: the point here is the step's code
      // racing the cabin, not a worker's timing.
      const disc = createJob(v, { type: 'discovery', title: 'Read what the owner gave us', assigned: 'research_manager', priority: 1, goal: 'Read the material.' }, 'ceo');
      updateJob(v, disc, { status: 'running' }, 'research_manager');
      const hb = createHeartbeatJob(v, 'owner message');
      updateJob(v, hb, { status: 'blocked', blocked_on: { kind: 'job', id: disc, since: new Date().toISOString() } }, 'ceo');
      const p = ownerSays(v, 'Is anything actually happening? I have not heard from you.');

      // The cabin starts a reply — a strong-tier call, 1–30 s in the owner's live run — and `onChat` asks for a
      // heartbeat in the same breath. `answer_owner` is step 3 of 13 with no model call ahead of it, so the
      // cycle reaches this note while the cabin is still waiting. This is that step's own code, called the way
      // the step calls it, and it is outside the daemon's lock: only the claim on the note stops it.
      const cabin = d.answerOwnerNow('chat');
      await waitUntil(() => llm.prompts.length === 1, 'the cabin to be waiting on the model');
      const step = await answerOwnerMessages({ vault: v, llm }, v, unansweredOwnerMessages(v), { jobId: hb });
      expect(step).toBe(0);
      expect(llm.prompts.length).toBe(1);

      llm.release();
      expect(await cabin).toBe(1);
      expect(v.events.query({ types: ['agent.spoke'] }).length).toBe(1);
      expect(v.readNoteOrNull(p)!.body.match(/^## CEO$/gm)!.length).toBe(1);
    } finally { llm.release(); await d.stop(); }
  }, 120_000);
});

describe('FR-1b: the cabin is answered even while a tick is in flight', () => {
  it('answers a chat the tick could not reach, and never answers it twice', async () => {
    vault.events.emit({ type: 'heartbeat.completed', payload: { id: 'seed' } });
    vault.updateNote('Brand/name.md', (n) => ({ data: { ...n.data, name: 'GreenCrate' }, body: n.body }), 'owner');
    vault.close();
    const llm = scriptedLlm();
    const d = new Daemon(
      // A minute between ticks: nothing but this test's own calls moves, so "the next tick would have got it
      // eventually" cannot rescue the assertion — which is the whole point. The ws is left on.
      defaultConfig(dir, { CUBICLE_MOCK_TOOLS: '1' } as NodeJS.ProcessEnv, {
        port: 0, tickMs: 60_000, maxConcurrentJobs: 1,
        heartbeat: { maxElapsedHours: 999, jobsCompletedN: Number.MAX_SAFE_INTEGER, startupAwayHours: 999 },
        providersPath: path.join(root, 'config/providers.yaml'), toolsPath: path.join(root, 'config/tools.yaml'),
      }),
      { llm, disableSleepWatch: true, disablePantry: true, memory: false, log: () => undefined, closeDbOnStop: false },
    );
    await d.start();
    let release = () => undefined as void;
    try {
      const v = d.vault;
      // A cycle parked on a discovery job, so `requestHeartbeat` on the chat finds an open heartbeat and no
      // worker runs a cycle underneath the assertions.
      const disc = createJob(v, { type: 'discovery', title: 'Read what the owner gave us', assigned: 'research_manager', priority: 1, goal: 'Read the material.' }, 'ceo');
      updateJob(v, disc, { status: 'running' }, 'research_manager');
      const hb = createHeartbeatJob(v, 'test');
      updateJob(v, hb, { status: 'blocked', blocked_on: { kind: 'job', id: disc, since: new Date().toISOString() } }, 'ceo');

      // Hold the tick at its first sweep. Any sweep before `answer-owner` would do; this is the earliest, and
      // holding it is exactly the window a chat used to fall into — `runTick` returns at once while one runs.
      let held = false;
      const gate = new Promise<void>((r) => { release = () => r(); });
      const sweep = (d as unknown as { sweep: (r: string, w: string, fn: () => unknown) => Promise<unknown> }).sweep;
      const original = sweep.bind(d);
      vi.spyOn(d as never, 'sweep' as never).mockImplementation((async (reason: string, where: string, fn: () => unknown) => {
        if (where === 'trust') { held = true; await gate; }
        return original(reason, where, fn);
      }) as never);

      const tick = d.runTick('held');
      await waitUntil(() => held, 'the tick to be holding');
      let tickDone = false;
      void tick.then(() => { tickDone = true; });

      // The window itself: a second tick does nothing at all while one is in flight.
      await d.runTick('chat');

      const port = d.config.port;
      const ws = new WebSocket(`ws://127.0.0.1:${port}?token=${d.ws!.token}`);
      await new Promise((r) => ws.once('open', r));
      ws.send(JSON.stringify({ op: 'chat', text: 'Is anything actually happening? I have not heard from you.' }));

      const chatNote = () => listInbox(v).find((n) => n.data.kind === 'message' && n.data.from === 'owner' && /anything actually happening/.test(n.body));
      await waitUntil(() => !!chatNote()?.data.answered, 'the cabin message to be answered');
      expect(tickDone).toBe(false);                       // and the tick that could not reach it is still held
      expect(chatNote()!.body).toContain('## CEO');

      const spokeOnce = v.events.query({ types: ['agent.spoke'] }).length;
      release();
      await tick;
      await d.runTick('after');
      expect(v.events.query({ types: ['agent.spoke'] }).length).toBe(spokeOnce);
      ws.close();
    } finally { release(); vi.restoreAllMocks(); await d.stop(); }
  }, 120_000);
});

describe('FR-2: three ideas, or an honest answer — never half of one', () => {
  const surprise = (v: Vault) => ownerSays(v, 'surprise me');

  it('re-asks once when the reply is cut off, and files the three whole ideas it gets back', async () => {
    const p = surprise(vault);
    // Exactly what the live run produced: two lines, the second one cut mid-sentence at the token ceiling.
    const llm = scriptedLlm([
      '1. GreenCrate — meal kits for nurseries.\n2. Deskless —',
      '1. GreenCrate — meal kits for nurseries.\n2. Deskless — shift scheduling for cafes.\n3. Tinyletter Co — a newsletter for allotment holders.',
    ]);
    const n = await answerOwnerMessages({ vault, llm }, vault, unansweredOwnerMessages(vault), { jobId: 'job_test' });

    expect(n).toBe(1);
    expect(llm.prompts.length).toBe(2);
    expect(llm.maxTokens[1]).toBe(SURPRISE_RETRY_TOKENS);
    const props = listInbox(vault).filter((x) => x.data.kind === 'brand_change');
    expect(props.length).toBe(1);
    expect(props[0].body.split('\n').filter((l) => /^\d+\.\s/.test(l)).length).toBe(3);
    expect(props[0].body).not.toContain('Deskless —\n');
    const reply = ceoSection(vault, p);
    expect(reply.split('\n').filter((l) => /^\d+\.\s/.test(l)).length).toBe(3);
    expect(reply).toContain('Tinyletter Co');
    // W5-3(a): the reply is a chat bubble in the office, beside three clickable cards and an Approve button.
    // It said "Pick one with `chosen:` and `approved: true`" — frontmatter, for a screen that has neither.
    expect(reply).toContain('Pick one in Decisions.');
    expect(reply).not.toMatch(/chosen:|approved: true|00 Inbox/);
    // …and so does the note (ruling W6-7, which took W5-3(a) the rest of the way). The note is read in the
    // office too — it *is* what the Decisions reader shows — so one helper writes the sentence for both.
    expect(props[0].body).toContain(ownerInstruction('brand_change'));
    expect(namesAFieldToEdit(props[0].body)).toBe(false);
  });

  it('files nothing and says so when two asks do not produce three ideas', async () => {
    const p = surprise(vault);
    const llm = scriptedLlm(['I cannot answer that.', '1. One — a thing.\n2. Two —']);
    const n = await answerOwnerMessages({ vault, llm }, vault, unansweredOwnerMessages(vault), { jobId: 'job_test' });

    expect(n).toBe(1);
    expect(listInbox(vault).filter((x) => x.data.kind === 'brand_change')).toEqual([]);
    expect(ceoSection(vault, p)).toBe(SURPRISE_FAILED);
    // Answered, so nobody asks the model a third time for the same message.
    expect(vault.readNoteOrNull(p)!.data.answered).toBe(true);
  });

  it('reads only the lines the model finished, and renumbers them for `chosen:`', () => {
    expect(completeIdeaLines(null)).toEqual([]);
    expect(completeIdeaLines('1. A — one.\n2. B —')).toEqual(['1. A — one.']);
    expect(completeIdeaLines('1. A — one.\n3. C — three.\n4. D — four.')).toEqual(['1. A — one.', '2. C — three.', '3. D — four.']);
    expect(completeIdeaLines('nothing numbered here')).toEqual([]);
  });
});

describe('FR-3: discovery never starts on a note that is only a reply to the CEO', () => {
  /** The vault straight after "surprise me": the CEO answered, and the three ideas are waiting to be picked. */
  function afterSurprise(v: Vault): void {
    v.writeText('00 Inbox/2026-09-13-msg-surprise.md', '---\nid: msg_sur\nkind: message\nfrom: owner\nto: ceo\ncreated: 2026-09-13T09:00:00.000Z\nanswered: true\n---\n# surprise me\n\nsurprise me\n\n## CEO\n\nI filed three ideas as a proposal in 00 Inbox/.\n', 'owner');
    v.writeText('00 Inbox/2026-09-13-prop-ideas.md', '---\nid: prop_ideas\nkind: brand_change\nfrom: ceo\ntarget: Brand/name.md\ncreated: 2026-09-13T09:00:01.000Z\napproved: null\n---\n# Three company ideas — pick one\n\n1. GreenCrate — meal kits for nurseries.\n2. Deskless — shift scheduling for cafes.\n3. Tinyletter Co — a newsletter for allotment holders.\n\nSet `chosen: 1|2|3` and `approved: true`.\n', 'ceo');
  }

  it('waits for the pick instead of researching the words "surprise me"', () => {
    afterSurprise(vault);
    const s = currentDiscoveryStatus(vault, new Date('2026-09-13T09:05:00.000Z'));
    expect(s.run).toBe(false);
    expect(s.why).toMatch(/pick one of the three ideas/);
  });

  // The live sequence, replayed (whole-branch review, Important 2): the owner asked to be surprised, the CEO
  // filed three ideas, and before picking one they complained about the CEO's truncated reply. Five words that
  // describe nothing bought a research lifecycle, while the pick that would have said what the company is sat
  // in the inbox.
  it('a complaint typed before the pick is not the company\'s material', async () => {
    afterSurprise(vault);
    await askInterview(vault, 'ceo', new Date('2026-09-13T09:03:00.000Z'));
    ownerSays(vault, 'your text i only hAlf', '2026-09-13T09:04:00.000Z');

    const waiting = currentDiscoveryStatus(vault, new Date('2026-09-13T09:05:00.000Z'));
    expect(waiting.run).toBe(false);
    expect(waiting.why).toMatch(/pick one of the three ideas/);

    vault.updateNote('00 Inbox/2026-09-13-prop-ideas.md', (n) => ({ data: { ...n.data, approved: true, chosen: 2 }, body: n.body }), 'owner');
    expect(currentDiscoveryStatus(vault, new Date('2026-09-13T09:06:00.000Z')).run).toBe(true);
  });

  it('reads the idea the moment the owner picks it', () => {
    afterSurprise(vault);
    vault.updateNote('00 Inbox/2026-09-13-prop-ideas.md', (n) => ({ data: { ...n.data, approved: true, chosen: 1 }, body: n.body }), 'owner');
    const s = currentDiscoveryStatus(vault, new Date('2026-09-13T09:06:00.000Z'));
    expect(s.run).toBe(true);
  });

  it('still runs on a real one-line idea, which is the documented path (spec §1.3, §5.5)', () => {
    ownerSays(vault, 'We sell meal kits to nurseries.');
    expect(currentDiscoveryStatus(vault, new Date('2026-09-13T09:05:00.000Z')).run).toBe(true);
  });

  it('does not read a company name nobody just chose as material', () => {
    // A scaffolded company that has always had a name: nothing was decided, so there is nothing new to read
    // and no discovery job. Only a name the owner *approved* is a pick.
    vault.updateNote('Brand/name.md', (n) => ({ data: { ...n.data, name: 'PlateReady' }, body: n.body }), 'owner');
    const s = currentDiscoveryStatus(vault, new Date('2026-09-13T09:05:00.000Z'));
    expect(s.run).toBe(false);
  });

  it('does not mistake the name proposal for an unpicked set of three ideas', () => {
    // The other `brand_change` on Brand/name.md: a name for an idea the owner typed, carrying a content fence.
    // Nobody is waiting on a pick here, and the checkpoint log must not say they are.
    ownerSays(vault, 'We sell meal kits to nurseries.');
    vault.writeText('00 Inbox/2026-09-13-prop-name.md', '---\nid: prop_name\nkind: brand_change\nfrom: ceo\ntarget: Brand/name.md\ncreated: 2026-09-13T09:00:01.000Z\napproved: null\n---\n# Name the company: GreenCrate\n\n## Proposed content\n\n```\n---\nname: "GreenCrate"\n---\n# GreenCrate\n```\n', 'ceo');
    const s = currentDiscoveryStatus(vault, new Date('2026-09-13T09:05:00.000Z'));
    expect(s.run).toBe(true);
    expect(s.why).not.toMatch(/pick one of the three/);
  });

  it('is unchanged by a skip: the interview closes and the company reads what it has', async () => {
    await askInterview(vault, 'ceo', new Date('2026-09-13T09:00:00.000Z'));
    ownerSays(vault, 'skip');
    expect(captureInterviewAnswer(vault, 'skip', new Date('2026-09-13T09:01:00.000Z'))).toBe(true);
    expect(interviewPhase(vault.readTextOrNull(INTERVIEW_PATH))).toBe('skipped');
    expect(currentDiscoveryStatus(vault, new Date('2026-09-13T09:05:00.000Z')).run).toBe(true);
  });
});

describe('FR-3b: the picked idea is the first thing the discovery job reads', () => {
  it('carries the chosen line into the job the research office is given', () => {
    vault.writeText('00 Inbox/2026-09-13-msg-surprise.md', '---\nid: msg_sur\nkind: message\nfrom: owner\nto: ceo\ncreated: 2026-09-13T09:00:00.000Z\nanswered: true\n---\n# surprise me\n\nsurprise me\n\n## CEO\n\nI filed three ideas as a proposal in 00 Inbox/.\n', 'owner');
    vault.writeText('00 Inbox/2026-09-13-prop-ideas.md', '---\nid: prop_ideas\nkind: brand_change\nfrom: ceo\ntarget: Brand/name.md\ncreated: 2026-09-13T09:00:01.000Z\napproved: true\nchosen: 2\n---\n# Three company ideas — pick one\n\n1. GreenCrate — meal kits for nurseries.\n2. Deskless — shift scheduling for cafes.\n3. Tinyletter Co — a newsletter for allotment holders.\n', 'ceo');

    const org = loadOrg(vault);
    const status = currentDiscoveryStatus(vault, new Date('2026-09-13T09:06:00.000Z'));
    expect(status.run).toBe(true);
    const id = enqueueDiscovery(vault, org, status)!;
    const job = readJob(vault, id)!;
    expect(job.data.assigned).toBe(officeHolder(org, 'research'));
    expect(job.body).toContain("The owner picked this idea from the CEO's three:");
    expect(job.body).toContain('Deskless — shift scheduling for cafes.');
    expect(job.body).not.toMatch(/surprise me/i);
  });
});

describe('FR-6: the interview stays open until the owner answers it', () => {
  const NOW = new Date('2026-09-13T09:00:00.000Z');

  it('a note to the CEO leaves the six open, and the reply says so', async () => {
    // A company that already has a name, so the note takes the general branch — which is where the owner was
    // when they wrote "your text is only half" on the first live run.
    vault.updateNote('Brand/name.md', (n) => ({ data: { ...n.data, name: 'GreenCrate' }, body: n.body }), 'owner');
    await askInterview(vault, 'ceo', NOW);
    const p = ownerSays(vault, 'your text is only half');
    const llm = scriptedLlm();                                  // echoes the prompt, so the reply carries the brief
    await answerOwnerMessages({ vault, llm }, vault, unansweredOwnerMessages(vault), { jobId: 'job_test' });

    expect(interviewPhase(vault.readTextOrNull(INTERVIEW_PATH))).toBe('asked');
    expect(vault.readText(INTERVIEW_PATH)).not.toContain('only half');
    expect(ceoSection(vault, p)).toMatch(/six founder questions[^]*still with them/);
  });

  it('an answer closes it, and so does a skip', async () => {
    await askInterview(vault, 'ceo', NOW);
    expect(captureInterviewAnswer(vault, 'Nurseries, not parents.\nTwo already pay us.\nTen in three months.', NOW)).toBe(true);
    expect(interviewPhase(vault.readTextOrNull(INTERVIEW_PATH))).toBe('answered');

    vault.writeText(INTERVIEW_PATH, '', 'daemon');
    await askInterview(vault, 'ceo', NOW);
    expect(captureInterviewAnswer(vault, 'skip', NOW)).toBe(true);
    expect(interviewPhase(vault.readTextOrNull(INTERVIEW_PATH))).toBe('skipped');
  });
});
