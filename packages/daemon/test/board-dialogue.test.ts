import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  scaffoldVault, Vault, loadOrg, listInbox, listJobs, readJob, readIdea, writeIdeaCard, updateIdea, createProposal,
  officeHolder, parseNote, PRESSURE_PARTS, OWNER_QUESTION, isOwnerQuestion, hedges, BANNED_HEDGE,
  DISCOVERY_INBOX, briefFromProposalBody, founderBriefProposalBody, checkFounderBrief, briefCheckContext,
  readPressureVerdict, boardStillSitting, BOARD_STILL_SITTING, nowIso,
} from '@cubicle/core';
import { parseToolsConfig, ToolRegistry, phase3Tools } from '@cubicle/tools';
import { runJob, vaultScheduler } from '@cubicle/harness';
import {
  runBoardSession, runHeartbeat, createHeartbeatJob, requeueUnblocked, buildSnapshot, splitRejectedBrief,
  runBriefBoardSession, dispatchProposals,
  BOARD_DIALOGUE_MAX_CALLS, BOARD_DIALOGUE_ROUNDS, BOARD_OPEN_QUESTIONS, boardSubjectKey,
  challengeReason, findingIn, questionIn, parseFindingsSection, ownerSpokeSince, partsText,
  renderBriefPressureSection, subjectMaterial, boardQuestionsMessageId, questionsAlreadyAsked,
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
    expect(listInbox(vault).filter((n) => n.data.kind === 'message' && n.data.from === org.teams.board!.lead)).toHaveLength(1);

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

  it('keys a subject on its content, so two ideas, two plans and two drafts are three different subjects', () => {
    expect(boardSubjectKey(IDEA)).toMatch(/^idea:meal-kits:[0-9a-f]{12}$/);
    expect(boardSubjectKey(IDEA)).not.toBe(boardSubjectKey({ ...IDEA, slug: 'spoons' }));
    // Review I2: every cycle's plan used to key as the constant `plan`, so cycle two found cycle one's session,
    // reused all five of its findings and voted on today's plan over yesterday's argument.
    const cycleOne = { kind: 'plan' as const, text: PLAN, title: "this cycle's plan" };
    const cycleTwo = { ...cycleOne, text: `${PLAN}- And ship the pricing page
` };
    expect(boardSubjectKey(cycleOne)).toMatch(/^plan:plan:[0-9a-f]{12}$/);
    expect(boardSubjectKey(cycleTwo)).not.toBe(boardSubjectKey(cycleOne));
    expect(boardSubjectKey({ ...cycleOne })).toBe(boardSubjectKey(cycleOne));   // the same plan is the same subject
  });

  it('does not count the board\'s own writing as the subject changing', () => {
    const card = '# Meal kits\n\n## Evidence\n\n- two nurseries pay\n';
    const judged = `${card}\n## The board\n\n**Passed** — 2026-09-13\n\n## Score\n\n46/60\n`;
    expect(subjectMaterial(judged)).toBe(subjectMaterial(card));
    expect(boardSubjectKey({ kind: 'idea', text: judged, title: 'Meal kits', slug: 'meal-kits' }))
      .toBe(boardSubjectKey({ kind: 'idea', text: card, title: 'Meal kits', slug: 'meal-kits' }));
    // …but a real change to the dossier is a different subject, and is argued afresh.
    expect(boardSubjectKey({ kind: 'idea', text: `${card}- and a third asked`, title: 'Meal kits', slug: 'meal-kits' }))
      .not.toBe(boardSubjectKey({ kind: 'idea', text: card, title: 'Meal kits', slug: 'meal-kits' }));
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

/**
 * The brief's own pressure test (ruling P8-6), driven the way the company drives it: the real discovery job
 * files the brief through `proposal.create`, and the next heartbeat's `discovery` step holds the session and
 * finishes the document before the owner is asked anything.
 */
describe('the board pressure-tests the founder brief before the owner sees it (ruling P8-6)', () => {
  const root = path.resolve(__dirname, '../../..');

  /**
   * Run the discovery job the heartbeat queued — and the gates it goes `in_review` behind — with the real tool
   * layer, so the brief reaches `00 Inbox/` through `proposal.create` exactly as it does in a live run.
   */
  async function runDiscoveryJob(v: Vault, llm: ReturnType<typeof orgLlm>): Promise<void> {
    const cfg = parseToolsConfig(readFileSync(path.join(root, 'config/tools.yaml'), 'utf8'));
    const deps = { vault: v, llm, toolsConfig: cfg, registry: new ToolRegistry().registerAll(phase3Tools()), scheduler: vaultScheduler(v), env: {} };
    const discovery = listJobs(v).find((j) => j.type === 'discovery')!;
    const terminal = () => ['done', 'failed', 'cancelled'].includes(readJob(v, discovery.id)!.data.status);
    for (let turn = 0; turn < 12 && !terminal(); turn++) {
      const queued = listJobs(v, { status: ['queued'] }).filter((j) => j.type !== 'ceo.heartbeat');
      if (!queued.length) { requeueUnblocked(v); continue; }
      for (const j of queued) await runJob(deps, j.id);
      requeueUnblocked(v);
    }
    expect(readJob(v, discovery.id)!.data.status).toBe('done');
  }

  /** The company from a dropped file to a brief the board has ruled on: two heartbeats around the job. */
  async function discoverAndSit(v: Vault, llm = orgLlm({ ideaVerdict: 'pass' })): Promise<void> {
    v.writeText(`${DISCOVERY_INBOX}/pitch.md`, 'We sell weekly meal kits to nurseries. Two already pay us.', 'owner');
    const first = await runHeartbeat({ vault: v, llm, env: {} }, createHeartbeatJob(v, 'read this'));
    expect(first.status).toBe('blocked');
    await runDiscoveryJob(v, llm);
    requeueUnblocked(v);
    await runHeartbeat({ vault: v, llm, env: {} }, listJobs(v).find((j) => j.type === 'ceo.heartbeat')!.id);
  }


  it('fills the brief with the five round findings, links the argument, and only then is it decidable', async () => {
    await discoverAndSit(vault);
    const note = listInbox(vault).find((n) => n.data.kind === 'founder_brief')!;
    expect(note.data.board_pending).toBe(false);              // the document is finished; the owner may rule

    // The transcript is a board thread of its own, six rounds deep, keyed on the proposal that carried the brief.
    const transcript = vault.list('Meetings', { ext: '.md' }).find((r) => r.includes('-board-founder-brief'))!;
    expect(transcript).toBeTruthy();
    const meeting = parseNote(vault.readText(transcript));
    expect(meeting.data.room).toBe('board');
    expect(meeting.data.status).toBe('done');
    expect(meeting.data.subject).toBe('brief');
    expect(String(meeting.data.subject_key)).toMatch(/^brief:[0-9a-f]{12}$/);
    expect(meeting.data.decision).toBe(`board-brief-${note.data.id}`);
    expect(Number(meeting.data.calls)).toBeLessThanOrEqual(BOARD_DIALOGUE_MAX_CALLS);
    expect(new Set([...String(meeting.body).matchAll(/^\*\*Round (\d+) — /gm)].map((m) => m[1])).size).toBe(BOARD_DIALOGUE_ROUNDS);

    // The brief the owner would adopt: the board's five findings, its verdict, and nothing left as a draft.
    const brief = briefFromProposalBody(note.body);
    for (const part of PRESSURE_PARTS) expect(brief).toContain(`**${part}:**`);
    expect(brief).toContain('Nurseries will pay 40 a week to stop planning meals.');
    expect(brief).toContain('**Brutal Verdict:** STRONG');
    expect(brief).toContain(transcript.replace(/\.md$/, ''));
    // …and it still passes the truth check that every brief owes before the owner reads it (ruling FR-4).
    expect(checkFounderBrief(vault, brief, briefCheckContext(vault))).toMatchObject({ ok: true, findings: [] });

    // The block the owner reads sits ABOVE the fence: everything under it is read as their own words when
    // they turn a brief down (ruling C1), so the company must never write there.
    expect(note.body.indexOf('The board pressure-tested this')).toBeLessThan(note.body.indexOf('## Proposed content'));
    expect(splitRejectedBrief(note).comment).toBe('');
    expect(splitRejectedBrief(note).brief.trim()).toBe(brief.trim());

    // And the session is a decision of record like any other board session.
    expect(vault.readNoteOrNull(`Decisions/board-brief-${note.data.id}.md`)).toBeTruthy();
  }, 60000);

  it('lists what it could not answer on the note the owner rules on, and asks them in the cabin', async () => {
    await discoverAndSit(vault, orgLlm({ ideaVerdict: 'pass', boardAsksOwner: 'Founder-Market Fit' }));
    const note = listInbox(vault).find((n) => n.data.kind === 'founder_brief')!;
    expect(note.body).toContain(BOARD_OPEN_QUESTIONS);
    expect(note.body).toContain('what have you actually run before');
    // The board never guesses: the part it could not answer says so in the brief, in the owner's own word.
    const brief = briefFromProposalBody(note.body);
    expect(brief).toMatch(/\*\*Founder-Market Fit:\*\* unstated/);
    expect(checkFounderBrief(vault, brief, briefCheckContext(vault))).toMatchObject({ ok: true });
    // …and one cabin message from the chair carries them, exactly as an idea session's questions do.
    const chair = loadOrg(vault).teams.board!.lead;
    const asked = listInbox(vault).filter((n) => n.data.kind === 'message' && n.data.from === chair);
    expect(asked).toHaveLength(1);
    expect(asked[0].body).toContain('The board needs 1 answer from you');
  }, 60000);

  it('board_dialogue: brief keeps the discovery job\'s own section and holds no session', async () => {
    holdTheBriefBoard(vault);
    await discoverAndSit(vault);
    const note = listInbox(vault).find((n) => n.data.kind === 'founder_brief')!;
    expect(note.data.board_pending).toBeUndefined();
    expect(vault.list('Meetings', { ext: '.md' }).some((r) => r.includes('-board-founder-brief'))).toBe(false);
    // The author's own pressure test, as it has always been.
    expect(briefFromProposalBody(note.body)).toContain('nurseries will pay weekly for a box of food');
  }, 60000);

  it('the snapshot says a brief the board has not sat on is not ready for the owner', async () => {
    vault.writeText(`${DISCOVERY_INBOX}/pitch.md`, 'We sell weekly meal kits to nurseries.', 'owner');
    const llm = orgLlm({ ideaVerdict: 'pass' });
    expect((await runHeartbeat({ vault, llm, env: {} }, createHeartbeatJob(vault, 'read this'))).status).toBe('blocked');
    await runDiscoveryJob(vault, llm);
    const pending = buildSnapshot(vault).inbox.find((r) => r.kind === 'founder_brief')!;
    expect(pending.board_pending).toBe(true);
    requeueUnblocked(vault);
    await runHeartbeat({ vault, llm, env: {} }, listJobs(vault).find((j) => j.type === 'ceo.heartbeat')!.id);
    expect(buildSnapshot(vault).inbox.find((r) => r.kind === 'founder_brief')!.board_pending).toBe(false);
  }, 60000);

  it('a vault with no board room does not strand the brief behind a board that will never sit', async () => {
    const teams = vault.list('Teams', { ext: '.md' }).find((r) => r.endsWith('board.md'))!;
    vault.updateNote(teams, (n) => ({ data: { ...n.data, lead: 'advisor_skeptic', members: [] }, body: n.body }), 'owner');
    for (const r of ['advisor_skeptic', 'advisor_investor', 'advisor_customer']) {
      vault.updateNote(`Roles/${r}.md`, (n) => ({ data: { ...n.data, active: false }, body: n.body }), 'owner');
    }
    await discoverAndSit(vault);
    const note = listInbox(vault).find((n) => n.data.kind === 'founder_brief')!;
    expect(note.data.board_pending).toBe(false);
    expect(vault.events.query({ types: ['daemon.warning'] }).some((e) => e.payload.where === 'brief_board')).toBe(true);
  }, 60000);

  it('renders a section the brief\'s own parser reads back, question or no question', () => {
    const section = renderBriefPressureSection({
      'Core Assumption': 'they will pay weekly',
      'Three Fatal Flaws': 'three ways this dies\n- no van\n- the caterer renews in August',
      'Problem Validation': 'a painkiller',
      'Founder-Market Fit': `${OWNER_QUESTION} what have you run before?`,
      'Brutal Verdict': 'the fit is the open question',
    }, 'WEAK', 'Meetings/2026-09-13-1400-board-founder-brief.md');
    expect(readPressureVerdict(section)).toMatchObject({ ok: true, verdict: 'WEAK' });
    expect(section).toContain('**Three Fatal Flaws:** three ways this dies; no van; the caterer renews in August');
    expect(section).toMatch(/\*\*Founder-Market Fit:\*\* unstated — QUESTION FOR THE OWNER:/);
    expect(section).toContain('[[Meetings/2026-09-13-1400-board-founder-brief]]');
  });
});

/**
 * The two things the whole-branch review found the reuse rule getting wrong (I2, I3). Both are about *when* the
 * board is allowed to say nothing new: a subject it has already argued, and a question it has already asked.
 */
describe('the reuse rule only reuses what has not changed (review I2, I3)', () => {
  it('argues every cycle\'s plan afresh, and reuses only a plan that is word for word the same', async () => {
    const org = loadOrg(vault);
    const cycleOne = await runBoardSession({ vault, llm: dialogueLlm() as never }, org, PLAN);
    expect(cycleOne.calls).toBe(PRESSURE_PARTS.length * 2 + BOARD_DIALOGUE_ROUNDS);

    // Cycle two writes a different plan. Before I2 this found cycle one's session, reused all five findings,
    // made no advisor call at all, and voted on today's plan over yesterday's argument.
    const next = dialogueLlm();
    const cycleTwo = await runBoardSession({ vault, llm: next as never }, org, `${PLAN}- And ship the pricing page\n`);
    expect(cycleTwo.calls).toBe(cycleOne.calls);
    expect(next.prompts.filter((p) => /The chair has asked, on \*\*/.test(p.text))).toHaveLength(PRESSURE_PARTS.length * 2);

    // The same plan, on the other hand, is the argument the board already had.
    const again = dialogueLlm();
    await runBoardSession({ vault, llm: again as never }, org, PLAN);
    expect(again.prompts.filter((p) => /The chair has asked, on \*\*/.test(p.text))).toHaveLength(0);
  }, 30000);

  it('asks an open question once, however many times the board records it', async () => {
    const org = loadOrg(vault);
    const chair = org.teams.board!.lead;
    const asks = () => listInbox(vault).filter((n) => n.data.kind === 'message' && n.data.from === chair);
    await runBoardSession({ vault, llm: dialogueLlm({ unanswerable: 'Founder-Market Fit' }) as never }, org, IDEA);
    expect(asks()).toHaveLength(1);
    expect(questionsAlreadyAsked(vault, chair)).toEqual(['what have you actually run before?']);

    // A later cycle sits again and records the same open question. Before I3 the message id carried the
    // session's own timestamp, so a fresh "The board needs 1 answer from you" landed every single cycle.
    const later = await runBoardSession({ vault, llm: dialogueLlm({ unanswerable: 'Founder-Market Fit' }) as never }, org, IDEA);
    expect(later.questions).toHaveLength(1);          // still open, and still recorded on the card
    expect(asks()).toHaveLength(1);                   // …and still asked exactly once

    // A different question is a different message, and it carries only what is new.
    await runBoardSession({ vault, llm: dialogueLlm({ unanswerable: 'Problem Validation' }) as never }, org, { ...IDEA, text: `${IDEA.text}\n\nA third nursery asked.` });
    expect(asks()).toHaveLength(1);                   // the same words, so the same question: still asked once
  }, 30000);

  it('keys the cabin message on the questions, not on the session that found them', () => {
    const one = boardQuestionsMessageId('idea:meal-kits:abc', [`${OWNER_QUESTION} what have you run before?`]);
    expect(boardQuestionsMessageId('idea:meal-kits:abc', ['what have you run before?'])).toBe(one);
    expect(boardQuestionsMessageId('idea:meal-kits:abc', ['and who pays?'])).not.toBe(one);
    expect(boardQuestionsMessageId('idea:spoons:abc', ['what have you run before?'])).not.toBe(one);
  });
});

/**
 * What the scoped re-review found (R-T3-1/2/3): the normal path was right and every path around it was not —
 * a brief that missed its one cycle was stuck for good, a refused section was announced as the board's, and
 * nothing daemon-side stopped the owner adopting a half-written brief from Obsidian.
 */
describe('the brief board recovers, tells the truth, and cannot be decided out from under (re-review)', () => {
  const root = path.resolve(__dirname, '../../..');
  const DRAFT = [
    '## What the company is', '', 'A weekly meal-kit box for nurseries.', '',
    '## Who it is for', '', 'Nursery managers who cook for forty children a day.', '',
    '## What already exists', '', 'Two nurseries buying weekly; the company has no name yet.', '',
    '## What success looks like', '', 'Unstated: the owner has not said.', '',
    '## Constraints', '', 'The free tier only.', '',
    '## Candidate ideas', '', '- meal-kits — a weekly box for nurseries.', '',
    '## What we do not know', '', 'Whether anybody has priced the delivery.', '',
    '## Pressure test', '',
    '**Core Assumption:** nurseries will pay weekly for food they cook themselves.',
    '**Founder-Market Fit:** unstated — nothing says who the owner is.',
    '**Brutal Verdict:** WEAK — the draft, written by the research office.', '',
  ].join('\n');

  /** A `founder_brief` in the inbox exactly as `proposal.create` leaves one under `board_dialogue: full`. */
  function fileBrief(v: Vault, draft = DRAFT): { id: string; path: string } {
    const p = createProposal(v, { kind: 'founder_brief', from: 'research_manager', target: 'Memory/founder-brief.md', title: 'What I understood', body: founderBriefProposalBody(draft, []) }, 'research_manager');
    v.updateNote(p.path, (n) => ({ data: { ...n.data, board_pending: true }, body: n.body }), 'research_manager');
    return p;
  }

  /** A board that answers every round, optionally with one part written so the truth check refuses it. */
  function briefLlm(opts: { fit?: string; cite?: string } = {}): { chat: (r: unknown, c: { messages: { content: string }[] }) => Promise<unknown>; promptBudget: () => number } {
    return {
      promptBudget: () => 6000,
      async chat(_r: unknown, chat: { messages: { content: string }[] }) {
        const last = String(chat.messages.at(-1)?.content ?? '');
        const reply = (content: string) => ({ content, toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 }, provider: 'f', model: 'f', tier: 'medium' as const, downgraded: false, parsedToolCalls: [] });
        if (/^You chair the board of this company\./.test(last)) {
          const close = last.match(/close the round on \*\*([^*]+)\*\*/)?.[1] ?? '';
          const open = last.match(/the question of \*\*([^*]+)\*\*/)?.[1] ?? '';
          const said = close === 'Founder-Market Fit' && opts.fit ? opts.fit
            : close === 'Core Assumption' && opts.cite ? `they will pay, per ${opts.cite}`
            : `the board holds ${close} answered.`;
          const finding = close ? `FINDING: ${said}\n\n` : '';
          if (/VERDICT: STRONG or WEAK or PIVOT REQUIRED/.test(last)) return reply(`${finding}VERDICT: STRONG\nRUBRIC: core assumption 2, fatal flaws 1, pain 2, founder fit 1, why now 1`);
          return reply(`${finding}NEXT: On ${open}: what does this rest on?`);
        }
        if (/The chair has asked, on \*\*/.test(last)) return reply('Two nurseries already pay a caterer every term.');
        return reply('ok');
      },
    };
  }

  const briefNote = (v: Vault) => listInbox(v).find((n) => n.data.kind === 'founder_brief')!;

  it('R-T3-1: a brief left pending by an earlier cycle is finished by the next one, and never stays pending', async () => {
    fileBrief(vault);
    expect(briefNote(vault).data.board_pending).toBe(true);
    // `briefProposalOpen` makes this cycle's discovery step return above where the session used to be held —
    // the very shape that stranded the brief. Three cycles, and the first of them finishes it.
    for (let cycle = 0; cycle < 3; cycle++) {
      await runHeartbeat({ vault, llm: briefLlm() as never, env: {} }, createHeartbeatJob(vault, `cycle ${cycle}`));
      expect(briefNote(vault).data.board_pending, `cycle ${cycle}`).toBe(false);
    }
    expect(vault.list('Meetings', { ext: '.md' }).filter((r) => r.includes('-board-founder-brief'))).toHaveLength(1);
    expect(briefFromProposalBody(briefNote(vault).body)).toContain('the board holds Problem Validation answered');
  }, 60000);

  it('R-T3-1: a session that throws leaves the flag on, warns, and is retried next cycle', async () => {
    fileBrief(vault);
    // A real throw from inside the session: the transcript is written to `Meetings/` after every turn, and a
    // vault whose constitution forbids writing there refuses the very first one. (`askAs` swallows a model
    // error, so a silent model is the no-model path and not this one.)
    const constitution = vault.readText('Memory/constitution.md');
    vault.writeText('Memory/constitution.md', constitution.replace(/^never_modify:\n/m, 'never_modify:\n  - Meetings/\n'), 'owner');
    await runHeartbeat({ vault, llm: briefLlm() as never, env: {} }, createHeartbeatJob(vault, 'board cannot write'));
    expect(briefNote(vault).data.board_pending).toBe(true);      // still owed, so still pending
    expect(vault.events.query({ types: ['daemon.warning'] }).some((e) => /try again next cycle/.test(String(e.payload.message)))).toBe(true);

    // The next cycle is the retry, and it finishes the document.
    vault.writeText('Memory/constitution.md', constitution, 'owner');
    await runHeartbeat({ vault, llm: briefLlm() as never, env: {} }, createHeartbeatJob(vault, 'retry'));
    expect(briefNote(vault).data.board_pending).toBe(false);
    expect(briefFromProposalBody(briefNote(vault).body)).toContain('the board holds Core Assumption answered');
  }, 60000);

  it('R-T3-2: a section the truth check refuses is retried with the word it asks for, and then used', async () => {
    fileBrief(vault);
    // No interview answers and nothing in Discovery/inbox/, so rule 3 refuses any Founder-Market Fit that is
    // not `unstated` — the owner's "type an idea and see what happens" first run.
    expect(briefCheckContext(vault)).toMatchObject({ interviewAnswered: false, inboxFiles: 0 });
    const held = await runBriefBoardSession({ vault, llm: briefLlm({ fit: 'the owner ran two catering businesses' }) as never }, loadOrg(vault));
    expect(held!.used).toBe(true);
    const brief = briefFromProposalBody(briefNote(vault).body);
    expect(brief).toMatch(/\*\*Founder-Market Fit:\*\* unstated/);
    expect(brief).toContain('the board holds Core Assumption answered');       // the other four are the board's
    expect(checkFounderBrief(vault, brief, briefCheckContext(vault)).ok).toBe(true);
    expect(briefNote(vault).body).toContain('Its five findings are the');
  }, 60000);

  it('R-T3-2: a section that cannot be saved is not announced as the board\'s, anywhere', async () => {
    fileBrief(vault);
    const held = await runBriefBoardSession({ vault, llm: briefLlm({ cite: '`Nope/missing.md`' }) as never }, loadOrg(vault));
    expect(held!.used).toBe(false);
    const note = briefNote(vault);
    // The draft stands below the fence…
    expect(briefFromProposalBody(note.body)).toContain('the draft, written by the research office');
    expect(briefFromProposalBody(note.body)).not.toContain('Nope/missing.md');
    // …and the block above it says so rather than claiming five findings that are not there.
    expect(note.body).toContain("the research office's draft, not the board's findings");
    expect(note.body).not.toContain('Its five findings are the');
    expect(note.body).toContain(held!.notePath.replace(/\.md$/, ''));
    // The decision note tells the same story, and the argument is still linked from it.
    const decision = vault.readText(`Decisions/board-brief-${note.data.id}.md`);
    expect(decision).toContain("is the research office's draft and not the board's findings");
    expect(vault.events.query({ types: ['daemon.warning'] }).some((e) => e.payload.where === 'brief_board')).toBe(true);
  }, 60000);

  it('R-T3-3: the dispatcher leaves a pending brief alone, and applies the approval once the board is done', async () => {
    const filed = fileBrief(vault);
    const deps = () => ({ vault, registry: new ToolRegistry().registerAll(phase3Tools()), toolsConfig: parseToolsConfig(readFileSync(path.join(root, 'config/tools.yaml'), 'utf8')), scheduler: vaultScheduler(vault), env: {} });
    // The owner approves in Obsidian while the board is still sitting: a raw write, so the owner-flip guard
    // reads it as theirs. Nothing is adopted, nothing is refused, and the flip is still there afterwards.
    writeFileSync(path.join(dir, filed.path), readFileSync(path.join(dir, filed.path), 'utf8').replace(/^approved: .*$/m, 'approved: true'));
    expect(await dispatchProposals(deps())).toBe(0);
    // (the fixture already adopted a brief in `beforeEach`, so what matters is that *this* one was not written)
    expect(vault.readText('Memory/founder-brief.md')).not.toContain('the draft, written by the research office');
    expect(briefNote(vault).data.resolved_at ?? null).toBeNull();
    expect(briefNote(vault).body).not.toContain('Not applied');

    // The board finishes. Its findings are not written over a decided note (the re-read), and the very next
    // dispatch applies the approval that was already sitting there.
    const held = await runBriefBoardSession({ vault, llm: briefLlm() as never }, loadOrg(vault));
    expect(held!.used).toBe(true);
    expect(briefNote(vault).data.board_pending).toBe(false);
    expect(await dispatchProposals(deps())).toBe(1);
    expect(vault.readText('Memory/founder-brief.md')).toContain('the board holds Core Assumption answered');
  }, 60000);

  it('R-T3-3: a brief resolved mid-session is left exactly as the owner left it', async () => {
    const filed = fileBrief(vault);
    let resolved = false;
    const llm = briefLlm();
    const racing = {
      promptBudget: () => 6000,
      async chat(r: unknown, chat: { messages: { content: string }[] }) {
        const out = await llm.chat(r, chat);
        // The owner decides while the board is mid-argument: the last thing the session does must not undo it.
        if (!resolved && /VERDICT: STRONG or WEAK or PIVOT REQUIRED/.test(String(chat.messages.at(-1)?.content ?? ''))) {
          resolved = true;
          vault.updateNote(filed.path, (n) => ({ data: { ...n.data, approved: true, resolved_at: nowIso() }, body: n.body }), 'daemon');
        }
        return out;
      },
    };
    const held = await runBriefBoardSession({ vault, llm: racing as never }, loadOrg(vault));
    expect(resolved).toBe(true);
    expect(held!.used).toBe(false);
    const note = briefNote(vault);
    expect(note.data.board_pending).toBe(true);                     // never cleared on a note nobody may rewrite
    expect(note.body).not.toContain('The board pressure-tested this');
    expect(briefFromProposalBody(note.body)).toContain('the draft, written by the research office');
    // …and the argument is not lost: the transcript stands, and a warning says where it went.
    expect(vault.readTextOrNull(held!.notePath)).toBeTruthy();
    expect(vault.events.query({ types: ['daemon.warning'] }).some((e) => /decided while the board was still sitting/.test(String(e.payload.message)))).toBe(true);
  }, 60000);

  it('names the block once, in core, so three surfaces cannot disagree', () => {
    expect(boardStillSitting({ kind: 'founder_brief', board_pending: true })).toBe(true);
    expect(boardStillSitting({ kind: 'founder_brief', board_pending: false })).toBe(false);
    expect(boardStillSitting({ kind: 'founder_brief' })).toBe(false);
    expect(boardStillSitting({ kind: 'idea_verdict', board_pending: true })).toBe(false);
    expect(BOARD_STILL_SITTING).toContain('still pressure-testing');
  });
});
