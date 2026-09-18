import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, createProposal, listInbox, INTERVIEW_PATH, INTERVIEW_QUESTIONS, interviewPhase, parseCeoAnswers, ceoAnswersFrom, interviewAnswersSection, CEO_UNKNOWN, type CeoAnswer } from '@cubicle/core';
import type { Llm } from '@cubicle/harness';
import { askInterview, currentDiscoveryStatus, selfInterviewSubject, awaitingSurprisePick } from '../src/discovery.js';
import { createHeartbeatJob, runHeartbeat, type HeartbeatDeps } from '../src/heartbeat.js';
import { noLocalModel } from './helpers/no-local-model.js';

/**
 * W5-1, from dry-run 3: **the CEO interviewed itself about a company nobody had proposed.**
 *
 * The owner clicked "surprise me" at 09:19:47. The three ideas were filed seven seconds later; the owner picked
 * one at 09:21:08. The self-interview ran at 09:20:00 — 68 seconds before the pick — with no idea to read, and
 * answered anyway: "an automated service that compiles local markdown folders into clean, self-hosted static
 * newsletters", tagged `[from the idea]`. No such idea was ever on the table.
 *
 * Two gates, because one of them was already open and the wrong answer still got through. The ask waits for the
 * pick, so the interview is about the idea the owner chose; and an answer may only be tagged `[from the idea]`
 * when there is an idea, so a model that invents one is not believed even if it is asked too early.
 */

const SIX = [
  '1. A weekly meal-kit box delivered to nurseries before seven. [from the idea]',
  '2. Independent nursery managers planning menus on a spreadsheet. [from the idea]',
  '3. Nothing exists yet. [from the vault]',
  '4. Ten paying nurseries inside three months. [from the idea]',
  '5. I do not know what has been tried. [unstated]',
  '6. Nothing is off the table. [unstated]',
].join('\n');

const THREE = ['1. GreenCrate — meal kits for nurseries.', '2. Deskless — shift scheduling for cafes.', '3. Tinyletter Co — a newsletter for allotment holders.'].join('\n');

let dir: string; let vault: Vault;
beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-interview-pick-'));
  vault = (await scaffoldVault(dir)).vault;
  noLocalModel(vault);
});
afterEach(() => { try { vault.close(); } catch { /* already closed */ } rmSync(dir, { recursive: true, force: true }); });

/** The vault the moment the CEO has answered "surprise me": three ideas filed, nobody has picked one. */
function afterSurprise(v: Vault): void {
  v.writeText('00 Inbox/2026-09-18-msg-surprise.md', '---\nid: msg_sur\nkind: message\nfrom: owner\nto: ceo\ncreated: 2026-09-18T09:19:47.000Z\nanswered: true\n---\n# surprise me\n\nsurprise me\n\n## CEO\n\nI filed three ideas as a proposal in 00 Inbox/.\n', 'owner');
  v.writeText('00 Inbox/2026-09-18-prop-ideas.md', `---\nid: prop_ideas\nkind: brand_change\nfrom: ceo\ntarget: Brand/name.md\ncreated: 2026-09-18T09:19:54.000Z\napproved: null\n---\n# Three company ideas — pick one\n\n${THREE}\n`, 'ceo');
}

/** The owner picks idea 2 from the sheet. */
function pickTwo(v: Vault): void {
  v.updateNote('00 Inbox/2026-09-18-prop-ideas.md', (n) => ({ data: { ...n.data, approved: true, chosen: 2 }, body: n.body }), 'owner');
}

/** A model that records every prompt it is handed and always answers with the six. */
function recorder(): { llm: Llm; prompts: string[] } {
  const prompts: string[] = [];
  const llm = {
    async chat(req: { tier: string }, chat: { messages: { content: string }[] }) {
      prompts.push(String(chat.messages.at(-1)?.content ?? ''));
      return { content: SIX, toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 5, completion_tokens: 5 }, provider: 'fake', model: 'fake', tier: 'strong' as const, downgraded: false, parsedToolCalls: [] };
    },
  } as unknown as Llm;
  return { llm, prompts };
}

const selfInterviewPrompts = (prompts: string[]): string[] => prompts.filter((p) => p.includes('You are answering the founder interview'));

describe('W5-1: the six are asked about the idea the owner picked, never before there is one', () => {
  it('does not ask while the owner has asked to be surprised and has not picked yet', async () => {
    afterSurprise(vault);
    expect(awaitingSurprisePick(vault)).toBe(true);

    const s = currentDiscoveryStatus(vault, new Date('2026-09-18T09:20:00.000Z'));
    expect(s.ask).toBe(false);
    expect(s.why).toMatch(/pick/i);

    const { llm, prompts } = recorder();
    const deps: HeartbeatDeps = { vault, llm, now: () => new Date('2026-09-18T09:20:00.000Z') };
    await runHeartbeat(deps, createHeartbeatJob(vault, 'test'));

    expect(selfInterviewPrompts(prompts)).toEqual([]);
    expect(interviewPhase(vault.readTextOrNull(INTERVIEW_PATH))).toBe('none');
    expect(listInbox(vault).some((n) => INTERVIEW_QUESTIONS.every((q) => n.body.includes(q)))).toBe(false);
  });

  it('asks on the cycle after the pick, about the idea that was picked', async () => {
    afterSurprise(vault);
    pickTwo(vault);
    expect(awaitingSurprisePick(vault)).toBe(false);
    expect(currentDiscoveryStatus(vault, new Date('2026-09-18T09:21:08.000Z')).ask).toBe(true);
    expect(selfInterviewSubject(vault).idea).toContain('Deskless — shift scheduling for cafes.');

    const { llm, prompts } = recorder();
    const deps: HeartbeatDeps = { vault, llm, now: () => new Date('2026-09-18T09:21:08.000Z') };
    await runHeartbeat(deps, createHeartbeatJob(vault, 'test'));

    const asked = selfInterviewPrompts(prompts);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('Deskless — shift scheduling for cafes.');
    expect(asked[0]).not.toContain('nothing has been written down yet');
    expect(interviewPhase(vault.readTextOrNull(INTERVIEW_PATH))).toBe('asked');
  });

  it('asks at once for an idea the owner typed themselves — the documented path is untouched', async () => {
    createProposal(vault, { kind: 'message', from: 'owner', to: 'ceo', title: 'The idea', body: 'A weekly meal-kit box delivered to nurseries before seven in the morning.', answered: true }, 'owner');
    expect(awaitingSurprisePick(vault)).toBe(false);
    expect(currentDiscoveryStatus(vault, new Date('2026-09-18T09:20:00.000Z')).ask).toBe(true);

    const { llm, prompts } = recorder();
    const deps: HeartbeatDeps = { vault, llm, now: () => new Date('2026-09-18T09:20:00.000Z') };
    await runHeartbeat(deps, createHeartbeatJob(vault, 'test'));

    const asked = selfInterviewPrompts(prompts);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('A weekly meal-kit box delivered to nurseries before seven in the morning.');
    expect(interviewPhase(vault.readTextOrNull(INTERVIEW_PATH))).toBe('asked');
  });

  it('refuses "[from the idea]" when there is no idea: the citation would be false', async () => {
    // Asked with nothing to read — the state dry-run 3 caught. Every claim the model tagged against an idea it
    // does not have comes back as the answer the CEO is allowed to give: it does not know.
    const answers: CeoAnswer[] = parseCeoAnswers(SIX, INTERVIEW_QUESTIONS.length);
    expect(answers.filter((a) => a.tag === 'from the idea')).toHaveLength(3);

    expect(selfInterviewSubject(vault).idea).toBe('');
    const id = await askInterview(vault, 'ceo', new Date('2026-09-18T09:20:00.000Z'), async (qs) => parseCeoAnswers(SIX, qs.length));
    expect(id).toBeTruthy();

    const written = ceoAnswersFrom(interviewAnswersSection(vault.readText(INTERVIEW_PATH)));
    expect(written.some((a) => a.tag === 'from the idea')).toBe(false);
    expect(written.filter((a) => a.text === CEO_UNKNOWN)).toHaveLength(3);
    // What *is* grounded survives: the vault answer and the two honest "I do not know"s are untouched.
    expect(written[2]).toEqual({ text: 'Nothing exists yet.', tag: 'from the vault' });
    expect(written[4].tag).toBe('unstated');
    expect(vault.readText(INTERVIEW_PATH)).not.toContain('meal-kit box delivered to nurseries');
  });
});
