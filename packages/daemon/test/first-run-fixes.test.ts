import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, createJob, updateJob, listInbox, INTERVIEW_PATH, interviewPhase } from '@cubicle/core';
import type { Llm } from '@cubicle/harness';
import { Daemon, defaultConfig } from '../src/index.js';
import { answerOwnerMessages, unansweredOwnerMessages, completeIdeaLines, createHeartbeatJob, SURPRISE_FAILED, SURPRISE_RETRY_TOKENS } from '../src/heartbeat.js';
import { currentDiscoveryStatus, askInterview, captureInterviewAnswer } from '../src/discovery.js';
import { noLocalModel } from './helpers/no-local-model.js';

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

let msgSeq = 0;
/** One note in the cabin, exactly as the owner's window writes it: a `# title` line and their words. */
function ownerSays(v: Vault, text: string, at = '2026-09-13T09:00:00.000Z'): string {
  const id = `msg_own${++msgSeq}`;
  const p = `00 Inbox/${at.slice(0, 10)}-${id}.md`;
  v.writeText(p, `---\nid: ${id}\nkind: message\nfrom: owner\nto: ceo\ncreated: ${at}\n---\n# ${text.split('\n')[0].slice(0, 40)}\n\n${text}\n`, 'owner');
  return p;
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

  it('is unchanged by a skip: the interview closes and the company reads what it has', () => {
    askInterview(vault, 'ceo', new Date('2026-09-13T09:00:00.000Z'));
    ownerSays(vault, 'skip');
    expect(captureInterviewAnswer(vault, 'skip', new Date('2026-09-13T09:01:00.000Z'))).toBe(true);
    expect(interviewPhase(vault.readTextOrNull(INTERVIEW_PATH))).toBe('skipped');
    expect(currentDiscoveryStatus(vault, new Date('2026-09-13T09:05:00.000Z')).run).toBe(true);
  });
});

describe('FR-6: the interview stays open until the owner answers it', () => {
  const NOW = new Date('2026-09-13T09:00:00.000Z');

  it('a note to the CEO leaves the six open, and the reply says so', async () => {
    // A company that already has a name, so the note takes the general branch — which is where the owner was
    // when they wrote "your text is only half" on the first live run.
    vault.updateNote('Brand/name.md', (n) => ({ data: { ...n.data, name: 'GreenCrate' }, body: n.body }), 'owner');
    askInterview(vault, 'ceo', NOW);
    const p = ownerSays(vault, 'your text is only half');
    const llm = scriptedLlm();                                  // echoes the prompt, so the reply carries the brief
    await answerOwnerMessages({ vault, llm }, vault, unansweredOwnerMessages(vault), { jobId: 'job_test' });

    expect(interviewPhase(vault.readTextOrNull(INTERVIEW_PATH))).toBe('asked');
    expect(vault.readText(INTERVIEW_PATH)).not.toContain('only half');
    expect(ceoSection(vault, p)).toMatch(/six questions[^]*still open/);
  });

  it('an answer closes it, and so does a skip', () => {
    askInterview(vault, 'ceo', NOW);
    expect(captureInterviewAnswer(vault, 'Nurseries, not parents.\nTwo already pay us.\nTen in three months.', NOW)).toBe(true);
    expect(interviewPhase(vault.readTextOrNull(INTERVIEW_PATH))).toBe('answered');

    vault.writeText(INTERVIEW_PATH, '', 'daemon');
    askInterview(vault, 'ceo', NOW);
    expect(captureInterviewAnswer(vault, 'skip', NOW)).toBe(true);
    expect(interviewPhase(vault.readTextOrNull(INTERVIEW_PATH))).toBe('skipped');
  });
});
