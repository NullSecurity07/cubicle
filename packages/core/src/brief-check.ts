import type { Vault } from './vault.js';
import { parseNote } from './frontmatter.js';
import {
  PRESSURE_TEST_SECTION, INTERVIEW_PATH, briefSectionBody, ownerAnsweredInterview, listDiscoveryInputs,
} from './discovery.js';
import { readPressureVerdict, PRESSURE_VERDICTS } from './pressure.js';

/**
 * The founder brief, checked against the vault before anybody is asked to approve it.
 *
 * In the owner's first live run the research manager wrote a brief that read beautifully and was not true: it
 * said the owner had picked an idea (they had asked to be surprised), it named a brand the company does not
 * have (`Brand/name.md` carries an empty `name`), it described `Discovery/interview.md` as a set of structured
 * responses (it holds six questions and no answers), and it wrote a Founder-Market Fit paragraph out of
 * nothing at all. Every one of those claims is checkable by reading the vault, and none of them was checked:
 * the brief was proposed to the owner, and the reviewer passed its citations unread.
 *
 * So this is the half a program can check — deterministic, no model call, no network. It never judges whether
 * the brief is *good*; it judges whether the four things it says about files are things those files say. What
 * it finds goes back to the author as tool output, in their own words, so the brief is fixed before the owner
 * ever sees it (ruling FR-4).
 */

/** What the brief was written with, as the caller knows it. `briefCheckContext` reads both off the vault. */
export interface BriefCheckContext {
  /**
   * The **owner** has spoken in the interview: a `**You:**` addition, or an `## Endorsed` block where they read
   * the CEO's six answers and said go (ruling P8-13). The CEO's own `## Answers` never set this — they are the
   * company's reading of its own idea, and a brief that cited them as the owner's word would be rule 3's
   * original lie with a new source.
   */
  interviewAnswered: boolean;
  /** How many files the owner dropped in `Discovery/inbox/`. */
  inboxFiles: number;
}

export interface BriefCheck {
  ok: boolean;
  /** One line per false or unsupported claim, each naming the file and the sentence. Empty when `ok`. */
  findings: string[];
}

/** The brief's own view of the vault, read off the vault. */
export function briefCheckContext(vault: Vault): BriefCheckContext {
  return {
    interviewAnswered: ownerAnsweredInterview(vault.readTextOrNull(INTERVIEW_PATH)),
    inboxFiles: listDiscoveryInputs(vault).length,
  };
}

/**
 * The brief out of a `proposal.create` body — the same `## Proposed content` fence the dispatcher adopts from,
 * so what is checked here is exactly the bytes that would become `Memory/founder-brief.md`. A body with no
 * fence is checked as written: a brief that forgot its fence is still a brief making claims.
 */
export function briefFromProposalBody(body: string): string {
  const m = body.match(PROPOSED_CONTENT_RE);
  return m ? m[2] : body;
}

/** The `## Proposed content` block, as the dispatcher's own `fenced()` reads it. One spelling, three readers. */
const PROPOSED_CONTENT_RE = /## Proposed content\s*\n+(`{3,})[a-z]*\n([\s\S]*?)\n\1[ \t]*(?:\n|$)/;

/**
 * True when a proposal body already carries that block.
 *
 * The founder brief is the one proposal whose body is *rewritten* when it does not (`proposal.create`). Three
 * readers depend on the fence being there, and before ruling C1 nothing made it so: the dispatcher adopts what
 * is inside it, the rejection path hands the research office the brief out of it, and the owner's own rejection
 * comment is read as what lies *outside* it. The live run's brief carried no fence, and the comment reader
 * handed the owner a thousand characters of the company's own prose back as their words.
 */
export function hasProposedContentFence(body: string): boolean {
  return PROPOSED_CONTENT_RE.test(body);
}

/**
 * The same proposal body with a different document inside its fence, and everything the author wrote around
 * that fence left exactly as it was.
 *
 * Its one caller re-titles a founder brief (ruling W6-12), which is a change to the document and not to the
 * covering note above it. A body with no fence comes back untouched: there is nothing to swap, and rebuilding
 * it is `founderBriefProposalBody`'s job.
 */
export function withProposedContent(body: string, content: string): string {
  const m = body.match(PROPOSED_CONTENT_RE);
  if (!m) return body;
  const at = body.indexOf(m[0]);
  const swapped = m[0].replace(`\n${m[2]}\n`, `\n${content.trim()}\n`);
  return body.slice(0, at) + swapped + body.slice(at + m[0].length);
}

/**
 * A backticked token that is a claim about a **file**: it has a directory in it and it ends in an extension.
 *
 * Both halves keep this from firing on things that are not citations. Without the slash, every tool name the
 * brief mentions (`idea.card`, `http.fetch`) would be looked up as a path; without the extension, every
 * directory (`Discovery/inbox`) would be. A token carrying `<` — `Ideas/<slug>.md` — is the template's own
 * placeholder and names no file either.
 */
export function citedPaths(md: string): string[] {
  const out = new Set<string>();
  for (const m of md.matchAll(/`([^`\n]+)`/g)) {
    const t = m[1].trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9 _./-]*$/.test(t)) continue;
    if (!t.includes('/') || !/\.[A-Za-z0-9]{1,5}$/.test(t)) continue;
    out.add(t);
  }
  return [...out];
}

/** The company's name, as `Brand/name.md` actually carries it. '' when the file is missing or the field empty. */
function brandName(vault: Vault): string {
  const t = vault.readTextOrNull('Brand/name.md');
  if (t === null) return '';
  return String((parseNote(t).data as { name?: unknown }).name ?? '').trim();
}

/** How a brief says the company has a name. The live run wrote all three of these. */
const NAME_CLAIM = [/\bname is\b/i, /\bname\s*&\s*brand\b/i, /\bbrand name\b/i];

/**
 * How a brief says the opposite. A line that names the absence is the line this check *wants* — "Name & Brand:
 * none yet" carries a claim cue and is the honest sentence — so the negation is read on the same line and wins.
 */
const NO_NAME = /\bno name\b|\bno brand\b|\bnot (?:yet )?named\b|\bun-?named\b|\bnameless\b|\bempty\b|\bnone\b|\bnot been (?:chosen|picked|decided|set)\b|\byet to be\b|\bunstated\b|\bno company name\b|\bdoes not have a name\b|\bhas no\b/i;

/** How a brief refers to the six questions, however it spells them. */
const INTERVIEW_MENTION = /discovery\/interview\.md|discovery interview|founder interview|\bthe interview\b/i;
/** How a brief claims those questions were answered. */
const ANSWERED_CLAIM = /\bresponses?\b|\banswers?\b|\banswered\b|\bthe founder said\b|\bthe owner said\b|\bthey (?:said|told us)\b/i;
/**
 * How a brief says they were not — again read on the same line, so "the interview has no answers" is fine.
 *
 * P8-13 added a second honest sentence this had to learn. The transcript is now a self-interview: the CEO
 * answers the six itself and the owner adds to them, so the truthful line about an unendorsed transcript says
 * *whose* answers they are ("the CEO's own answers", "not the owner's word", "the owner has not added to
 * them") rather than that there are none. Without these the check fired on the one sentence it wants written.
 */
const NOT_ANSWERED = /\bno answers?\b|\bnot answered\b|\bun-?answered\b|\bno responses?\b|\bnot yet\b|\bawaiting\b|\bstill open\b|\bquestions only\b|\bskipped\b|\bnobody answered\b|\bunstated\b|\bnone\b|\bno one has\b|\bhas no\b|\bempty\b|\bself-interview\b|\bthe CEO'?s own\b|\bmy own answers\b|\bnot the owner'?s\b|\bthe owner has not\b|\bfrom the idea\b|\bunconfirmed\b|\bnot endorsed\b|\bhas not (?:added|confirmed|endorsed|corrected|replied)\b/i;

/** The word a brief owes wherever the material establishes nothing. The owner's own word (ruling FR-4). */
export const UNSTATED = 'unstated';

/** The other four parts of the pressure test, plus the chair's machine lines: where Founder-Market Fit ends. */
const AFTER_FOUNDER_FIT = /Brutal Verdict|Core Assumption|Three Fatal Flaws|Problem Validation|\bVERDICT\b|\bRUBRIC\b|\bWEDGE\b/i;

/** What the brief wrote for Founder-Market Fit, or null when the section names no such part. */
function founderFitText(section: string): string | null {
  const label = section.match(/Founder[\s-]?Market Fit/i);
  if (label?.index === undefined) return null;
  const after = section.slice(label.index + label[0].length);
  const end = after.search(AFTER_FOUNDER_FIT);
  return end < 0 ? after : after.slice(0, end);
}

/** One line of a brief, trimmed of its list marker and emphasis, short enough to quote back. */
function quote(line: string): string {
  const t = line.trim().replace(/^(?:[-*+]|\d+[.)])\s+/, '').replace(/[*_`]/g, '').trim();
  return t.length > 120 ? `${t.slice(0, 120)}…` : t;
}

/**
 * Check a founder brief against the vault it claims to be written from.
 *
 * Four rules, each one a claim the first live run actually got wrong:
 *
 * 1. **Every cited file exists.** A brief's authority is that it names where each claim came from, so a
 *    citation to a file nobody wrote is worse than no citation at all.
 * 2. **No name while `Brand/name.md` has none.** The one fact about the company that is trivially checkable,
 *    and the one the live run invented.
 * 3. **No owner answers while the owner has given none**, and — with no inbox files either — a Founder-Market
 *    Fit that says `unstated` rather than a paragraph about a founder nobody has described. Since P8-13 the
 *    transcript usually *does* hold answers; they are the CEO's, and citing them as the owner's is the same
 *    fabrication the live run produced.
 * 4. **The pressure test ends on a verdict.** Read with `readPressureVerdict`, the one parser the board, the
 *    card and the handbook already agree on: `PIVOT REQUIRED` is two words and always was.
 */
export function checkFounderBrief(vault: Vault, briefMarkdown: string, ctx: BriefCheckContext): BriefCheck {
  const md = (briefMarkdown ?? '').replace(/\r/g, '');
  const findings: string[] = [];

  // 1. every cited path exists
  for (const p of citedPaths(md)) {
    if (!vault.exists(p)) findings.push(`the brief cites \`${p}\`, and there is no such file in the vault: cite a file you actually read with vault.read, or drop the claim.`);
  }

  // 2. a name the company does not have
  if (!brandName(vault)) {
    for (const line of briefSectionBody(md, '## What already exists').split('\n')) {
      if (!NAME_CLAIM.some((re) => re.test(line)) || NO_NAME.test(line)) continue;
      findings.push(`"${quote(line)}" — Brand/name.md carries an empty \`name\`, so the company has no name yet. Say that instead of naming one.`);
    }
  }

  // 3. an interview nobody answered
  if (!ctx.interviewAnswered) {
    for (const line of md.split('\n')) {
      if (!INTERVIEW_MENTION.test(line) || !ANSWERED_CLAIM.test(line) || NOT_ANSWERED.test(line)) continue;
      findings.push(`"${quote(line)}" — the owner has neither added to ${INTERVIEW_PATH} nor endorsed it: every answer in it is the CEO's own. Say whose answers they are, and do not describe the owner as having answered.`);
    }
    if (ctx.inboxFiles === 0) {
      const fit = founderFitText(briefSectionBody(md, PRESSURE_TEST_SECTION));
      if (fit !== null && !new RegExp(`\\b${UNSTATED}\\b`, 'i').test(fit)) {
        findings.push(`the Pressure test's Founder-Market Fit says "${quote(fit)}" — with no interview answers and nothing in Discovery/inbox/, nothing about this owner is established. Write "${UNSTATED}".`);
      }
    }
  }

  // 4. the pressure test ends on a verdict
  const section = briefSectionBody(md, PRESSURE_TEST_SECTION);
  if (!section) {
    findings.push(`the brief has no written ${PRESSURE_TEST_SECTION} section: write the five parts and end on the verdict line — ${PRESSURE_VERDICTS.join(', ')}.`);
  } else {
    const read = readPressureVerdict(section);
    if (!read.ok) findings.push(`the ${PRESSURE_TEST_SECTION} does not end on a verdict — ${read.reason}. End it on the verdict line: one of ${PRESSURE_VERDICTS.join(', ')} (two words is fine; PIVOT REQUIRED is two words), then the reasons.`);
  }

  return { ok: findings.length === 0, findings };
}
