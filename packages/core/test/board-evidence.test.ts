import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  scaffoldVault, Vault,
  NO_SUCH_NOTE, BOARD_OPINION, EVIDENCE_RULE, OPINION_PHRASES,
  noteRefs, refExists, unresolvedRefs, annotateUnresolvedRefs, citesExistingNote,
  hasEvidenceClaim, isOpinion, asBoardOpinion, withheldTurn, withheldNote,
} from '../src/index.js';

/**
 * The two turns the second dry-run's board actually wrote, quoted from
 * `Meetings/2026-09-14-1200-board-speedaudit.md` and `Meetings/2026-09-14-1158-board-founder-brief.md`. The
 * investor's citation carries U+2011 non-breaking hyphens exactly as the model wrote them.
 */
const INVESTOR_TURN = 'Based on our own 3‑month outbound test to 1,200 SaaS founders (see Research/speedaudit‑discovery/report), a subject line that includes the founder’s name and a “Your Site’s Speed Score” yields a 22% open rate.';
const CUSTOMER_TURN = 'John Doe, former Shopify performance lead, cut Allbirds’ checkout latency by 35%, generating $1.2 M incremental revenue.';
const CHAIR_FINDING = 'The pilot data shows only 1-2 paid conversions per 100 contacts, proving founders will not readily consider the $1,200 upsell from a free diagnostic email, directly contradicting the core assumption.';

let dir: string;
let vault: Vault;
beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-w4-evidence-'));
  vault = (await scaffoldVault(dir)).vault;
  vault.writeText('Research/speedaudit-discovery/report.md', '# Report\n\nWhat the office read.\n', 'daemon');
});
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

describe('what the board may call evidence (W4-1)', () => {
  it('reads wikilinks and bare vault paths as references', () => {
    const refs = noteRefs('As [[Research/speedaudit-discovery/report|the report]] says, and Research/nowhere/report too.');
    expect(refs.map((r) => r.target)).toEqual(['Research/speedaudit-discovery/report', 'Research/nowhere/report']);
  });

  it('resolves a reference against the vault, with and without .md', () => {
    expect(refExists(vault, 'Research/speedaudit-discovery/report')).toBe(true);
    expect(refExists(vault, 'Research/speedaudit-discovery/report.md')).toBe(true);
    expect(refExists(vault, 'Research/speedaudit-discovery/nothing')).toBe(false);
  });

  it('does not repair a typographic hyphen into a path the vault holds', () => {
    // The live run's citation. The report it names exists; the path the investor wrote does not.
    expect(unresolvedRefs(vault, INVESTOR_TURN)).toEqual(['Research/speedaudit‑discovery/report']);
  });

  it('annotates an unresolved reference where the claim was made', () => {
    const out = annotateUnresolvedRefs(vault, INVESTOR_TURN);
    expect(out).toContain(`Research/speedaudit‑discovery/report ${NO_SUCH_NOTE})`);
    expect(out).toContain('1,200 SaaS founders');
  });

  it('leaves a reference the vault holds alone, and never annotates twice', () => {
    const good = 'The office looked: [[Research/speedaudit-discovery/report]].';
    expect(annotateUnresolvedRefs(vault, good)).toBe(good);
    const once = annotateUnresolvedRefs(vault, INVESTOR_TURN);
    expect(annotateUnresolvedRefs(vault, once)).toBe(once);
  });

  it('knows a claim from an opinion', () => {
    expect(hasEvidenceClaim(INVESTOR_TURN)).toBe(true);
    expect(hasEvidenceClaim(CUSTOMER_TURN)).toBe(true);
    expect(hasEvidenceClaim('Speed optimization is a vitamin, not a painkiller for these people.')).toBe(false);
  });

  it('counts a turn with a number and no live note as opinion, and one that cites a note as not', () => {
    expect(isOpinion(vault, CUSTOMER_TURN)).toBe(true);
    expect(isOpinion(vault, INVESTOR_TURN)).toBe(true);
    expect(isOpinion(vault, 'Two nurseries pay weekly: [[Research/speedaudit-discovery/report]].')).toBe(false);
    expect(citesExistingNote(vault, INVESTOR_TURN)).toBe(false);
  });

  it("suffixes a chair finding the owner reads with (the board's opinion)", () => {
    expect(asBoardOpinion(vault, CHAIR_FINDING)).toBe(`${CHAIR_FINDING} ${BOARD_OPINION}`);
    // Backed, asked, and already marked: all three are left as written.
    const backed = 'Two nurseries already pay: [[Research/speedaudit-discovery/report]].';
    expect(asBoardOpinion(vault, backed)).toBe(backed);
    expect(asBoardOpinion(vault, 'QUESTION FOR THE OWNER: what have you run before?')).toBe('QUESTION FOR THE OWNER: what have you run before?');
    expect(asBoardOpinion(vault, asBoardOpinion(vault, CHAIR_FINDING))).toBe(`${CHAIR_FINDING} ${BOARD_OPINION}`);
  });

  it('says what a withheld turn says, and what the chair is told about it', () => {
    expect(withheldTurn('advisor_customer')).toBe("advisor_customer's turn was withheld: it invented evidence");
    expect(withheldNote([])).toBe('');
    expect(withheldNote(['advisor_customer'])).toContain('withheld for inventing evidence');
  });

  it('states the rule the prompts quote', () => {
    for (const phrase of OPINION_PHRASES) expect(EVIDENCE_RULE).toContain(phrase);
    expect(EVIDENCE_RULE).toContain(NO_SUCH_NOTE);
  });
});
