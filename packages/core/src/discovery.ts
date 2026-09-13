import type { Vault } from './vault.js';
import { sha256, nowIso } from './fs.js';
import { parseNote } from './frontmatter.js';
import { listInbox } from './proposals.js';
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

/** The company's name note — and the target of the `brand_change` proposal the CEO's three ideas are filed as. */
export const BRAND_NAME_PATH = 'Brand/name.md';

/** The phrase itself. Never tested against a whole note on its own — see `asksForSurprise`. */
export const SURPRISE_ME = /\bsurprise me\b/i;

/**
 * Whether this note is the owner asking the CEO to propose the three ideas.
 *
 * **Anchored**, and in one place (whole-branch review, Important 3). The cabin tested it anchored — a line that
 * is only the phrase, or the phrase in the last three lines — while the material filter tested it bare, so a
 * 547-word founder brief that happened to describe *"a 'surprise me' button that picks a gift at random"* was
 * not a surprise request to the CEO (it took the long-brief branch and was promised a reading) and was not
 * material to discovery either: the owner's richest material, discarded without a word. One predicate, used by
 * both, is what stops the two drifting again.
 */
export function asksForSurprise(body: string): boolean {
  return /^\s*#?.*surprise me\s*$/im.test(body) || SURPRISE_ME.test(body.split('\n').slice(-3).join('\n'));
}

/** How many words the owner has to have written before a cabin note is something a research job could read. */
export const MATERIAL_WORDS = 3;

/**
 * Whether one thing the owner typed is material a discovery job could read (ruling FR-3).
 *
 * Finding F3: the first live run started a full research lifecycle on the note that said "surprise me", and
 * the brief it produced was fabricated — it had nothing to read, so it made claims about a name, an interview
 * and a founder-market fit that no file supported. "surprise me" is a request for ideas, "skip" is a refusal
 * to be interviewed, and two words to the CEO is a reply, not a brief. None of the three is something to
 * research, and the two sides of the question — the daemon deciding whether to start a job, and the tool that
 * hands the job its material — have to answer it the same way, which is why this lives here and not in either.
 *
 * The documented single-line path is untouched: a real one-line idea ("We sell meal kits to nurseries") is
 * three words or more and matches neither trigger, so it still buys discovery on cycle one (spec §1.3, §5.5).
 */
export function isDiscoveryMaterial(said: string): boolean {
  const t = said.trim();
  if (!t) return false;
  // A document is never "only a reply to the CEO", whatever phrases it happens to contain (review, Important 3).
  if (isLongPrompt(t)) return true;
  if (asksForSurprise(t) || isSkip(t)) return false;
  return t.split(/\s+/).filter(Boolean).length >= MATERIAL_WORDS;
}

/** The chosen idea, and the file the owner's pick was read from. */
export interface OwnerPick { line: string; path: string }

/** How the picked idea is introduced wherever discovery reads it. One sentence, the owner's decision, verbatim. */
export const OWNER_PICK_LABEL = "The owner picked this idea from the CEO's three:";

/**
 * The owner's pick, which **is** material (ruling FR-3, FR-3b): after "surprise me" the company has nothing to
 * read until the owner chooses one of the three ideas, and the chosen line is the one sentence that says what
 * the company is for. It is what starts discovery, and it is the first thing discovery reads.
 *
 * Two spellings of the same decision, in the order they appear: the approved `brand_change` carrying `chosen:`
 * (visible the moment the owner edits the note) and `Brand/name.md` once the dispatcher has written it — the
 * latter only when a proposal the owner approved is what put the name there. A name that was simply always in
 * the vault (a scaffold, an owner's own edit) is not a decision anyone just made, and reading it as unread
 * material would buy a research lifecycle off a file nobody touched.
 */
export function ownerPick(vault: Vault): OwnerPick | null {
  const proposals = listInbox(vault).filter((n) => n.data.kind === 'brand_change' && n.data.target === BRAND_NAME_PATH);
  const picked = proposals.find((n) => n.data.approved === true && n.data.chosen !== null && n.data.chosen !== undefined);
  if (picked) {
    const line = picked.body.split('\n').map((l) => l.trim()).find((l) => new RegExp(`^${Number(picked.data.chosen)}\\.\\s`).test(l));
    if (line) return { line, path: picked.path };
  }
  if (!proposals.some((n) => n.data.approved === true)) return null;
  const brand = parseNote(vault.readTextOrNull(BRAND_NAME_PATH) ?? '');
  const name = String(brand.data.name ?? '').trim();
  if (!name) return null;
  return { line: [name, String(brand.data.tagline ?? '').trim()].filter(Boolean).join(' — '), path: BRAND_NAME_PATH };
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

/** The cabin message's title: "Three questions, and how I would answer them". */
export function interviewAskTitle(n: number): string {
  return `${COUNT_WORDS[n] ?? String(n)} question${n === 1 ? '' : 's'}, and how I would answer them`;
}

/**
 * Where one of the CEO's own answers came from — the whole of ruling P8-13's honesty rule, in three words.
 *
 * The owner's complaint from the live run was that after "surprise me" and a pick, the six founder questions
 * were put to *them* — about an idea the company had invented. So the CEO answers first, and every answer says
 * what it rests on: the idea it is reading, a file in the vault, or nothing at all. Without the tag the owner
 * cannot tell the company's reading of its own idea from something they said, and neither can the research
 * office writing the founder brief from the same transcript.
 */
export const INTERVIEW_TAGS = ['from the idea', 'from the vault', 'unstated'] as const;
export type InterviewTag = (typeof INTERVIEW_TAGS)[number];

/** One of the CEO's six answers, with the tag that says what it rests on. */
export interface CeoAnswer { text: string; tag: InterviewTag }

/** What an answer says when the CEO does not know. The owner's own word, never a guess (ruling FR-4, P8-13). */
export const CEO_UNKNOWN = 'I do not know this yet — nothing we have says it, and I am not going to guess.';

/** The legend every reader of the transcript gets, so a tag is never read as the owner's word. */
export const INTERVIEW_TAG_LEGEND = 'Answers tagged [unstated] are unknown; answers tagged [from the idea] are the CEO\'s own reading of the idea, not the owner\'s word; answers tagged [from the vault] rest on a file or a message; **You:** lines are the owner\'s.';

/** How long one answer may run in the transcript. One line each, the same as the owner is asked for. */
export const CEO_ANSWER_CHARS = 600;

/** Six answers the CEO does not have — the fallback when no model replied. The ask still goes out. */
export function unstatedAnswers(n: number = INTERVIEW_QUESTIONS.length): CeoAnswer[] {
  return Array.from({ length: n }, () => ({ text: CEO_UNKNOWN, tag: 'unstated' as InterviewTag }));
}

/** One answer's body and tag. A body with no tag on the end is `unstated`: an untagged claim is not evidence. */
function splitTag(raw: string): CeoAnswer {
  const body = raw.replace(/\s+/g, ' ').trim().replace(/^\*\*\s*/, '').replace(/\s*\*\*$/, '').trim();
  const m = body.match(/\[\s*(from the idea|from the vault|unstated)\s*\]\s*\.?\s*$/i);
  const text = (m?.index === undefined ? body : body.slice(0, m.index)).trim().slice(0, CEO_ANSWER_CHARS);
  const tag = (m ? m[1].toLowerCase() : 'unstated') as InterviewTag;
  if (!text) return { text: CEO_UNKNOWN, tag: 'unstated' };
  return { text, tag };
}

/**
 * The model's six answers, parsed **defensively** (ruling P8-13). A model that drops a tag, answers five of
 * six, numbers them `1)` instead of `1.`, or replies with nothing at all must not cost the owner their ask: a
 * missing tag is `unstated`, a missing answer is `unstated`, and no reply at all is six of them.
 *
 * Deliberately not a schema and not a second model call. The worst case here is "the CEO says it does not
 * know", which is the truthful answer anyway and is exactly what the owner is being invited to correct.
 */
export function parseCeoAnswers(raw: string | null, count: number = INTERVIEW_QUESTIONS.length): CeoAnswer[] {
  const found: (CeoAnswer | undefined)[] = [];
  const text = (raw ?? '').replace(/\r/g, '').trim();
  if (text) {
    for (const block of text.split(/^(?=\s{0,3}\d{1,2}[.)]\s)/m)) {
      const m = block.trim().match(/^(\d{1,2})[.)]\s*([\s\S]*)$/);
      if (!m) continue;
      const i = Number(m[1]) - 1;
      if (i < 0 || i >= count || found[i]) continue;
      found[i] = splitTag(m[2]);
    }
  }
  return Array.from({ length: count }, (_, i) => found[i] ?? { text: CEO_UNKNOWN, tag: 'unstated' as InterviewTag });
}

/** One rendered answer line, the one spelling the message, the transcript and both parsers agree on. */
export function renderCeoAnswer(a: CeoAnswer): string { return `**CEO:** ${a.text} [${a.tag}]`; }

/**
 * The CEO's answers read back out of anything that carries them — the transcript's `## Answers` section, or the
 * cabin message the owner can already see. One parser, because `askInterview`'s resume path reads them off the
 * message (the message is what the owner is looking at) and discovery reads them off the transcript.
 */
export function ceoAnswersFrom(text: string | null, count: number = INTERVIEW_QUESTIONS.length): CeoAnswer[] {
  const lines = (text ?? '').split('\n').filter((l) => l.includes('**CEO:**'));
  return Array.from({ length: count }, (_, i) => (lines[i] === undefined ? { text: CEO_UNKNOWN, tag: 'unstated' as InterviewTag } : splitTag(lines[i].replace(/^[\s\S]*?\*\*CEO:\*\*\s*/, ''))));
}

/**
 * The one message the CEO sends — its **own** six answers, for the owner to add to or correct (ruling P8-13).
 *
 * It is no longer a questionnaire. The owner's complaint from the live run was that the company put the six
 * founder questions to them about an idea the company had just invented; answering them is the CEO's job, and
 * the owner's job is to read the answers and say where they are wrong. So the questions come with an answer
 * each, every answer carries the tag that says what it rests on, and the ask at the end is "add anything,
 * correct me, or say go" — not "answer these".
 *
 * `skipped` is how many the owner's own material already answered: those are not put back to them, because
 * reading their own words back at them is the same discourtesy in a different direction.
 */
export function renderInterviewAsk(questions: readonly string[] = INTERVIEW_QUESTIONS, skipped = 0, answers: readonly CeoAnswer[] = unstatedAnswers(questions.length)): string {
  const qs = questions.slice(0, 6);
  return [
    skipped > 0
      ? `You have answered ${skipped} of my six questions in what you already gave me, so those are not here. Here is how I would answer the ${qs.length} that are left from what I have — add anything, correct me, or say go.`
      : 'Here is how I would answer these six from what I have — add anything, correct me, or say go.',
    '',
    ...qs.flatMap((q, i) => [`**${i + 1}. ${q}**`, renderCeoAnswer(answers[i] ?? { text: CEO_UNKNOWN, tag: 'unstated' }), '']),
    'Anything tagged [unstated] is something I do not know — those are the ones worth your time. [from the idea] is my own reading of the idea, not your word for it.',
    '',
    // The message must not promise something the daemon no longer does (finding F5, ruling FR-6, P8-13): the
    // owner's next message is an *addition*, "go" or "skip" closes this without one, and a question leaves it
    // open. Each of those three is what the code does, said in the owner's own reading order.
    'Add anything, correct me, or reply "go" if this is right; "skip" drops it. A question to me leaves this open. What stands here goes into the founder brief the next plan is written against.',
  ].join('\n');
}

/** An owner reply that means "stop asking". Deliberately narrow: a one-word answer, not a word inside a sentence. */
export function isSkip(text: string): boolean {
  return /^\s*(skip|no thanks|not now|later)\s*[.!]?\s*$/i.test(text);
}

/**
 * An owner reply that means "your answers are right" — the `go` of ruling P8-13. It closes the interview with
 * **no** addition, and it is what lets the brief say the owner endorsed the CEO's answers.
 *
 * Narrow and anchored, for the same reason `isSkip` is: "go" inside a sentence is a word, and an interview
 * closed on a word is finding F5 again. Punctuation is allowed because people type "go." and mean go.
 */
export function endorsesInterview(text: string): boolean {
  return /^\s*(go|go ahead|ok|okay|k|yes|yep|yup|correct|right|looks? right|looks? good|sounds? right|sounds? good|that'?s right|all good|fine)\s*[.!]?\s*$/i.test(text);
}

/** How many words an answer on one line has to have before it is taken as the owner's answer to all six. */
export const INTERVIEW_ANSWER_WORDS = 12;

/**
 * Whether what the owner just typed is an **answer**, and so closes the interview.
 *
 * The first live run's finding F5: the interview closed on the owner's next message whatever it said, so a
 * complaint, a question or "your text is only half" would have been filed as the six answers and planned
 * against. Ruling FR-6 draws the line in code rather than with a model call (a classifier costs a call, and
 * the spec wants the interview to cost nothing): "skip" closes it; so does an answer — two non-empty lines, or
 * a dozen words that are not a question. Anything else leaves the six questions open and gets an ordinary
 * reply from the CEO that says so.
 */
export function closesInterview(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (isSkip(t)) return true;
  // "go" is one word and would never clear the floor below, and it is the single most likely thing an owner
  // reading six answers they agree with will type (ruling P8-13).
  if (endorsesInterview(t)) return true;
  if (t.split('\n').filter((l) => l.trim()).length >= 2) return true;
  return t.split(/\s+/).filter(Boolean).length >= INTERVIEW_ANSWER_WORDS && !t.endsWith('?');
}

export type InterviewPhase = 'none' | 'asked' | 'answered' | 'skipped' | 'covered';

/** The heading that records "the owner read the CEO's answers and said go". */
export const INTERVIEW_ENDORSED_HEADING = '## Endorsed';
/** The heading the CEO's own six answers sit under, and the material discovery reads. */
export const INTERVIEW_ANSWERS_HEADING = '## Answers';

/**
 * The owner has actually spoken in this transcript (ruling P8-13). Three spellings, in the order they appeared:
 * a `**You:**` addition under the CEO's answers, an `## Endorsed` block where they read those answers and said
 * go, and — for a transcript written before P8-13 — the old `## Answer` section where the owner answered all
 * six themselves.
 *
 * The CEO's own `## Answers` are deliberately **not** one of them: they are the company's reading of its own
 * idea, and a founder brief that cited them as the owner's word would be the very lie `checkFounderBrief`
 * rule 3 exists to catch. `## Answers` does not match `/^## Answer\b/` — the `\b` fails against the `s` — so
 * the legacy spelling stays exact rather than swallowing the new section.
 */
export function ownerAnsweredInterview(transcript: string | null): boolean {
  if (!transcript) return false;
  return /^\*\*You:\*\*/m.test(transcript) || /^## Endorsed\b/m.test(transcript) || /^## Answer\b/m.test(transcript);
}

/**
 * Where the interview stands, read from the transcript alone — no cache, no state file.
 *
 * `asked` covers the new middle state as well as the old one: the CEO has answered the six itself and the owner
 * has not spoken yet. That is deliberate — callers ask this question to find out whether the company is waiting
 * on the owner, and it is (ruling P8-13 adds no phase name, so nothing downstream has to learn one).
 */
export function interviewPhase(transcript: string | null): InterviewPhase {
  if (!transcript || !transcript.trim()) return 'none';
  if (/^## Already answered\b/m.test(transcript)) return 'covered';
  if (/^## Skipped\b/m.test(transcript)) return 'skipped';
  if (ownerAnsweredInterview(transcript)) return 'answered';
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

/**
 * The transcript as the CEO leaves it after answering the six itself and putting them to the owner.
 *
 * A transcript, not a questionnaire (ruling P8-13): the questions, then `## Answers` with one `**CEO:**` line
 * each, and the owner's `**You:**` additions appended under them. `## Answers` is last on purpose — an
 * addition is appended to the end of the file, and it has to land under the answers it is adding to.
 */
export function renderInterviewAsked(at: string, questions: readonly string[] = INTERVIEW_QUESTIONS, answers: readonly CeoAnswer[] = unstatedAnswers(questions.length)): string {
  const qs = questions.slice(0, 6);
  return [
    '# Founder interview', '',
    `_The CEO answered these itself on ${at.slice(0, 10)} and put the answers to the owner. The owner adds to them or corrects them in the cabin; an addition — or "go", or "skip" — closes the interview, and a question or a quick note to the CEO leaves it open (rulings FR-6, P8-13)._`, '',
    `_${INTERVIEW_TAG_LEGEND}_`, '',
    '## Questions', '',
    ...qs.map((q, i) => `${i + 1}. ${q}`),
    '',
    INTERVIEW_ANSWERS_HEADING, '',
    ...qs.map((_q, i) => `${i + 1}. ${renderCeoAnswer(answers[i] ?? { text: CEO_UNKNOWN, tag: 'unstated' })}`),
    '',
  ].join('\n');
}

/**
 * Close the interview with whatever the owner said (ruling P8-13). Three endings, and the difference between
 * them is what the founder brief is allowed to claim:
 *
 * - **skip** — recorded as a skip. The CEO's answers stand as the company's own reading and nothing more.
 * - **"go"** — the owner read the answers and endorsed them, which the brief may cite as such. No `**You:**`
 *   line is invented for them: they added nothing, and putting words under their name would be the same
 *   fabrication in a smaller font.
 * - **anything else that closes** — appended as a `**You:**` addition *under* the CEO's answers. It never
 *   replaces them: the owner was asked to add and correct, not to answer.
 */
export function closeInterview(transcript: string, answer: string, at = nowIso()): string {
  const base = transcript.trimEnd();
  if (isSkip(answer)) return `${base}\n\n## Skipped\n\n_The owner skipped the interview on ${at.slice(0, 10)}. The answers above are the CEO's own._\n`;
  if (endorsesInterview(answer)) return `${base}\n\n${INTERVIEW_ENDORSED_HEADING}\n\n_The owner read the CEO's answers on ${at.slice(0, 10)} and said go: they stand as agreed._\n`;
  return `${base}\n\n**You:** ${answer.trim()}\n\n_Added ${at.slice(0, 10)}._\n`;
}

/**
 * The owner's own words from a transcript, or '' when there are none — their `**You:**` additions, or the
 * `## Answer` body of a transcript written before P8-13. Never the CEO's answers.
 */
export function interviewAnswer(transcript: string | null): string {
  if (!transcript) return '';
  const i = transcript.search(/^\*\*You:\*\*/m);
  if (i >= 0) {
    return transcript.slice(i).replace(/^\*\*You:\*\*\s*/gm, '').replace(/^\s*_Added \d{4}-\d{2}-\d{2}\._\s*$/gm, '').trim();
  }
  const after = transcript.split(/^## Answer\s*$/m)[1];
  return (after ?? '').replace(/^\s*_\d{4}-\d{2}-\d{2}_\s*$/m, '').trim();
}

/**
 * What discovery reads out of the transcript: the CEO's six answers **with their tags**, plus the owner's
 * additions under them (ruling P8-13). One block, verbatim, because the tags are the whole point — a research
 * office that cannot tell `[from the idea]` from `[from the vault]` from the owner's own line will write a
 * founder brief that claims all three are the same thing.
 *
 * Cut at the next `## ` heading, so a `## Skipped` or `## Endorsed` block below is not read as material.
 */
export function interviewAnswersSection(transcript: string | null): string {
  if (!transcript) return '';
  const parts = transcript.split(new RegExp(`^${INTERVIEW_ANSWERS_HEADING}\\s*$`, 'm'));
  return parts.length < 2 ? '' : parts[1].split(/^## /m)[0].trim();
}

/**
 * The seven sections a founder brief carried before 2026-09-12 — the documented historical list, exported for
 * the tests that build an SP3-era brief and for anyone reading `PRESSURE_TEST_SINCE` and asking what a brief
 * from before it looks like. Nothing in `src/` consumes it but the line below; that is the point of it.
 */
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
    PRESSURE_TEST_SECTION, '', 'The five parts, in this order, on the company as a whole. **Core Assumption:** the one belief that, if false, makes everything else irrelevant, as a falsifiable sentence. **Three Fatal Flaws:** the three most likely ways this dies, each naming a mechanism specific to this idea, market and customer — no generic advice. **Problem Validation:** vitamin, painkiller or hair on fire, and the workaround these people use today. **Founder-Market Fit:** why this owner, specifically. **Brutal Verdict:** the verdict first — STRONG, WEAK or PIVOT REQUIRED — then the reasons. Never "it has potential, but". See `' + PRESSURE_HANDBOOK_PATH + '`.', '',
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
