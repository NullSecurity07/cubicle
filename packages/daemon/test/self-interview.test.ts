import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  scaffoldVault, Vault, createProposal, listInbox, loadOrg, officeHolder, founderBriefTemplate,
  INTERVIEW_PATH, FOUNDER_BRIEF, INTERVIEW_QUESTIONS, INTERVIEW_TAG_LEGEND,
  interviewPhase, interviewAnswer, interviewAnswersSection, ownerAnsweredInterview,
  briefCheckContext, parseCeoAnswers, ceoAnswersFrom, CEO_UNKNOWN, type CeoAnswer,
} from '@cubicle/core';
import type { Llm } from '@cubicle/harness';
import { askInterview, captureInterviewAnswer, selfInterviewSubject, selfInterviewPrompt, interviewMessageId, discoveryGoal, enqueueDiscovery, currentDiscoveryStatus } from '../src/discovery.js';
import { createHeartbeatJob, runHeartbeat, SELF_INTERVIEW_TOKENS, type HeartbeatDeps } from '../src/heartbeat.js';
import { noLocalModel } from './helpers/no-local-model.js';

/**
 * Ruling P8-13: **the interview is a self-interview first.**
 *
 * The owner's complaint, from the live run: after "surprise me" and a pick, the CEO put the six founder
 * questions to them — for an idea the company had invented. "Isn't this the CEO's job to answer; I should be
 * able to look at the convo it has answering this and add things, not be the one answering."
 *
 * So the CEO answers the six itself in one call, every answer tagged with what it rests on, and the owner's
 * next message is an *addition* to those answers — or "go", or "skip". These cases pin each of those, and the
 * one that matters most: what the founder brief is allowed to claim about whose words they are.
 */

const SIX = [
  '1. A weekly meal-kit box delivered to nurseries before seven. [from the idea]',
  '2. Independent nursery managers; today they plan menus on a shared spreadsheet. [from the vault]',
  '3. Nothing exists yet beyond the idea itself. [unstated]',
  '4. Ten paying nurseries inside three months. [from the idea]',
  '5. I do not know what has been tried before.',
  '6. Nothing has been put off the table. [unstated]',
].join('\n');

let dir: string; let vault: Vault;
beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-self-interview-'));
  vault = (await scaffoldVault(dir)).vault;
  noLocalModel(vault);
});
afterEach(() => { try { vault.close(); } catch { /* already closed */ } rmSync(dir, { recursive: true, force: true }); });

/** The self-interview callback `askInterview` takes, scripted: one raw model reply, parsed the way the daemon does. */
const scripted = (raw: string | null) => async (qs: readonly string[]): Promise<CeoAnswer[]> => parseCeoAnswers(raw, qs.length);

const message = (id: string | null) => listInbox(vault).find((n) => n.data.id === id)!;

describe('the CEO answers the six itself, and the owner adds to them (ruling P8-13)', () => {
  it('writes six tagged answers into the transcript and puts them in the owner\'s thread', async () => {
    const id = await askInterview(vault, 'ceo', new Date('2026-09-13T09:00:00.000Z'), scripted(SIX));
    expect(id).toBeTruthy();

    const t = vault.readText(INTERVIEW_PATH);
    expect(interviewPhase(t)).toBe('asked');
    const answers = ceoAnswersFrom(interviewAnswersSection(t));
    expect(answers.map((a) => a.tag)).toEqual(['from the idea', 'from the vault', 'unstated', 'from the idea', 'unstated', 'unstated']);
    expect(answers[0].text).toBe('A weekly meal-kit box delivered to nurseries before seven.');
    // An answer the model left untagged is `unstated`, never quietly promoted to a claim.
    expect(answers[4]).toEqual({ text: 'I do not know what has been tried before.', tag: 'unstated' });
    expect(t).toContain(INTERVIEW_TAG_LEGEND);

    // And the same six reach the owner, in the owner's own thread, as a message from the CEO.
    const msg = message(id);
    expect(msg.data.kind).toBe('message');
    expect(msg.data.from).toBe('ceo');
    expect(msg.data.to).toBe('owner');
    expect(msg.body).toContain('Here is how I would answer these six from what I have — add anything, correct me, or say go.');
    expect(msg.body).toContain('**CEO:** A weekly meal-kit box delivered to nurseries before seven. [from the idea]');
    expect(msg.body).toContain('A question to me leaves this open.');
    for (const q of INTERVIEW_QUESTIONS) expect(msg.body).toContain(q);
    // The resume path reads them back off that message rather than asking a second time.
    expect(ceoAnswersFrom(msg.body)).toEqual(answers);
  });

  it('the ask still goes out with no model at all: six unstated answers, and nothing invented', async () => {
    const id = await askInterview(vault, 'ceo', new Date('2026-09-13T09:00:00.000Z'), scripted(null));
    expect(id).toBeTruthy();
    const answers = ceoAnswersFrom(interviewAnswersSection(vault.readText(INTERVIEW_PATH)));
    expect(answers).toHaveLength(6);
    expect(answers.every((a) => a.tag === 'unstated' && a.text === CEO_UNKNOWN)).toBe(true);
    expect(message(id).body).toContain('[unstated]');
  });

  it('a self-interview that throws is a worse interview, never a missing one', async () => {
    const id = await askInterview(vault, 'ceo', new Date('2026-09-13T09:00:00.000Z'), async () => { throw new Error('no strong tier today'); });
    expect(id).toBeTruthy();
    expect(interviewPhase(vault.readTextOrNull(INTERVIEW_PATH))).toBe('asked');
    expect(ceoAnswersFrom(interviewAnswersSection(vault.readText(INTERVIEW_PATH))).every((a) => a.tag === 'unstated')).toBe(true);
  });

  it('"go" closes it with no words put in the owner\'s mouth, and the brief may say they endorsed it', async () => {
    await askInterview(vault, 'ceo', new Date('2026-09-13T09:00:00.000Z'), scripted(SIX));
    expect(briefCheckContext(vault).interviewAnswered).toBe(false);        // the CEO's answers are not theirs

    expect(captureInterviewAnswer(vault, 'go', new Date('2026-09-13T10:00:00.000Z'))).toBe(true);
    const t = vault.readText(INTERVIEW_PATH);
    expect(interviewPhase(t)).toBe('answered');
    expect(/^\*\*You:\*\*/m.test(t)).toBe(false);                          // no invented owner line
    expect(interviewAnswer(t)).toBe('');
    expect(t).toContain('said go');
    expect(t).toContain('**CEO:** A weekly meal-kit box delivered to nurseries before seven. [from the idea]');
    expect(briefCheckContext(vault).interviewAnswered).toBe(true);
  });

  it('an addition is appended under the answers, never over them', async () => {
    await askInterview(vault, 'ceo', new Date('2026-09-13T09:00:00.000Z'), scripted(SIX));
    expect(captureInterviewAnswer(vault, 'Nurseries, not parents.\nTwo of them already pay us.', new Date('2026-09-13T10:00:00.000Z'))).toBe(true);
    const t = vault.readText(INTERVIEW_PATH);
    expect(interviewPhase(t)).toBe('answered');
    expect(ownerAnsweredInterview(t)).toBe(true);
    expect(t).toContain('**You:** Nurseries, not parents.');
    expect(t).toContain('**CEO:** Independent nursery managers; today they plan menus on a shared spreadsheet. [from the vault]');
    expect(interviewAnswer(t)).toBe('Nurseries, not parents.\nTwo of them already pay us.');
    // Both halves are what discovery reads, with the tags kept.
    const material = interviewAnswersSection(t);
    expect(material).toContain('[from the idea]');
    expect(material).toContain('**You:** Nurseries, not parents.');
  });

  it('a question leaves it open, and a skip closes it without an addition', async () => {
    await askInterview(vault, 'ceo', new Date('2026-09-13T09:00:00.000Z'), scripted(SIX));
    expect(captureInterviewAnswer(vault, 'What is the research office going to do with this?', new Date())).toBe(false);
    expect(interviewPhase(vault.readTextOrNull(INTERVIEW_PATH))).toBe('asked');
    expect(vault.readText(INTERVIEW_PATH)).not.toContain('research office');

    expect(captureInterviewAnswer(vault, 'skip', new Date('2026-09-13T10:00:00.000Z'))).toBe(true);
    const t = vault.readText(INTERVIEW_PATH);
    expect(interviewPhase(t)).toBe('skipped');
    expect(briefCheckContext(vault).interviewAnswered).toBe(false);
    expect(t).toContain('**CEO:**');                                       // the CEO's reading survives the skip
  });

  it('the prompt is about the idea the owner picked, and the goal carries the tag legend', async () => {
    vault.writeText('00 Inbox/2026-09-13-prop-ideas.md', ['---', 'id: prop_ideas', 'kind: brand_change', 'from: ceo', 'target: Brand/name.md', 'created: 2026-09-13T09:00:00.000Z', 'approved: true', 'chosen: 2', '---', '# Three company ideas — pick one', '', '1. GreenCrate — meal kits for nurseries.', '2. Deskless — shift scheduling for cafes.', '3. Tinyletter Co — a newsletter for allotment holders.', ''].join('\n'), 'ceo');
    const subject = selfInterviewSubject(vault);
    expect(subject.idea).toContain('2. Deskless — shift scheduling for cafes.');
    expect(subject.brand).toBe('');
    const prompt = selfInterviewPrompt({ ...subject, questions: INTERVIEW_QUESTIONS });
    expect(prompt).toContain('Deskless — shift scheduling for cafes.');
    expect(prompt).toContain('[from the idea]');
    expect(prompt).toContain('[unstated]');
    expect(prompt).toContain('none yet');                                  // Brand/name.md carries no name
    for (const q of INTERVIEW_QUESTIONS) expect(prompt).toContain(q);

    const goal = discoveryGoal({ founderBrief: FOUNDER_BRIEF, briefTemplate: founderBriefTemplate(), hasBrief: false, research: 'ceo', pick: null });
    expect(goal).toContain(INTERVIEW_TAG_LEGEND);
    expect(goal).toContain('never write "the owner said" over an answer the CEO wrote');
  });
});

describe('the cycle that asks pays for exactly one self-interview call', () => {
  it('answers the six from the owner\'s line, in one strong-tier call, and files the message', async () => {
    const prompts: string[] = [];
    const tiers: string[] = [];
    const tokens: (number | undefined)[] = [];
    const llm = {
      async chat(req: { tier: string }, chat: { messages: { content: string }[]; maxTokens?: number }) {
        prompts.push(String(chat.messages.at(-1)?.content ?? ''));
        tiers.push(req.tier);
        tokens.push(chat.maxTokens);
        return { content: SIX, toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 5, completion_tokens: 5 }, provider: 'fake', model: 'fake', tier: 'strong' as const, downgraded: false, parsedToolCalls: [] };
      },
    } as unknown as Llm;
    createProposal(vault, { kind: 'message', from: 'owner', to: 'ceo', title: 'The idea', body: 'A weekly meal-kit box delivered to nurseries before seven in the morning.', answered: true }, 'owner');

    const deps: HeartbeatDeps = { vault, llm, now: () => new Date('2026-09-13T09:00:00.000Z') };
    const id = createHeartbeatJob(vault, 'test');
    expect((await runHeartbeat(deps, id)).status).toBe('blocked');          // parked on the discovery job

    const selfInterview = prompts.filter((p) => p.includes('You are answering the founder interview'));
    expect(selfInterview).toHaveLength(1);
    expect(selfInterview[0]).toContain('A weekly meal-kit box delivered to nurseries before seven in the morning.');
    expect(tiers.every((t) => t === 'strong')).toBe(true);
    expect(tokens).toContain(SELF_INTERVIEW_TOKENS);

    const msg = message(interviewMessageId(officeHolder(loadOrg(vault), 'chief_executive')));
    expect(msg.body).toContain('**CEO:** A weekly meal-kit box delivered to nurseries before seven. [from the idea]');
    expect(interviewPhase(vault.readTextOrNull(INTERVIEW_PATH))).toBe('asked');
    // And the job that reads it is queued in the same cycle, as it always was.
    expect(enqueueDiscovery(vault, loadOrg(vault), currentDiscoveryStatus(vault))).toBeNull();   // already queued
  });
});
