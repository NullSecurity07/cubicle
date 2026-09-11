import type { Vault } from './vault.js';
import { sha256, nowIso } from './fs.js';

/**
 * Discovery: how the company learns what the owner is actually building, before it plans anything.
 *
 * Three inputs, in any combination (program design §3): files dropped in `Discovery/inbox/`, a cabin interview
 * the CEO runs once, and a long prompt typed straight into the cabin. All three end in one place —
 * `Memory/founder-brief.md`, which the owner approves — and that brief is what the first plan is written
 * against. Everything here is pure or read-only: the jobs that act on it live in the daemon.
 */

export const DISCOVERY_DIR = 'Discovery';
export const DISCOVERY_INBOX = `${DISCOVERY_DIR}/inbox`;
export const INTERVIEW_PATH = `${DISCOVERY_DIR}/interview.md`;
export const FOUNDER_BRIEF = 'Memory/founder-brief.md';

/**
 * What counts as a long prompt: 400 characters, or five non-empty lines. Below it, the owner typed an idea and
 * the CEO names the company (the existing first-idea path); at or above it, the owner wrote a document and the
 * company runs discovery over it instead of trying to squeeze a name out of the first sentence.
 *
 * A threshold rather than a question to the owner, because "is this a prompt or a brief?" is not a question
 * anyone should have to answer about their own writing.
 */
export const LONG_PROMPT_CHARS = 400;
export const LONG_PROMPT_LINES = 5;

export function isLongPrompt(text: string): boolean {
  const t = text.replace(/^#.*$/gm, '').trim();
  if (t.length >= LONG_PROMPT_CHARS) return true;
  return t.split('\n').filter((l) => l.trim()).length >= LONG_PROMPT_LINES;
}

/** Extensions discovery can actually read. Anything else is listed for the owner and skipped, never guessed at. */
export const DISCOVERY_TEXT_EXT = ['.md', '.txt', '.csv', '.json', '.yaml', '.yml'] as const;

/**
 * One file the owner dropped in. `sha` is carried on the record rather than re-read by every caller: a cycle
 * lists the inbox, digests it and bundles it for the agent, and reading every file three times to answer three
 * questions about the same bytes is the kind of cost that only shows up in a vault with real material in it.
 */
export interface DiscoveryInput { path: string; readable: boolean; chars: number; sha: string }

export function listDiscoveryInputs(vault: Vault): DiscoveryInput[] {
  return vault.list(DISCOVERY_INBOX, { recursive: true }).filter((p) => !p.endsWith('/README.md')).map((path) => {
    const readable = DISCOVERY_TEXT_EXT.some((e) => path.toLowerCase().endsWith(e));
    const text = readable ? vault.readTextOrNull(path) : null;
    // A file discovery cannot read still has to move the digest when the owner replaces it, so it is hashed
    // from disk; a readable one is hashed from the text this call already read.
    return { path, readable: readable && text !== null, chars: text?.length ?? 0, sha: text === null ? vault.currentSha(path) ?? '' : sha256(text) };
  }).sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * A fingerprint of everything discovery would read: every inbox file's sha, the interview transcript's sha, and
 * the owner's prompt. The discovery job's id is derived from it, so the same material never queues a second job
 * and new material queues exactly one more.
 *
 * `inputs` is a parameter so a caller that has already listed the inbox does not pay for a second full read of
 * every file in it; omitted, it lists them itself.
 */
export function discoveryDigest(vault: Vault, prompt = '', inputs: DiscoveryInput[] = listDiscoveryInputs(vault)): string {
  const parts = inputs.map((f) => `${f.path}:${f.sha}`);
  parts.push(`interview:${vault.currentSha(INTERVIEW_PATH) ?? ''}`);
  parts.push(`prompt:${sha256(prompt.trim())}`);
  return sha256(parts.sort().join('\n')).slice(0, 12);
}

/**
 * What the owner actually typed, out of a cabin note's body.
 *
 * Two things are cut: the `# title` line, anchored to the first line of the body so a `# …` further down is the
 * owner's own writing and survives; and everything from `## CEO` on, which is the CEO's reply appended to the
 * same note. Letting the reply through would feed discovery the company's own words back and, worse, move
 * `discoveryDigest` every time anyone answered, re-queueing discovery for ever.
 *
 * Every reader of an owner message goes through this one function, because the cabin's note body is never what
 * the owner typed: `ws.ts` sends `title: text.slice(0, 60), body: text` and `createProposal` renders the note as
 * `# <title>\n\n<body>`, so an owner who types `skip` produces `# skip\n\nskip`. `isSkip` is anchored to the
 * whole string, so the raw body would be recorded as *answering* the six questions with the word "skip" — and
 * `discoveryStatus` reads an answered interview as material, which is the opposite of what they asked for.
 *
 * It lives in core rather than in the daemon because the `discovery.inputs` tool has to cut exactly the same
 * two things: a second inlined regex there (with an `m` flag) deleted the first heading *anywhere* in the body,
 * so a message that did not start with the cabin's title line lost a line of the owner's own writing from the
 * material the founder brief was written against.
 */
export function ownerSaid(body: string): string {
  return body.split(/^## CEO\s*$/m)[0].replace(/^#\s[^\n]*\r?\n?/, '').trim();
}

/** True once the owner has approved a founder brief. Discovery never writes a second one unasked. */
export function hasFounderBrief(vault: Vault): boolean {
  return (vault.readTextOrNull(FOUNDER_BRIEF) ?? '').trim().length > 0;
}

/**
 * The six questions, in the order the CEO asks them. Six is the cap the owner set, and they are ordered so that
 * an owner who answers only the first two has still said the two things a plan cannot be written without.
 */
export const INTERVIEW_QUESTIONS = [
  'What are you building, in one sentence?',
  'Who is it for, and what goes wrong for them today without it?',
  'What already exists — code, customers, a waitlist, a name, anything?',
  'What would have to be true in three months for this to have been worth it?',
  'What have you already tried that did not work?',
  'What is off the table — anything you do not want this company to do?',
] as const;

/**
 * The one message the CEO sends. Six numbered questions, answered in any depth, or skipped outright.
 *
 * It does not say "before I plan anything", because that is not true and the owner would catch it: the company
 * starts from whatever it already has in the same cycle these questions go out (spec §5.5 — one line in the
 * cabin is enough to plan from). What the answers buy is a better brief and a better *next* plan, so that is
 * what the message promises.
 */
export function renderInterviewAsk(questions: readonly string[] = INTERVIEW_QUESTIONS): string {
  return [
    'I am starting from what you have already given me. Six questions, to make sure I start from the right thing — answer the ones you want to, in any order, in your own words; one line each is plenty.',
    '',
    ...questions.slice(0, 6).map((q, i) => `${i + 1}. ${q}`),
    '',
    'Whatever you say next closes this, and goes into the founder brief the next plan is written against. Reply "skip" and I will work from what is already in the vault instead.',
  ].join('\n');
}

/** An owner reply that means "stop asking". Deliberately narrow: a one-word answer, not a word inside a sentence. */
export function isSkip(text: string): boolean {
  return /^\s*(skip|no thanks|not now|later)\s*[.!]?\s*$/i.test(text);
}

export type InterviewPhase = 'none' | 'asked' | 'answered' | 'skipped';

/** Where the interview stands, read from the transcript alone — no cache, no state file. */
export function interviewPhase(transcript: string | null): InterviewPhase {
  if (!transcript || !transcript.trim()) return 'none';
  if (/^## Skipped\b/m.test(transcript)) return 'skipped';
  if (/^## Answer\b/m.test(transcript)) return 'answered';
  return 'asked';
}

/** The transcript as the CEO leaves it after asking. */
export function renderInterviewAsked(at: string, questions: readonly string[] = INTERVIEW_QUESTIONS): string {
  return [
    '# Founder interview', '',
    `_The CEO asked these on ${at.slice(0, 10)}. The owner answers in the cabin; the next message they send closes the interview, whatever it says._`, '',
    '## Questions', '',
    ...questions.slice(0, 6).map((q, i) => `${i + 1}. ${q}`),
    '',
  ].join('\n');
}

/**
 * Close the interview with whatever the owner said. A skip is recorded as a skip rather than as an empty answer:
 * the discovery job reads the difference, and "the owner chose not to answer" is itself worth knowing.
 */
export function closeInterview(transcript: string, answer: string, at = nowIso()): string {
  const base = transcript.trimEnd();
  if (isSkip(answer)) return `${base}\n\n## Skipped\n\n_The owner skipped the interview on ${at.slice(0, 10)}._\n`;
  return `${base}\n\n## Answer\n\n_${at.slice(0, 10)}_\n\n${answer.trim()}\n`;
}

/** The owner's own words from a closed transcript, or '' when there are none. */
export function interviewAnswer(transcript: string | null): string {
  if (!transcript) return '';
  const after = transcript.split(/^## Answer\s*$/m)[1];
  return (after ?? '').replace(/^\s*_\d{4}-\d{2}-\d{2}_\s*$/m, '').trim();
}

/** The sections a founder brief must carry before the owner is asked to approve it. */
export const FOUNDER_BRIEF_SECTIONS = [
  '## What the company is',
  '## Who it is for',
  '## What already exists',
  '## What success looks like',
  '## Constraints',
  '## Candidate ideas',
  '## What we do not know',
] as const;

export function missingBriefSections(md: string): string[] {
  return FOUNDER_BRIEF_SECTIONS.filter((h) => !new RegExp(`^${h}\\s*$`, 'm').test(md));
}

/**
 * The empty brief, written into the discovery job's goal so the agent fills a shape instead of inventing one.
 * Every section says what belongs in it and what would make it a lie; `## What we do not know` is required
 * precisely because a brief with no unknowns in it was not written from evidence.
 */
export function founderBriefTemplate(): string {
  return [
    '## What the company is', '', 'One paragraph in the owner\'s own terms, not yours. If the owner\'s material and the interview disagree, say so here rather than picking one.', '',
    '## Who it is for', '', 'The buyer, specifically enough that someone could go and find ten of them. "Everyone" is not an answer.', '',
    '## What already exists', '', 'Code, customers, a waitlist, a name, a domain, prior attempts — with the file or message each claim came from.', '',
    '## What success looks like', '', 'The owner\'s own three-month answer if they gave one; otherwise say it is unanswered and that the first plan has to ask.', '',
    '## Constraints', '', 'Money, time, what is off the table, anything the constitution already bans.', '',
    '## Candidate ideas', '', 'One line per `Ideas/<slug>.md` card you filed, with its slug. These are candidates, not decisions: the board rules on them and the owner decides.', '',
    '## What we do not know', '', 'The gaps that would change the plan if they were filled. A brief with nothing here was not written from evidence.', '',
  ].join('\n');
}

/**
 * What the owner reads in `00 Inbox/` when the brief is ready. The brief itself goes in a fenced block under
 * `## Proposed content` so the dispatcher writes exactly what was proposed — the same contract `file_change`
 * and `brand_change` already use.
 *
 * The fence is four backticks, not three: a brief that quotes the owner's code or a config file carries a ```
 * fence of its own, and a three-backtick wrapper ends at the first of them — the dispatcher would then write a
 * truncated brief, or refuse it for "missing ## Constraints" when the real cause was a fence.
 */
export const PROPOSED_CONTENT_FENCE = '````';

export function founderBriefProposalBody(brief: string, sources: string[]): string {
  const src = sources.length ? sources.map((s) => `- ${s}`).join('\n') : '- (nothing but this conversation)';
  return [
    `This is what I understood from what you gave me. It becomes \`${FOUNDER_BRIEF}\`, and every plan is written against it, so it is worth reading closely — edit the block below if I got anything wrong.`,
    '',
    '**Read from:**',
    src,
    '',
    '## Proposed content',
    '',
    PROPOSED_CONTENT_FENCE,
    brief.trim(),
    PROPOSED_CONTENT_FENCE,
    '',
    'Set `approved: true` to adopt it, or edit the block first. Set `approved: false` and I will ask again next cycle.',
  ].join('\n');
}
