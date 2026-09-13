import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  scaffoldVault, Vault, loadOrg, listInbox, listJobs, readIdea, writeIdeaCard, updateIdea, createProposal,
  officeHolder, parseNote, PRESSURE_PARTS, OWNER_QUESTION, isOwnerQuestion, hedges, BANNED_HEDGE,
} from '@cubicle/core';
import {
  runBoardSession, runHeartbeat, createHeartbeatJob,
  BOARD_DIALOGUE_MAX_CALLS, BOARD_DIALOGUE_ROUNDS, BOARD_OPEN_QUESTIONS, boardSubjectKey,
  challengeReason, findingIn, questionIn, parseFindingsSection, ownerSpokeSince, partsText,
} from '../src/index.js';
import { orgLlm } from '../../../scripts/lib/org-llm.js';
import { holdTheBriefBoard, letTheBoardDecide } from './helpers/board-switch.js';
import { adoptFounderBrief } from './helpers/brief.js';

let dir: string;
let vault: Vault;
beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-sp8-board-'));
  vault = (await scaffoldVault(dir)).vault;
  adoptFounderBrief(vault);
});
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

const IDEA = { kind: 'idea' as const, text: '# Meal kits for nurseries\n\nTwo nurseries pay weekly.', title: 'Meal kits for nurseries', slug: 'meal-kits' };
const PLAN = '# Plan\n\n## Objectives\n\n### dev\n- Scaffold the site\n';

/** A card both offices have answered, so `nextIdeaForBoard` hands it to the board. */
function scoredCard(v: Vault, title: string): string {
  const slug = writeIdeaCard(v, { title, source: 'discovery', evidence: ['the owner asked for it'] }, 'daemon');
  updateIdea(v, slug, { score_inputs: { value: 5, evidence: 4, effort: 4, fit: 5 }, research: `Research/${slug}/report.md`, research_confidence: 'medium', estimate: 'Two weeks of one engineer.' }, 'daemon');
  return slug;
}

/**
 * A model that answers the dialogue's prompts turn by turn, counting its calls, and that can be told to leave
 * one round unanswerable — the case where the board must ask the owner rather than guess.
 */
function dialogueLlm(opts: { unanswerable?: string; hedgeOnce?: boolean } = {}): { chat: (r: unknown, c: { messages: { content: string }[]; maxTokens?: number }) => Promise<unknown>; promptBudget: () => number; prompts: { roleId: string; tier: string; text: string; maxTokens: number }[] } {
  const prompts: { roleId: string; tier: string; text: string; maxTokens: number }[] = [];
  let hedged = false;
  return {
    prompts,
    promptBudget: () => 6000,
    async chat(req: unknown, chat: { messages: { content: string }[]; maxTokens?: number }) {
      const r = req as { roleId?: string; tier?: string };
      const last = String(chat.messages.at(-1)?.content ?? '');
      prompts.push({ roleId: r.roleId ?? '?', tier: r.tier ?? '?', text: last, maxTokens: chat.maxTokens ?? 0 });
      const reply = (content: string) => ({ content, toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 }, provider: 'f', model: 'f', tier: 'medium' as const, downgraded: false, parsedToolCalls: [] });
      if (/^You chair the board of this company\./.test(last)) {
        const close = last.match(/close the round on \*\*([^*]+)\*\*/)?.[1] ?? '';
        const open = last.match(/the question of \*\*([^*]+)\*\*/)?.[1] ?? '';
        const finding = !close ? ''
          : close === opts.unanswerable ? `${OWNER_QUESTION} what have you actually run before?\n\n`
          : close === 'Three Fatal Flaws' ? 'FINDING: three ways this dies\n- nobody has priced the 7am van\n\n'
          : `FINDING: the board holds ${close} answered — ${close.toLowerCase()} is settled.\n\n`;
        if (/VERDICT: STRONG or WEAK or PIVOT REQUIRED/.test(last)) {
          if (opts.hedgeOnce && !hedged) { hedged = true; return reply(`${finding}VERDICT: STRONG\n${BANNED_HEDGE} the margins worry me.`); }
          return reply(`${finding}VERDICT: STRONG\nRUBRIC: core assumption 2, fatal flaws 1, pain 2, founder fit 1, why now 1`);
        }
        if (/First line exactly "VERDICT: pass"/.test(last)) return reply(`${finding}VERDICT: pass\n- watch the free tier`);
        return reply(`${finding}NEXT: On ${open}: what does this rest on?`);
      }
      if (/That answer was not usable/.test(last)) return reply('VERDICT: STRONG\nRUBRIC: core assumption 2, fatal flaws 1, pain 2, founder fit 1, why now 1');
      if (/The chair has asked, on \*\*/.test(last)) return reply('Two nurseries already pay a caterer every term; nobody has quoted the 7am van.');
      // The brief session's own two prompts, so the same fake can be pointed at either path and the comparison
      // between them is a comparison of the sessions rather than of two different scripts.
      if (/Merge them into ONE verdict/.test(last)) return reply('VERDICT: STRONG\nRUBRIC: core assumption 2, fatal flaws 1, pain 2, founder fit 1, why now 1\n\n## Three Fatal Flaws\n- nobody has priced the 7am van');
      if (/Pressure test it the way Paul Graham/.test(last)) return reply('1. Core Assumption — they will pay weekly.\n5. Brutal Verdict — STRONG.');
      return reply('ok');
    },
  };
}

describe('the constitution switch (SP8 §3, task 1)', () => {
  it('defaults to full, and a scaffolded vault says so in its own yaml', () => {
    expect(vault.constitution().board_dialogue).toBe('full');
    expect(vault.readText('Memory/constitution.md')).toMatch(/^board_dialogue: full$/m);
  });

  it('brief runs the old four-call session, with nothing written to Meetings/', async () => {
    holdTheBriefBoard(vault);
    expect(vault.constitution().board_dialogue).toBe('brief');
    const llm = dialogueLlm();
    const session = await runBoardSession({ vault, llm: llm as never }, loadOrg(vault), IDEA);
    expect(session.calls).toBe(4);
    expect(session.notePath).toBe('');
    expect(session.questions).toEqual([]);
    expect(vault.list('Meetings', { ext: '.md' })).toEqual([]);
    // …and it is the old prompts that were sent, not the dialogue's.
    expect(llm.prompts.some((p) => /Pressure test it the way Paul Graham/.test(p.text))).toBe(true);
    expect(llm.prompts.some((p) => /^You chair the board of this company\./.test(p.text))).toBe(false);
  });

});

describe('a full idea session is six rounds the owner can read (SP8 §3, task 2)', () => {
  it('writes the note in the meeting.open shape, six rounds deep, inside the call budget', async () => {
    const llm = dialogueLlm();
    const org = loadOrg(vault);
    const session = await runBoardSession({ vault, llm: llm as never }, org, IDEA);

    expect(session.calls).toBeLessThanOrEqual(BOARD_DIALOGUE_MAX_CALLS);
    expect(session.calls).toBe(PRESSURE_PARTS.length * 2 + BOARD_DIALOGUE_ROUNDS);
    expect(session.reasked).toBe(false);
    expect(session.pressure).toBe('STRONG');
    expect(session.rubric).toEqual({ core_assumption: 2, fatal_flaws: 1, pain: 2, founder_fit: 1, why_now: 1 });
    expect(session.verdict).toBe('pass');

    // The note: where `runBoardSession` said it was, in the shape the meeting tool writes and the conversations
    // index parses — frontmatter, `## Transcript`, `**Round N — <role>:**` per turn.
    expect(session.notePath).toMatch(/^Meetings\/.*-board-meal-kits\.md$/);
    const note = parseNote(vault.readText(session.notePath));
    expect(note.data.room).toBe('board');
    expect(note.data.facilitator).toBe(org.teams.board!.lead);
    expect(note.data.status).toBe('done');
    expect(note.data.participants).toEqual(session.advisors);
    expect(note.data.calls).toBe(session.calls);
    expect(String(note.data.opened)).toMatch(/^\d{4}-/);
    expect(note.body).toContain('## Transcript');

    const rounds = [...note.body.matchAll(/^\*\*Round (\d+) — ([a-z_]+):\*\*/gm)];
    expect(new Set(rounds.map((m) => m[1])).size).toBe(BOARD_DIALOGUE_ROUNDS);
    expect(Math.max(...rounds.map((m) => Number(m[1])))).toBe(BOARD_DIALOGUE_ROUNDS);
    // Each of the five argued rounds is the chair and then the two other advisors, in turn.
    const chair = org.teams.board!.lead;
    const others = session.advisors.filter((a) => a !== chair);
    for (let r = 1; r <= PRESSURE_PARTS.length; r++) {
      expect(rounds.filter((m) => Number(m[1]) === r).map((m) => m[2])).toEqual([chair, ...others]);
    }
    // …and round six is the chair alone, with the verdict on it.
    expect(rounds.filter((m) => Number(m[1]) === BOARD_DIALOGUE_ROUNDS).map((m) => m[2])).toEqual([chair]);
    expect(note.body).toContain('VERDICT: STRONG');

    // The five parts the owner reads are the round findings, one per part.
    for (const part of PRESSURE_PARTS) expect(session.chairText).toContain(`## ${part}`);
    expect(parseFindingsSection(note.body)['Core Assumption']).toContain('Core Assumption answered');
    expect(session.findings).toContain('nobody has priced the 7am van');
    expect(session.questions).toEqual([]);
  }, 30000);

  it('every turn is emitted as it happens, capped at 280 characters, between opened and closed', async () => {
    const llm = dialogueLlm();
    const session = await runBoardSession({ vault, llm: llm as never }, loadOrg(vault), IDEA);
    const opened = vault.events.query({ types: ['meeting.opened'] }).at(-1)!;
    const turns = vault.events.query({ types: ['meeting.turn'] });
    const closed = vault.events.query({ types: ['meeting.closed'] }).at(-1)!;
    expect(opened.payload.id).toBe(closed.payload.id);
    expect(opened.payload.room).toBe('board');
    expect(opened.payload.path).toBe(session.notePath);
    expect(turns.length).toBe(PRESSURE_PARTS.length * 3 + 1);
    expect(turns.every((e) => e.payload.id === opened.payload.id)).toBe(true);
    expect(turns.every((e) => String(e.payload.text).length <= 280)).toBe(true);
    expect(turns.every((e) => Number(e.payload.round) >= 1 && Number(e.payload.round) <= BOARD_DIALOGUE_ROUNDS)).toBe(true);
    expect(closed.payload.verdict).toBe('pass');
    expect(closed.payload.pressure).toBe('STRONG');
  }, 30000);

  it('holds the whole session on the advisors\' own charter tier, never the strong one', async () => {
    const llm = dialogueLlm();
    await runBoardSession({ vault, llm: llm as never }, loadOrg(vault), IDEA);
    expect(llm.prompts.every((p) => p.tier === 'medium')).toBe(true);
    expect(new Set(llm.prompts.map((p) => p.roleId))).toEqual(new Set(['advisor_skeptic', 'advisor_investor', 'advisor_customer']));
  }, 30000);

  it('a chair that hedges is re-asked once, and the session still fits the budget', async () => {
    const llm = dialogueLlm({ hedgeOnce: true });
    const session = await runBoardSession({ vault, llm: llm as never }, loadOrg(vault), IDEA);
    expect(session.reasked).toBe(true);
    expect(session.calls).toBe(BOARD_DIALOGUE_MAX_CALLS);
    expect(session.pressure).toBe('STRONG');
  }, 30000);

  it('a plan session seats the CEO with the advisors', async () => {
    const llm = dialogueLlm();
    const org = loadOrg(vault);
    const session = await runBoardSession({ vault, llm: llm as never }, org, PLAN);
    const ceo = officeHolder(org, 'chief_executive');
    const note = parseNote(vault.readText(session.notePath));
    expect(note.data.participants).toEqual([...session.advisors, ceo]);
    expect(vault.events.query({ types: ['meeting.opened'] }).at(-1)!.payload.participants).toContain(ceo);
    // …and the CEO does not speak: a pre-mortem is the board's, held on the CEO's work.
    expect(llm.prompts.some((p) => p.roleId === ceo)).toBe(false);
    expect(session.verdict).toBe('pass');
  }, 30000);
});

describe('the board asks rather than guesses (SP8 §3, task 3)', () => {
  it('records the question, files one cabin message from the chair, and still rules', async () => {
    const llm = dialogueLlm({ unanswerable: 'Founder-Market Fit' });
    const org = loadOrg(vault);
    const session = await runBoardSession({ vault, llm: llm as never }, org, IDEA);
    expect(session.questions).toHaveLength(1);
    expect(isOwnerQuestion(session.questions[0])).toBe(true);
    expect(session.questions[0]).toContain('what have you actually run before');
    expect(session.verdict).toBe('pass');            // the verdict still stands as given

    const messages = listInbox(vault).filter((n) => n.data.kind === 'message' && n.data.from === org.teams.board!.lead);
    expect(messages).toHaveLength(1);
    expect(messages[0].body).toContain('The board needs 1 answer from you');
    expect(messages[0].body).toContain('what have you actually run before');
    expect(messages[0].body).toContain(session.notePath.replace(/\.md$/, ''));
  }, 30000);

  it('re-runs only the rounds that asked, once the owner has answered, and reuses the rest verbatim', async () => {
    const org = loadOrg(vault);
    const first = await runBoardSession({ vault, llm: dialogueLlm({ unanswerable: 'Founder-Market Fit' }) as never }, org, IDEA);
    expect(first.questions).toHaveLength(1);

    // Nothing from the owner: the whole argument is carried over and only the verdict is put again.
    const silent = dialogueLlm();
    const second = await runBoardSession({ vault, llm: silent as never }, org, IDEA);
    expect(second.calls).toBe(1);
    expect(silent.prompts.filter((p) => /The chair has asked, on \*\*/.test(p.text))).toHaveLength(0);
    expect(second.chairText).toContain('Core Assumption answered');
    expect(second.questions).toHaveLength(1);        // still unanswered, so still open

    // The owner speaks. Now the one round that asked is argued again, and no other.
    createProposal(vault, { kind: 'message', from: 'owner', to: 'ceo', title: 'About me', body: 'I ran a nursery kitchen for six years.' }, 'owner');
    const third = dialogueLlm();
    const session = await runBoardSession({ vault, llm: third as never }, org, IDEA);
    const asked = third.prompts.filter((p) => /The chair has asked, on \*\*/.test(p.text));
    expect(asked).toHaveLength(2);                   // one round, two advisors
    expect(asked.every((p) => /Founder-Market Fit/.test(p.text))).toBe(true);
    expect(session.calls).toBe(4);                   // chair opens, two advisors, chair votes
    expect(session.questions).toHaveLength(0);
    expect(session.chairText).toContain('Core Assumption answered');   // the rest is the argument it already won
  }, 30000);
});

describe('the owner reads the argument before they rule (SP8 §3, task 3)', () => {
  it('a full idea cycle links the transcript and lists the open questions on the note the owner decides', async () => {
    letTheBoardDecide(vault, 0);
    const slug = scoredCard(vault, 'Meal kits for nurseries');
    await runHeartbeat({ vault, llm: orgLlm({ ideaVerdict: 'pass' }) }, createHeartbeatJob(vault, 'test'));
    const card = readIdea(vault, slug)!;
    expect(card.data.board_transcript).toMatch(/^Meetings\/.*-board-/);
    expect(vault.readTextOrNull(card.data.board_transcript)).toBeTruthy();
    // The transcript points back at the decision note the session produced, so neither end is a dead link.
    expect(parseNote(vault.readText(card.data.board_transcript)).data.decision).toBe(`board-${slug}`);
    const note = listInbox(vault).find((n) => n.data.kind === 'idea_verdict')!;
    expect(note.body).toContain(`- Transcript: [[${card.data.board_transcript.replace(/\.md$/, '')}]]`);
    expect(listJobs(vault).filter((j) => j.type === 'board.session')).toHaveLength(1);
  }, 60000);
});

describe('the pieces the dialogue is built out of', () => {
  it('reads a finding, a question and the next question out of one chair turn', () => {
    const turn = 'They disagree, so I rule.\nFINDING: the pain is real and priced\nNEXT: why is this company the one to do it?';
    expect(findingIn(turn)).toBe('the pain is real and priced');
    expect(questionIn(turn, 'Founder-Market Fit')).toBe('why is this company the one to do it?');
    const asked = `${OWNER_QUESTION} what have you run before?\nNEXT: and what does that buy us?`;
    expect(isOwnerQuestion(findingIn(asked))).toBe(true);
    expect(questionIn(asked, 'Founder-Market Fit')).toBe('and what does that buy us?');
  });

  it('challenges on the banned hedge and on two advisors that disagree, and not otherwise', () => {
    expect(challengeReason([{ role: 'a', text: 'The pain is real.' }, { role: 'b', text: 'Agreed, it is real.' }])).toBe('');
    expect(hedges(`${BANNED_HEDGE} the margins worry me`)).toBe(true);
    expect(challengeReason([{ role: 'a', text: `${BANNED_HEDGE} the margins worry me` }, { role: 'b', text: 'no' }])).toContain('hedged');
    expect(challengeReason([{ role: 'a', text: 'I disagree with the investor.' }, { role: 'b', text: 'fine' }])).toContain('disagree');
    expect(challengeReason([{ role: 'a', text: 'This is STRONG.' }, { role: 'b', text: 'This is WEAK.' }])).toContain('different verdicts');
  });

  it('keys a subject so the next session finds the last one, and never confuses two ideas', () => {
    expect(boardSubjectKey(IDEA)).toBe('idea:meal-kits');
    expect(boardSubjectKey({ kind: 'plan', text: PLAN, title: "this cycle's plan" })).toBe('plan');
    expect(boardSubjectKey(IDEA)).not.toBe(boardSubjectKey({ ...IDEA, slug: 'spoons' }));
  });

  it('renders and re-reads the five parts, and never reuses a part nobody reached', () => {
    const findings = { 'Core Assumption': 'they will pay', 'Three Fatal Flaws': '- no van' } as const;
    const text = partsText(findings);
    for (const part of PRESSURE_PARTS) expect(text).toContain(`## ${part}`);
    const round = parseFindingsSection(`${BOARD_FINDINGS_HEADING}\n\n### Core Assumption\n\nthey will pay\n\n### Three Fatal Flaws\n\n(not reached)\n`);
    expect(round['Core Assumption']).toBe('they will pay');
    expect(round['Three Fatal Flaws']).toBeUndefined();
  });

  it('only counts the owner speaking after the session it is asked about', () => {
    expect(ownerSpokeSince(vault, '2999-01-01T00:00:00.000Z')).toBe(false);
    createProposal(vault, { kind: 'message', from: 'owner', to: 'ceo', title: 'hi', body: 'here is what I ran' }, 'owner');
    expect(ownerSpokeSince(vault, '2000-01-01T00:00:00.000Z')).toBe(true);
    expect(ownerSpokeSince(vault, '2999-01-01T00:00:00.000Z')).toBe(false);
    expect(ownerSpokeSince(vault, '')).toBe(false);
  });

  it('names the open-questions heading once, for both proposals the owner rules on', () => {
    expect(BOARD_OPEN_QUESTIONS).toBe('## What the board could not answer');
  });
});

const BOARD_FINDINGS_HEADING = '## Findings';
