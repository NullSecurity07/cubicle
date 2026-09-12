import type { Vault } from './vault.js';
import { sha256, nowIso } from './fs.js';
import { PRESSURE_HANDBOOK_PATH } from './pressure.js';

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
 * The `<Context>` rule as code: *if anything is already in the knowledge base, do not ask it — take it from
 * there.* The CEO's cabin interview asks only the questions the owner's own material does not already answer.
 *
 * Deterministic on purpose (Decision 14). A model asked "has the owner already told us who this is for?" will
 * answer differently on two runs over the same bytes, and the owner would eventually be asked a question they
 * answered yesterday. Two routes to "covered", both checkable by reading: the founder brief carries the
 * section that answers it, *written* rather than left as the template's own prompt; or the raw material
 * carries at least two of that question's cues.
 */
export interface QuestionCoverage {
  /** The founder-brief heading that answers this question, or '' when no section does. */
  section: string;
  /** Cues in the raw material. `INTERVIEW_CUES_NEEDED` of them must match. */
  cues: readonly RegExp[];
}

/** How many cues make an answer. Two: one word in passing is not one — "we tried to call you" is not an account. */
export const INTERVIEW_CUES_NEEDED = 2;

/** A written brief section this long counts as an answer. Shorter is a heading with a shrug under it. */
export const INTERVIEW_SECTION_CHARS = 40;

/** Index-aligned with `INTERVIEW_QUESTIONS`. */
export const INTERVIEW_COVERAGE: readonly QuestionCoverage[] = [
  {
    section: '## What the company is',
    // Every cue here has to carry the *thing being built* (review T4, Important 3). This list used to end in
    // `/it(?:'s| is) an? \w+/`, which matches "it is a mess" and "it's a shame" — and since cues are counted
    // across every message and every file at once, one loose match plus one ordinary one reached the
    // threshold on prose that answered nothing. What replaced it names a product, or says who it helps.
    cues: [
      /\bwe(?:'re| are)\s+building\b/i,
      /\bI(?:'m| am)\s+building\b/i,
      /\bthe product is\b/i,
      /\bwe(?:'re| are)\s+(?:making|selling|launching)\b/i,
      /\bwe\s+(?:build|make|sell|run)\s+\w+/i,
      /\b(?:it|this)(?:'s| is)\s+an?\s+(?:app|tool|service|platform|marketplace|product|site|website|shop|store|box|kit|subscription|newsletter|agency|plugin|extension|game|API)\b/i,
      /\bhelps\s+\w+/i,
    ],
  },
  {
    section: '## Who it is for',
    cues: [/\bit(?:'s| is)\s+for\b/i, /\bour\s+(?:customers?|users?|buyers?)\b/i, /\btoday they\b/i, /\bthey\s+(?:currently\s+)?(?:use|rely on|hack|pay)\b/i, /\bspreadsheets?\b/i, /\bworkaround\b/i],
  },
  {
    section: '## What already exists',
    cues: [/\bwe already have\b/i, /\bwait\s?list\b/i, /\bpaying customers?\b/i, /\bprototype\b/i, /\bMVP\b/, /\bthe domain\b/i, /\brepo\b|\bcodebase\b/i],
  },
  {
    section: '## What success looks like',
    cues: [/\bin\s+(?:three|3|six|6)\s+months\b/i, /\bby\s+(?:the end of\s+)?(?:the\s+)?(?:quarter|year)\b/i, /\bsuccess\s+(?:looks like|would be|means)\b/i, /\bthe (?:goal|target) is\b/i, /\bworth it if\b/i],
  },
  {
    // No brief section answers "what have you already tried that did not work": the cues are the whole of it.
    section: '',
    cues: [/\bwe tried\b/i, /\bI tried\b/i, /\bdid(?:n't| not)\s+work\b/i, /\bit failed\b|\bthat failed\b/i, /\bgave up on\b|\babandoned\b/i],
  },
  {
    section: '## Constraints',
    cues: [/\boff the table\b/i, /\bwe (?:will\s+)?(?:never|do ?n[o']t want to)\b/i, /\bno\s+(?:paid ads|fundraising|outsourcing|hardware|investors)\b/i, /\bnot interested in\b/i, /\bwe refuse to\b/i],
  },
];

/** The body under one `## ` heading, up to the next one. '' when the heading is not there. */
export function briefSectionBody(md: string, heading: string): string {
  const re = new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm');
  const m = md.match(re);
  if (m?.index === undefined) return '';
  return md.slice(m.index + m[0].length).split(/^## /m)[0].trim();
}

/**
 * Whether a brief section answers its question. Written, and not the template's own prompt text: an adopted
 * brief still carrying "One paragraph in the owner's own terms" under a heading has answered nothing, and
 * asking the owner nothing on the strength of it is the exact failure this check exists to prevent.
 */
export function sectionAnswers(brief: string, heading: string, template: string = founderBriefTemplate()): boolean {
  if (!heading) return false;
  const body = briefSectionBody(brief, heading);
  if (body.length < INTERVIEW_SECTION_CHARS) return false;
  return body !== briefSectionBody(template, heading);
}

/**
 * The material with everything the company wrote itself taken out of it, so the cue pass reads only what a
 * person actually said (review T4, Important 1).
 *
 * Two things go. **The template's own prose**, wherever it appears: an adopted brief carrying a heading with
 * the template's instructions still under it has answered nothing, and counting those words as cues is exactly
 * the failure Decision 15 exists to prevent — it was reachable, because `## Pressure test`'s prompt contains
 * "the workaround these people use today" and that is one of `## Who it is for`'s cues. **And every `## `
 * heading line**, because a heading is the template's word and not the owner's: `## Who it is for` matches
 * that same question's `/it is for/` cue, so a brief with both would have covered a question nobody answered.
 *
 * A written section keeps its body, which is the point: that text is an answer, whoever typed it.
 *
 * It cuts, and never adds — an owner's own `## ` heading is lost with the rest. That direction is the safe
 * one: a missed cue asks the owner a question they may have answered, where a false cue silently plans the
 * company around an answer that was never given.
 */
export function ownerAuthored(material: string, template: string = founderBriefTemplate()): string {
  let out = material;
  for (const h of FOUNDER_BRIEF_SECTIONS) {
    const body = briefSectionBody(template, h);
    if (body) out = out.split(body).join(' ');
  }
  return out.replace(/^\s*#{1,6}\s.*$/gm, ' ');
}

/** Which of the six the material already answers, index-aligned with `INTERVIEW_QUESTIONS`. */
export function coveredQuestions(material: string, brief = '', template: string = founderBriefTemplate()): boolean[] {
  const said = ownerAuthored(material, template);
  return INTERVIEW_COVERAGE.map((q) => {
    if (brief && sectionAnswers(brief, q.section, template)) return true;
    return q.cues.filter((c) => c.test(said)).length >= INTERVIEW_CUES_NEEDED;
  });
}

/** The questions still worth asking, in the CEO's order. Empty means the owner has already said all six. */
export function openInterviewQuestions(material: string, brief = '', template: string = founderBriefTemplate()): string[] {
  const covered = coveredQuestions(material, brief, template);
  return INTERVIEW_QUESTIONS.filter((_, i) => !covered[i]);
}

const COUNT_WORDS = ['no', 'One', 'Two', 'Three', 'Four', 'Five', 'Six'] as const;

/** The cabin message's title: "Three questions, while I get started". */
export function interviewAskTitle(n: number): string {
  return `${COUNT_WORDS[n] ?? String(n)} question${n === 1 ? '' : 's'}, while I get started`;
}

/**
 * The one message the CEO sends. Six numbered questions, answered in any depth, or skipped outright.
 *
 * It does not say "before I plan anything", because that is not true and the owner would catch it: the company
 * starts from whatever it already has in the same cycle these questions go out (spec §5.5 — one line in the
 * cabin is enough to plan from). What the answers buy is a better brief and a better *next* plan, so that is
 * what the message promises.
 *
 * `skipped` is how many the owner's own material already answered: saying so is the difference between a
 * company that read what it was given and one that did not. With none skipped the message is byte-identical to
 * the one it has always sent.
 */
export function renderInterviewAsk(questions: readonly string[] = INTERVIEW_QUESTIONS, skipped = 0): string {
  return [
    skipped > 0
      ? `I am starting from what you have already given me — you have answered ${skipped} of my six questions in it, so I am not asking those again. ${questions.length} left, to make sure I start from the right thing — answer the ones you want to, in any order, in your own words; one line each is plenty.`
      : 'I am starting from what you have already given me. Six questions, to make sure I start from the right thing — answer the ones you want to, in any order, in your own words; one line each is plenty.',
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

export type InterviewPhase = 'none' | 'asked' | 'answered' | 'skipped' | 'covered';

/** Where the interview stands, read from the transcript alone — no cache, no state file. */
export function interviewPhase(transcript: string | null): InterviewPhase {
  if (!transcript || !transcript.trim()) return 'none';
  if (/^## Already answered\b/m.test(transcript)) return 'covered';
  if (/^## Skipped\b/m.test(transcript)) return 'skipped';
  if (/^## Answer\b/m.test(transcript)) return 'answered';
  return 'asked';
}

/**
 * The transcript when the owner's own material answered all six and nobody was asked anything. A fifth phase
 * rather than a `## Skipped`, because the owner did not skip: writing it as a skip would put a decision in
 * their mouth that they never made (Decision 16).
 */
export function renderInterviewCovered(at: string): string {
  return [
    '# Founder interview', '',
    `_Not asked. On ${at.slice(0, 10)} the owner's own material already answered all ${INTERVIEW_QUESTIONS.length} questions, so the CEO took them from there rather than asking them again._`, '',
    '## Already answered', '',
    ...INTERVIEW_QUESTIONS.map((q, i) => `${i + 1}. ${q}`),
    '',
  ].join('\n');
}

/**
 * Which of the six a message the owner can already see actually carries.
 *
 * The resume path reads the questions out of the message rather than deriving them again (review T4,
 * Important 2). `createProposal` is idempotent on the deterministic id and does *not* rewrite the body, so a
 * resume that re-derived them from material that has since grown would leave the transcript recording one set
 * of questions and the owner reading another. A message with none of the six in it — an SP3-era one, or one an
 * older build wrote — falls back to all six, which is what that message said it was asking.
 */
export function questionsAsked(message: string): string[] {
  const found = INTERVIEW_QUESTIONS.filter((q) => message.includes(q));
  return found.length ? found : [...INTERVIEW_QUESTIONS];
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

/** The seven sections a founder brief has always carried. */
export const FOUNDER_BRIEF_SECTIONS_V1 = [
  '## What the company is',
  '## Who it is for',
  '## What already exists',
  '## What success looks like',
  '## Constraints',
  '## Candidate ideas',
  '## What we do not know',
] as const;

/** SP5b: the eighth. The company's own idea is a startup idea, and it takes the pressure test once. */
export const PRESSURE_TEST_SECTION = '## Pressure test';

/** The sections a founder brief must carry before the owner is asked to approve it. */
export const FOUNDER_BRIEF_SECTIONS = [...FOUNDER_BRIEF_SECTIONS_V1, PRESSURE_TEST_SECTION] as const;

/**
 * The day `## Pressure test` joined the brief. The migration, stated: a brief *proposed* before this date is
 * judged against the seven sections that existed when it was written, and one proposed on or after it owes all
 * eight. The date is the only fact the dispatcher has that separates the two — the shape cannot, because a
 * brief written yesterday and one written today look identical when both are missing the section (Decision 18).
 */
export const PRESSURE_TEST_SINCE = '2026-09-12';

/**
 * Which sections a brief is missing, or — for `## Pressure test` — has not actually written. `writtenAt` is the
 * proposal note's `created`; omitted, the brief is treated as written now and owes all eight. A `founder_brief`
 * note already sitting unanswered in `00 Inbox/` when this shipped is therefore adopted on the owner's click
 * rather than refused for a section the company had not thought of when it filed the note.
 *
 * The eighth section is the one whose *body* is checked (ruling H5). §4 is "the brief takes the test once", and
 * a brief that carries the heading with `founderBriefTemplate()`'s own instructions still under it has taken
 * nothing: the heading test would let the empty template be adopted as the company's founder brief, which is
 * the same failure Decision 15 rules out one layer up in `sectionAnswers`. The other seven keep the heading
 * test they have always had; they were not part of this sub-project and a stricter rule on them would refuse
 * briefs the company has already adopted.
 */
export function missingBriefSections(md: string, writtenAt = ''): string[] {
  const missing: string[] = FOUNDER_BRIEF_SECTIONS.filter((h) => !new RegExp(`^${h}\\s*$`, 'm').test(md));
  if (!missing.includes(PRESSURE_TEST_SECTION) && !sectionAnswers(md, PRESSURE_TEST_SECTION)) missing.push(PRESSURE_TEST_SECTION);
  if (writtenAt && writtenAt.slice(0, 10) < PRESSURE_TEST_SINCE) return missing.filter((h) => h !== PRESSURE_TEST_SECTION);
  return missing;
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
    PRESSURE_TEST_SECTION, '', 'The five parts, in this order, on the company as a whole. **Core Assumption:** the one belief that, if false, makes everything else irrelevant, as a falsifiable sentence. **Three Fatal Flaws:** the three most likely ways this dies, each naming a mechanism specific to this idea, market and customer — no generic advice. **Problem Validation:** vitamin, painkiller or hair on fire, and the workaround these people use today. **Founder-Market Fit:** why this owner, specifically. **Brutal Verdict:** STRONG, WEAK or PIVOT REQUIRED, in one word, then why. Never "it has potential, but". See `' + PRESSURE_HANDBOOK_PATH + '`.', '',
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
