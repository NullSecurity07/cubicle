import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  scaffoldVault, Vault, loadOrg, listInbox, writeIdeaCard, updateIdea,
  NO_SUCH_NOTE, BOARD_OPINION, EVIDENCE_RULE, withheldTurn,
} from '@cubicle/core';
import { runBoardSession, fileIdeaVerdict, advisorPrompt, chairPrompt, chairRoundPrompt, advisorRoundPrompt } from '../src/index.js';
import { adoptFounderBrief } from './helpers/brief.js';

/** The two turns the second dry-run's board wrote, quoted from its `Meetings/` transcripts. */
const INVESTOR_TURN = 'Based on our own 3‑month outbound test to 1,200 SaaS founders (see Research/speedaudit‑discovery/report), a subject line yields a 22% open rate.';
const CUSTOMER_TURN = 'John Doe, former Shopify performance lead, cut Allbirds’ checkout latency by 35%, generating $1.2 M incremental revenue.';

let dir: string;
let vault: Vault;
beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-w4-board-'));
  vault = (await scaffoldVault(dir)).vault;
  adoptFounderBrief(vault);
});
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

const IDEA = { kind: 'idea' as const, text: '# SpeedAudit\n\nThree manual website speed fixes.', title: 'SpeedAudit', slug: 'speedaudit' };

/**
 * A board whose advisors speak the live run's fabricated turns. `verdict` decides what the chair rules; the
 * classifier answers through the same router, so `violates` is what the constitution's check comes back with.
 */
function fabricatingBoard(opts: { violates: boolean; turn: string }): { llm: { chat: (r: unknown, c: { messages: { content: string }[] }) => Promise<unknown> }; router: { chat: (r: unknown, c: unknown) => Promise<unknown> }; prompts: string[] } {
  const prompts: string[] = [];
  const reply = (content: string) => ({ content, toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 }, provider: 'f', model: 'f', tier: 'medium' as const, downgraded: false, parsedToolCalls: [] });
  let advisor = 0;
  const llm = {
    async chat(_r: unknown, chat: { messages: { content: string }[] }) {
      const last = String(chat.messages.at(-1)?.content ?? '');
      prompts.push(last);
      if (/^You chair the board of this company\./.test(last)) {
        const close = last.match(/close the round on \*\*([^*]+)\*\*/)?.[1] ?? '';
        const finding = close ? `FINDING: ${INVESTOR_TURN}\n\n` : '';
        if (/VERDICT: STRONG or WEAK or PIVOT REQUIRED/.test(last)) return reply(`${finding}VERDICT: WEAK\nRUBRIC: core assumption 1, fatal flaws 1, pain 1, founder fit 1, why now 1`);
        return reply(`${finding}NEXT: what does this rest on?`);
      }
      if (/The chair has asked, on \*\*/.test(last)) { advisor++; return reply(opts.turn); }
      return reply('ok');
    },
  };
  const router = {
    async chat(_r: unknown, _c: unknown) {
      return reply(JSON.stringify({ violates: opts.violates, tactic: opts.violates ? 'fabricated testimonials' : '' }));
    },
  };
  return { llm, router, prompts };
}

describe('the board may not invent evidence (W4-1)', () => {
  it('tells the advisors and the chair the rule, in the prompts', () => {
    expect(advisorRoundPrompt({ ...IDEA }, 'Core Assumption', 'what does this rest on?', '')).toContain(EVIDENCE_RULE);
    expect(chairRoundPrompt({ ...IDEA }, { close: null, open: 'Core Assumption', challenge: '', transcript: '', verdict: false })).toContain(EVIDENCE_RULE);
    expect(advisorPrompt({ ...IDEA })).toContain(EVIDENCE_RULE);
    expect(chairPrompt({ ...IDEA }, 'the advisors wrote')).toContain(EVIDENCE_RULE);
  });

  it('marks a reference the vault does not hold, in the transcript, where it was made', async () => {
    const fake = fabricatingBoard({ violates: false, turn: INVESTOR_TURN });
    const session = await runBoardSession({ vault, llm: fake.llm as never, router: fake.router as never }, loadOrg(vault), IDEA, { decision: 'board-speedaudit' });
    const transcript = vault.readText(session.notePath);
    expect(transcript).toContain(`Research/speedaudit‑discovery/report ${NO_SUCH_NOTE}`);
  });

  it('withholds a turn the constitution refuses, and tells the chair it did not speak', async () => {
    // A different sentence from the test above: the classifier memoises its verdict per text, so one turn
    // cannot be both refused and cleared inside one process.
    const fake = fabricatingBoard({ violates: true, turn: CUSTOMER_TURN });
    const session = await runBoardSession({ vault, llm: fake.llm as never, router: fake.router as never }, loadOrg(vault), IDEA, { decision: 'board-speedaudit' });
    const transcript = vault.readText(session.notePath);
    expect(transcript).toContain("'s turn was withheld: it invented evidence");
    expect(transcript).not.toContain('John Doe');
    // The chair was told, on the round after the one it was withheld from.
    expect(fake.prompts.some((p) => /withheld for inventing evidence/.test(p))).toBe(true);
  });

  it("suffixes a chair finding the owner reads with (the board's opinion)", async () => {
    const slug = writeIdeaCard(vault, { title: 'SpeedAudit', source: 'discovery', evidence: ['the owner asked'] }, 'daemon');
    updateIdea(vault, slug, { score_inputs: { value: 4, evidence: 4, effort: 5, fit: 5 }, board_verdict: 'return' }, 'daemon');
    const filed = fileIdeaVerdict(vault, slug, { from: 'advisor_skeptic', findings: ['The pilot data shows only 1-2 paid conversions per 100 contacts.'] });
    expect(filed).not.toBeNull();
    const note = listInbox(vault).find((n) => n.data.id === filed!.id)!;
    expect(note.body).toContain(`per 100 contacts. ${BOARD_OPINION}`);
  });

  it('says the withheld line in one place', () => {
    expect(withheldTurn('advisor_investor')).toBe("advisor_investor's turn was withheld: it invented evidence");
  });
});
