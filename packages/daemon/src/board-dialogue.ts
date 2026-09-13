/**
 * The board argues in the open (SP8 §3).
 *
 * `board_dialogue: brief` is the session the board has held since SP5b: three advisors write a pre-mortem each,
 * the chair merges them, and the only thing anybody can read afterwards is the merge. `full` — the default —
 * is this file: the chair states each of the five pressure-test questions **in its own words**, the other two
 * advisors answer it in turn seeing everything said so far, and the chair rules on the round in the open before
 * moving on. Six rounds, one `Meetings/` transcript written after every single turn, and the same
 * `readPressureVerdict` parse at the end, so the two paths differ in what the owner can read and in nothing else.
 *
 * **The budget is what shapes the round.** Seventeen model calls is the ceiling (spec §3), and five parts × two
 * advisors is ten of them before the chair has said a word. That leaves seven: six chair turns and the one
 * re-ask a refused chair has always had. Six chair turns for five rounds plus a verdict means the chair speaks
 * **once per round**, so its turn has to do both halves of a chair's job at once — close the round just argued
 * and open the next one. That is not a compromise so much as what chairing actually looks like: "Right, so the
 * pain is real and nobody has priced delivery. Next: why us?"
 *
 * Nothing here guesses. When the material in front of the board does not answer a round's question, the chair
 * writes `QUESTION FOR THE OWNER:` instead of a finding, the verdict still stands on what it does know, and the
 * chair files one cabin message asking the owner for all of them at once. The next session on the same subject
 * re-runs only the rounds that asked, and only once the owner has actually said something.
 */
import {
  type Vault, type Org, type ModelTier, nowIso, stampForFilename, stringifyNote, idFromKey,
  officeHolder, listInbox, createProposal, renderRubric, setSection, sha256,
  PRESSURE_PARTS, type PressurePart, PRESSURE_HANDBOOK_PATH, BANNED_HEDGE, OWNER_QUESTION, isOwnerQuestion, hedges,
  PRESSURE_TEST_SECTION, FOUNDER_BRIEF, founderBriefProposalBody, briefFromProposalBody, citedPaths,
  checkFounderBrief, briefCheckContext, UNSTATED,
} from '@cubicle/core';
import {
  type HeartbeatDeps, type BoardSubject, type BoardMerge, type BoardSessionResult,
  boardSubject, boardAgenda, mergeBoardVerdict, unansweredMerge, chairReaskPrompt, chairLostNote,
  chairFormat, ADVISOR_ASK, askAs, advisorSystem, SUBJECT_CHARS, CHAIR_IDEA_TOKENS,
  runBoardSession, writeBoardDecision, BOARD_UNREVIEWED_NOTE, BOARD_OPEN_QUESTIONS,
} from './heartbeat.js';

/** The five argued rounds plus the verdict. Six is a consequence of `PRESSURE_PARTS`, not a second opinion. */
export const BOARD_DIALOGUE_ROUNDS = PRESSURE_PARTS.length + 1;

/** The hard ceiling (spec §3): 5 rounds × 2 advisors + 6 chair turns + the chair's one re-ask. */
export const BOARD_DIALOGUE_MAX_CALLS = PRESSURE_PARTS.length * 2 + BOARD_DIALOGUE_ROUNDS + 1;

/** How long an advisor's turn may be, in words and in the tokens that buys. 120 words is roughly 200 tokens. */
export const ADVISOR_TURN_WORDS = 120;
export const ADVISOR_TURN_TOKENS = 280;

/** How long a chair's round turn may be. The verdict turn gets `CHAIR_IDEA_TOKENS`, which is far larger. */
export const CHAIR_TURN_TOKENS = 500;

/** How much of a turn goes out on the `meeting.turn` event; the note always carries the whole of it. */
export const TURN_EVENT_CHARS = 280;

/** How much of the transcript so far a speaker is shown. A whole session is longer than a turn needs. */
export const TRANSCRIPT_CHARS = 4000;

/** The three labels a chair's round turn is read by. Written once, because the prompt and the parse share them. */
export const FINDING_LABEL = 'FINDING:';
export const NEXT_LABEL = 'NEXT:';

/** The section of the transcript note that carries the round findings, machine-readably, for the next session. */
export const BOARD_FINDINGS_SECTION = '## Findings';

/** What a carried-over round says in the transcript, so a reader can tell an argument from a reuse. */
export const REUSED_NOTE = 'Carried over from the session of';

/** What a caller knows about the session before it starts, and the note has to carry the moment it closes. */
export interface BoardSessionOpts {
  /** The id of the `Decisions/` note this session's caller will write: `board-<slug>`, `premortem-<heartbeat>`. */
  decision?: string;
}

/** One turn as it is written to the note and emitted. */
export interface BoardTurn { round: number; role: string; text: string }

/** The empty session: no board room, or a board whose charters are all gone. Identical to the brief path's. */
function noBoard(s: BoardSubject): BoardSessionResult {
  return {
    verdict: 'pass', findings: [], pressure: null, rubric: null, refused: null,
    advisors: [], transcript: '', answered: 0, subject: s, calls: 0, reasked: false, chairLost: null,
    chairText: '', notePath: '', questions: [], findingsByPart: {},
  };
}

/** `this cycle's plan` → `plan`; an idea keeps the slug it already has. Filenames only. */
function subjectSlug(s: BoardSubject): string {
  return s.slug ?? 'plan';
}

/** The sections of a subject the **board itself** writes back, which must not count as the subject changing. */
const BOARD_WRITTEN_SECTIONS = ['## The board', '## Score', PRESSURE_TEST_SECTION];

/**
 * What the board actually read, with its own writing taken out.
 *
 * The digest below is the whole of the re-run rule, so what goes into it decides what "the same subject" means.
 * An idea card gains `## The board` and a re-rendered `## Score` from the session that judged it, and a brief
 * gains its `## Pressure test` — digest those and every subject would look changed the moment it was judged,
 * and no round would ever be reused. Digest without them and what is left is the material: the dossier, the
 * evidence, the owner's own words.
 */
export function subjectMaterial(text: string): string {
  const out: string[] = [];
  let dropping = false;
  for (const line of text.replace(/\r/g, '').split('\n')) {
    if (/^## /.test(line)) dropping = BOARD_WRITTEN_SECTIONS.includes(line.trim());
    if (!dropping) out.push(line);
  }
  return out.join('\n').trim();
}

/**
 * How a subject is recognised across sessions, so the re-run rule can find the last one.
 *
 * **The content is part of the key** (review I2). Keyed on the kind and the slug alone, every cycle's plan was
 * "the plan": cycle two found cycle one's session, reused all five rounds because each had reached a finding,
 * made no advisor call at all and voted on today's plan over yesterday's argument. A session is reused only
 * when the board would be reading the very same words — which is exactly when re-arguing would be waste, and
 * exactly when the owner answering a question is the only thing that has changed.
 *
 * An explicit `key` wins, for a subject whose material the caller can identify better than its text can.
 */
export function boardSubjectKey(s: BoardSubject): string {
  if (s.key) return s.key;
  return `${s.kind}:${s.kind === 'plan' ? 'plan' : subjectSlug(s)}:${subjectDigest(s.text)}`;
}

/** The digest the key carries: short enough to read in frontmatter, long enough not to collide. */
export function subjectDigest(text: string): string {
  return sha256(subjectMaterial(text)).slice(0, 12);
}

/**
 * What the chair asks the board to answer, round by round. The question itself comes from the model — that is
 * the point of the dialogue — but what it is a question *about* comes from core's one ordered list, so the
 * rounds, the headings and the parse can never drift apart.
 */
export function chairRoundPrompt(s: BoardSubject, o: {
  close: PressurePart | null;
  open: PressurePart | null;
  challenge: string;
  transcript: string;
  verdict: boolean;
}): string {
  const what = s.kind === 'plan' ? 'this plan' : s.kind === 'brief' ? 'this founder brief' : 'this idea';
  const lines: string[] = [
    `You chair the board of this company. The board is pressure-testing ${what}, in the open, one question at a time.`,
    '',
    `What is on the table — "${s.title}":`,
    '',
    s.text.slice(0, SUBJECT_CHARS),
    '',
    'The board so far:',
    '',
    o.transcript || '(nothing yet: you speak first)',
    '',
  ];
  if (o.close) {
    if (o.challenge) lines.push(`Your advisors did not settle that round: ${o.challenge}. Say so in one sentence, to them, by name, before you rule — this is the one challenge that round gets.`, '');
    lines.push(
      `First, close the round on **${o.close}**. Write one line beginning \`${FINDING_LABEL}\` — what the board now holds on that question, in at most 40 words${o.close === 'Three Fatal Flaws' ? ', and then at most four bullets under it, each a flaw specific to this subject and the change that would fix it' : ''}.`,
      `If what is in front of you does not answer it, write \`${OWNER_QUESTION} <the one thing only the owner can tell you>\` instead of the finding, and do not guess. A question is a better answer than an invention.`,
      '',
    );
  }
  if (o.open) {
    lines.push(
      `Then state the question this board must answer next, on one line beginning \`${NEXT_LABEL}\` — the question of **${o.open}** put in your own words, about this subject and no other, in at most 40 words. What it has to get at: ${ADVISOR_ASK[o.open]}`,
      'Ask it. Do not answer it — your advisors answer next.',
      '',
    );
  }
  if (o.verdict && s.kind !== 'plan') {
    lines.push(
      `Then deliver the board's verdict on ${what}. The test is: would Paul Graham fund this in its current form? Write exactly this, in this order:`,
      '',
      ...chairFormat(),
    );
  } else if (o.verdict) {
    lines.push(
      `Then deliver the board's verdict on ${what}. First line exactly "VERDICT: pass" or "VERDICT: return". Then at most four bullets, each a failure mode this plan does not answer and the change that fixes it. Return the plan only if running it as written would waste the cycle; you cannot delay.`,
    );
  }
  return lines.join('\n');
}

/** What one advisor is asked, on one round, having read everything said so far. */
export function advisorRoundPrompt(s: BoardSubject, part: PressurePart, question: string, transcript: string): string {
  return [
    `You are on the board of this company. The board is pressure-testing "${s.title}" one question at a time, and it is your turn.`,
    '',
    'What is on the table:',
    '',
    s.text.slice(0, SUBJECT_CHARS),
    '',
    'The board so far:',
    '',
    transcript || '(nothing yet)',
    '',
    `The chair has asked, on **${part}**:`,
    '',
    question,
    '',
    `Answer that question and nothing else, in at most ${ADVISOR_TURN_WORDS} words. Concrete and specific to this subject — a mechanism, a number, a name, not a category. No preamble and no headings. If you disagree with what an advisor said above, say so and say why. Decide: never write "${BANNED_HEDGE}".`,
    `The catalogue to hunt in is \`${PRESSURE_HANDBOOK_PATH}\`.`,
  ].join('\n');
}

/** The verdict words an answer names, so two advisors can be told apart by what they concluded. */
function verdictWordsIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b(STRONG|WEAK|PIVOT)\b/gi)) out.add(m[1].toUpperCase());
  return out;
}

/**
 * Why the chair should challenge this round, or `''` for a round that settled. Two triggers, both deterministic
 * so the challenge costs no call of its own: an advisor that used the banned hedge (the same regex that refuses
 * a chair, so what provokes one and what refuses one cannot drift), or two advisors that reached different
 * verdicts — or said in as many words that they disagree.
 */
export function challengeReason(answers: { role: string; text: string }[]): string {
  const said = answers.filter((a) => a.text.trim());
  const hedged = said.filter((a) => hedges(a.text));
  if (hedged.length) return `${hedged.map((a) => a.role).join(' and ')} hedged with "${BANNED_HEDGE}", which is a way of not deciding`;
  if (said.some((a) => /\bdisagree\b/i.test(a.text))) return 'they disagree with each other';
  const words = said.map((a) => verdictWordsIn(a.text)).filter((w) => w.size > 0);
  if (words.length > 1 && new Set(words.flatMap((w) => [...w])).size > 1) return 'they reached different verdicts';
  return '';
}

/**
 * The block a chair's round turn wrote under one label: the rest of that line plus every line after it, up to
 * the next label, the verdict's own machine lines, or a heading. Forgiving about the decoration a model puts on
 * a label it was shown in backticks — bold, a bullet, a heading — for the same reason `pressure.ts` is.
 */
function blockAfter(text: string, label: string): string {
  const lines = text.replace(/\r/g, '').split('\n');
  const head = new RegExp(`^[ \\t]*(?:[-*+][ \\t]+)?(?:#{1,6}[ \\t]*)?[*_\`]*[ \\t]*${label.replace(':', '')}[*_\`]*[ \\t]*:[*_\`]*[ \\t]*`, 'i');
  const stop = /^[ \t]*(?:[-*+][ \t]+)?(?:#{1,6}[ \t]*)?[*_`]*[ \t]*(?:FINDING|NEXT|QUESTION FOR THE OWNER|VERDICT|RUBRIC|WEDGE)[*_`]*[ \t]*[:—–-]/i;
  const at = lines.findIndex((l) => head.test(l));
  if (at < 0) return '';
  const out = [lines[at].replace(head, '')];
  for (let i = at + 1; i < lines.length; i++) {
    if (stop.test(lines[i]) || /^[ \t]*#{1,6}[ \t]+\S/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join('\n').trim();
}

/**
 * The round's finding out of the chair's turn: its `FINDING:` block, or the question it asked the owner instead.
 * A chair that wrote neither has still said something — its turn, minus the question it went on to ask — and
 * that is kept rather than dropped, because a round with no finding at all is a hole in the five parts.
 */
export function findingIn(turn: string): string {
  const question = blockAfter(turn, OWNER_QUESTION);
  if (question) return `${OWNER_QUESTION} ${question}`;
  const finding = blockAfter(turn, FINDING_LABEL);
  if (finding) return finding;
  const rest = turn.split('\n').filter((l) => !new RegExp(`^[ \\t]*[*_\`]*[ \\t]*${NEXT_LABEL}`, 'i').test(l)).join('\n').trim();
  return rest.slice(0, 400);
}

/** The question the chair put to its advisors, out of its turn. Its whole turn when it wrote no `NEXT:` line. */
export function questionIn(turn: string, part: PressurePart): string {
  return blockAfter(turn, NEXT_LABEL) || turn.trim() || `${part}: ${ADVISOR_ASK[part]}`;
}

/** The five parts as the chair's own answer, built from the round findings (spec §3 "Parsing"). */
export function partsText(findings: Partial<Record<PressurePart, string>>): string {
  return PRESSURE_PARTS
    .map((part) => `## ${part}\n\n${(findings[part] ?? '').trim() || '(the board did not reach this)'}`)
    .join('\n\n');
}

/** The `## Findings` section of the note: the same five parts, read back by the next session on this subject. */
function findingsSection(findings: Partial<Record<PressurePart, string>>): string {
  return PRESSURE_PARTS
    .map((part) => `### ${part}\n\n${(findings[part] ?? '').trim() || '(not reached)'}`)
    .join('\n\n');
}

/** …and reading it back. `(not reached)` is a placeholder, never a finding to reuse. */
export function parseFindingsSection(body: string): Partial<Record<PressurePart, string>> {
  const section = (body.split(new RegExp(`^${BOARD_FINDINGS_SECTION}[ \\t]*$`, 'm'))[1] ?? '').split(/^## /m)[0];
  const out: Partial<Record<PressurePart, string>> = {};
  for (const chunk of section.split(/^### /m).slice(1)) {
    const nl = chunk.indexOf('\n');
    const name = (nl < 0 ? chunk : chunk.slice(0, nl)).trim() as PressurePart;
    const text = (nl < 0 ? '' : chunk.slice(nl + 1)).trim();
    if (!PRESSURE_PARTS.includes(name)) continue;
    if (text && text !== '(not reached)') out[name] = text;
  }
  return out;
}

/** The last board dialogue held on this subject, with the findings it reached. */
export function priorBoardDialogue(vault: Vault, subjectKey: string): { opened: string; path: string; findings: Partial<Record<PressurePart, string>> } | null {
  const found = vault.list('Meetings', { ext: '.md' })
    .map((rel) => ({ rel, note: vault.readNoteOrNull(rel) }))
    .filter((x) => x.note && x.note.data.room === 'board' && x.note.data.subject_key === subjectKey)
    .sort((a, b) => String(b.note!.data.opened ?? '').localeCompare(String(a.note!.data.opened ?? '')));
  const top = found[0];
  if (!top) return null;
  return { opened: String(top.note!.data.opened ?? ''), path: top.rel, findings: parseFindingsSection(top.note!.body) };
}

/** Whether the owner has said anything in the cabin since a stamp — "the question has an answer in the vault". */
export function ownerSpokeSince(vault: Vault, since: string): boolean {
  if (!since) return false;
  return listInbox(vault).some((n) => n.data.kind === 'message' && n.data.from === 'owner' && String(n.data.created ?? '') > since);
}

/**
 * The id of the one cabin message a set of questions goes out as.
 *
 * Keyed on the **questions**, not on the session (review I3). Keyed on the session — whose id carries the
 * timestamp it opened at — the same unanswered question arrived in the cabin as a brand-new "The board needs 1
 * answer from you" every cycle the board sat, which is the company nagging. Keyed on the text, a question is
 * asked once; when the board finds a different one, that is a different message.
 */
export function boardQuestionsMessageId(subjectKey: string, questions: string[]): string {
  return idFromKey('msg', `board-questions:${subjectKey}:${sha256(questions.map(bareQuestion).join('\n')).slice(0, 12)}`);
}

/** A question without its marker, which is how it is written to the owner and how it is recognised again. */
export function bareQuestion(q: string): string {
  return q.replace(new RegExp(`^${OWNER_QUESTION}\\s*`, 'i'), '').trim();
}

/** The line a questions message opens on — its title, and the marker that finds it again in the inbox. */
export const BOARD_QUESTIONS_TITLE_RE = /^#\s+The board needs \d+ answers? from you\s*$/m;

/**
 * Every question this chair has already put to the owner, read off the messages it sent. The notes are the
 * record: nothing is cached, so a restarted daemon asks exactly what a running one would.
 */
export function questionsAlreadyAsked(vault: Vault, chair: string): string[] {
  return listInbox(vault)
    .filter((n) => n.data.kind === 'message' && n.data.from === chair && BOARD_QUESTIONS_TITLE_RE.test(n.body))
    .flatMap((n) => [...n.body.matchAll(/^\d+\.[ \t]+(.+)$/gm)].map((m) => m[1].trim()));
}

/** What the owner is asked when the board could not answer a round from the material it had. */
export function boardQuestionsBody(o: { title: string; questions: string[]; notePath: string; verdict: string }): string {
  return [
    `The board pressure-tested **${o.title}** and could not answer ${o.questions.length === 1 ? 'one question' : `${o.questions.length} questions`} from anything in the vault. It did not guess.`,
    '',
    ...o.questions.map((q, i) => `${i + 1}. ${q.replace(new RegExp(`^${OWNER_QUESTION}\\s*`, 'i'), '')}`),
    '',
    `The verdict stands as given (**${o.verdict}**) — answering these does not undo it. The next time the board sits on this subject it re-runs only the rounds above, and keeps the rest of its argument as written.`,
    '',
    `The whole argument is in [[${o.notePath.replace(/\.md$/, '')}]].`,
    '',
    'Reply here in your own words. One message answering all of them is enough.',
  ].join('\n');
}

/**
 * The board's pressure test, held as a dialogue the owner can read.
 *
 * Returns the same shape the brief session does, plus `notePath` (the transcript) and `questions` (what the
 * board had to ask the owner), so both paths are interchangeable to every caller.
 *
 * `opts.decision` is the id of the `Decisions/` note the caller is about to write. It is taken up front rather
 * than patched in afterwards because the conversations index reads an **open** thread as one with no `decision`
 * in its frontmatter: a note that reached `status: done` and gained its decision one write later would show, in
 * between, as a board still sitting. Both call sites know the id before the session starts — it is derived from
 * the idea's slug or the heartbeat's — so there is no reason for that gap to exist.
 */
export async function runBoardDialogue(deps: HeartbeatDeps, org: Org, subject: string | BoardSubject, opts: BoardSessionOpts = {}): Promise<BoardSessionResult> {
  const vault = deps.vault;
  const s = boardSubject(subject);
  const board = org.teams.board;
  if (!board) return noBoard(s);
  const advisors = [...new Set([board.lead, ...board.members])].filter((r) => org.roles[r]).slice(0, 3);
  if (advisors.length === 0) return noBoard(s);
  // The chair is the skeptic seat's office holder, resolved through the org: the board team's lead, and its
  // first surviving advisor when the org has re-staffed the seat out from under it. No role id is written here.
  const chair = advisors[0];
  const others = advisors.filter((a) => a !== chair);
  const leadTier: ModelTier = org.roles[chair]?.model_tier ?? 'medium';
  const tierFor = (roleId: string): ModelTier => org.roles[roleId]?.model_tier ?? leadTier;
  // A plan is the CEO's, so the CEO sits at the table for a plan session — in the participants, where the
  // office sees them, even though the advisors are the ones who speak.
  const ceo = officeHolder(org, 'chief_executive');
  const participants = s.kind === 'plan' && ceo && !advisors.includes(ceo) ? [...advisors, ceo] : [...advisors];

  const opened = nowIso();
  const meetingId = idFromKey('meet', `board:${s.kind}:${subjectSlug(s)}:${advisors.join('-')}:${opened}`);
  const subjectKey = boardSubjectKey(s);
  let rel = `Meetings/${stampForFilename()}-board-${subjectSlug(s)}.md`;
  const clash = vault.readNoteOrNull(rel);
  if (clash && clash.data.id !== meetingId) rel = rel.replace(/\.md$/, `-${meetingId.slice(-6)}.md`);

  const turns: BoardTurn[] = [];
  const findings: Partial<Record<PressurePart, string>> = {};
  const answeredBy = new Set<string>();
  let calls = 0;

  const frontmatter = (status: 'in_progress' | 'done', decision?: string) => ({
    id: meetingId, room: 'board', opened, facilitator: chair, participants, status,
    ...(decision ? { decision } : {}),
    subject: s.kind, subject_key: subjectKey, title: s.title, calls,
  });
  const render = (status: 'in_progress' | 'done', decision?: string) => stringifyNote(frontmatter(status, decision), [
    `# Board: ${s.title}`,
    '',
    '## Agenda',
    '',
    boardAgenda(s),
    '',
    '## Transcript',
    '',
    turns.map((t) => `**Round ${t.round} — ${t.role}:** ${t.text}`).join('\n\n'),
    '',
    BOARD_FINDINGS_SECTION,
    '',
    findingsSection(findings),
    '',
  ].join('\n'));
  // Every turn is durable the moment it is spoken: the whole note is rewritten, which is cheap and is the only
  // shape that survives a kill mid-session with a transcript somebody can still read (the meeting tool does the
  // same). The event carries a short form; the note carries the whole of it.
  const say = (round: number, role: string, text: string) => {
    turns.push({ round, role, text });
    vault.writeText(rel, render('in_progress'), chair, { generated: true });
    vault.events.emit({ type: 'meeting.turn', agent: role, payload: { id: meetingId, round, text: text.slice(0, TURN_EVENT_CHARS) } });
  };
  const transcriptSoFar = () => turns.map((t) => `${t.role}: ${t.text}`).join('\n\n').slice(-TRANSCRIPT_CHARS);

  // What this session may keep from the last one on the same subject (spec §3, "Questions to the owner"): a
  // round is re-run when its question has an answer in the vault, and reused verbatim when it does not. A round
  // that reached a finding is never re-run — the board already answered it, and paying for that twice is how a
  // company spends a day's quota re-litigating the argument it won yesterday.
  //
  // Read **before** this session's own note exists, because that note is on the same subject and newer than
  // every other: looked up afterwards, a session would find itself, reuse nothing, and re-argue the lot.
  const prior = priorBoardDialogue(vault, subjectKey);

  vault.events.emit({ type: 'meeting.opened', agent: chair, payload: { id: meetingId, room: 'board', participants, agenda: boardAgenda(s), subject: s.kind, title: s.title, path: rel } });
  vault.writeText(rel, render('in_progress'), chair, { generated: true });

  const answered = prior ? ownerSpokeSince(vault, prior.opened) : false;
  const reuse: Partial<Record<PressurePart, string>> = {};
  if (prior) {
    for (const part of PRESSURE_PARTS) {
      const was = prior.findings[part];
      if (!was) continue;
      if (isOwnerQuestion(was) && answered) continue;
      reuse[part] = was;
    }
  }

  const chairTurn = async (o: { close: PressurePart | null; open: PressurePart | null; challenge: string; verdict: boolean }): Promise<string | null> => {
    calls++;
    return askAs(deps, chair, advisorSystem(vault, chair), chairRoundPrompt(s, { ...o, transcript: transcriptSoFar() }),
      o.verdict ? (s.kind === 'plan' ? 600 : CHAIR_IDEA_TOKENS) : CHAIR_TURN_TOKENS, leadTier);
  };

  let closing: PressurePart | null = null;
  let challenge = '';
  for (let i = 0; i < PRESSURE_PARTS.length; i++) {
    const part = PRESSURE_PARTS[i];
    const round = i + 1;
    if (reuse[part]) {
      findings[part] = reuse[part]!;
      say(round, chair, `${REUSED_NOTE} ${prior!.opened.slice(0, 10)} — the board's answer has not changed.\n\n${FINDING_LABEL} ${reuse[part]}`);
      continue;
    }
    const turn = await chairTurn({ close: closing, open: part, challenge, verdict: false });
    if (turn) answeredBy.add(chair);
    say(round, chair, turn ?? '(no answer: no model was available)');
    if (closing) findings[closing] = turn ? findingIn(turn) : `${OWNER_QUESTION} the board had no model to answer this with.`;
    closing = part;
    challenge = '';
    const question = turn ? questionIn(turn, part) : `${part} — ${ADVISOR_ASK[part]}`;
    const said: { role: string; text: string }[] = [];
    for (const a of others) {
      calls++;
      const text = await askAs(deps, a, advisorSystem(vault, a), advisorRoundPrompt(s, part, question, transcriptSoFar()), ADVISOR_TURN_TOKENS, tierFor(a));
      if (text) answeredBy.add(a);
      say(round, a, text ?? '(no answer: no model was available)');
      said.push({ role: a, text: text ?? '' });
    }
    challenge = challengeReason(said);
  }

  // Round six: the chair closes the last round it argued and delivers the verdict in today's `chairFormat`.
  const verdictTurn = await chairTurn({ close: closing, open: null, challenge, verdict: true });
  if (verdictTurn) answeredBy.add(chair);
  say(BOARD_DIALOGUE_ROUNDS, chair, verdictTurn ?? '(no answer: no model was available)');
  if (closing) findings[closing] = verdictTurn ? findingIn(verdictTurn) : `${OWNER_QUESTION} the board had no model to answer this with.`;

  // The verdict is read exactly as the brief session's is, off a page whose five parts are the round findings
  // and whose last word is the chair's own verdict line. Order matters: the parts first, so the last vote on
  // the page is the chair's and not a heading above it.
  const chairPage = () => `${partsText(findings)}\n\n${verdictTurn ?? ''}`;
  let merge: BoardMerge = verdictTurn === null
    ? { verdict: 'pass', findings: [], pressure: null, rubric: null, refused: null }
    : mergeBoardVerdict(chairPage(), s.kind);
  let chairText = s.kind !== 'plan' && verdictTurn !== null && !merge.refused ? chairPage() : '';
  let reasked = false;
  let chairLost: string | null = null;
  if (merge.refused) {
    reasked = true;
    calls++;
    const again = await askAs(deps, chair, advisorSystem(vault, chair), chairReaskPrompt(s, transcriptSoFar(), merge.refused), s.kind === 'plan' ? 600 : CHAIR_IDEA_TOKENS, leadTier);
    if (again === null) {
      chairLost = chairLostNote(merge.refused);
      merge = { verdict: 'pass', findings: [], pressure: null, rubric: null, refused: null };
    } else {
      say(BOARD_DIALOGUE_ROUNDS, chair, again);
      const second = mergeBoardVerdict(`${partsText(findings)}\n\n${again}`, s.kind);
      merge = second.refused ? unansweredMerge(second) : second;
      chairText = second.refused ? '' : `${partsText(findings)}\n\n${again}`;
    }
  }

  const questions = PRESSURE_PARTS.map((p) => findings[p] ?? '').filter((f) => isOwnerQuestion(f));
  vault.writeText(rel, render('done', opts.decision), chair, { generated: true });

  const out: BoardSessionResult = {
    ...merge,
    advisors, transcript: turns.map((t) => `**Round ${t.round} — ${t.role}:** ${t.text}`).join('\n\n'),
    answered: answeredBy.size, subject: s, calls, reasked, chairLost, chairText,
    notePath: rel, questions, findingsByPart: findings,
  };
  vault.events.emit({
    type: 'meeting.closed', agent: chair,
    payload: {
      id: meetingId, room: 'board', subject: s.kind, title: s.title, verdict: out.verdict, findings: out.findings,
      pressure: out.pressure ?? '', rubric: out.rubric ? renderRubric(out.rubric) : '',
      decision: `VERDICT: ${out.pressure ?? out.verdict}`, path: rel, turns: turns.length, calls,
    },
  });
  // One cabin message, from the chair, carrying everything the board could not know (spec §3) — and only what
  // it has not already asked (review I3). A question the owner has not answered yet is still open, and the
  // board goes on recording it every session; asking it again every cycle is nagging, not diligence.
  const asked = new Set(questionsAlreadyAsked(vault, chair));
  const fresh = questions.filter((q) => !asked.has(bareQuestion(q)));
  if (fresh.length) {
    try {
      createProposal(vault, {
        id: boardQuestionsMessageId(subjectKey, fresh), kind: 'message', from: chair, to: 'owner',
        title: `The board needs ${fresh.length} answer${fresh.length === 1 ? '' : 's'} from you`,
        body: boardQuestionsBody({ title: s.title, questions: fresh, notePath: rel, verdict: out.pressure ?? out.verdict }),
      }, chair);
    } catch { /* a question is worth asking, never worth stalling the cycle over */ }
  }
  return out;
}

/**
 * Point a finished transcript at the `Decisions/` note the session produced, for a note that does not already
 * carry it. The session itself closes with the id its caller handed it (`BoardSessionOpts.decision`), because
 * "no `decision` in the frontmatter" is how the conversations index reads a board that is still sitting.
 */
export function linkBoardTranscript(vault: Vault, notePath: string, decisionId: string, by: string): void {
  if (!notePath || !decisionId) return;
  // Normally a no-op: `runBoardDialogue` was handed the same id and closed the note with it. This is the
  // recovery path — a session written by an older build, or one whose caller only learned the id afterwards.
  if (vault.readNoteOrNull(notePath)?.data.decision === decisionId) return;
  try {
    vault.updateNote(notePath, (n) => ({ data: { ...n.data, decision: decisionId }, body: n.body }), by);
  } catch { /* the transcript is the record; a missing back-link is not worth a cycle */ }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// The founder brief's own pressure test (ruling P8-6)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What the board is judging when it sits on the brief. The title reaches the meeting note, the agenda, the
 * decision note and the owner's proposal, so it is written once.
 */
export const BRIEF_SUBJECT_TITLE = 'the founder brief';

/** The filename slug a brief session's transcript takes: `Meetings/<stamp>-board-founder-brief.md`. */
export const BRIEF_SUBJECT_SLUG = 'founder-brief';

/**
 * The subject key a brief session is found again by: the brief's own material (review I2). Not the proposal id —
 * a brief re-filed word for word is the same document and deserves the argument it already got, and a brief
 * rewritten after a rejection is a different one however it is filed.
 */
export function briefSubjectKey(draft: string): string { return `brief:${subjectDigest(draft)}`; }

/** The `Decisions/` note a brief session writes, keyed on the proposal so a resumed cycle rewrites one note. */
export function briefDecisionId(proposalId: string): string { return `board-brief-${proposalId}`; }

/** A round finding flattened to one line of prose: the brief's five parts are bold lead-ins, not a list. */
function oneLine(text: string): string {
  return text.replace(/\r/g, '').split('\n')
    .map((l) => l.trim().replace(/^(?:[-*+]|\d+[.)])\s+/, '').trim())
    .filter(Boolean)
    .join('; ');
}

/**
 * The brief's `## Pressure test` section, written out of the board's five round findings and its verdict.
 *
 * Shaped for the two readers it has. `checkFounderBrief` runs `readPressureVerdict` over this section, so the
 * verdict word leads the `**Brutal Verdict:**` line; and a round the board could not answer becomes
 * `unstated — QUESTION FOR THE OWNER: …`, which is both the honest sentence and the word rule 3 of that check
 * requires wherever nothing about the owner is established. The board never fills a gap with prose.
 */
export function renderBriefPressureSection(
  findings: Partial<Record<PressurePart, string>>, verdict: string, notePath: string,
): string {
  const part = (p: PressurePart): string => {
    const f = (findings[p] ?? '').trim();
    const text = isOwnerQuestion(f) ? `${UNSTATED} — ${oneLine(f)}` : oneLine(f) || UNSTATED;
    return p === 'Brutal Verdict' ? `**${p}:** ${verdict} — ${text}` : `**${p}:** ${text}`;
  };
  return [
    ...PRESSURE_PARTS.map(part),
    '',
    `The board argued this out round by round in [[${notePath.replace(/\.md$/, '')}]].`,
  ].join('\n');
}

/**
 * The block the owner reads above the brief: what the board made of it, and what it had to ask them.
 *
 * `unusable` is the one thing this block may never get wrong (ruling R-T3-2). When the board's section did not
 * pass the brief's own truth check, the section below the fence is the research office's draft — and it can
 * carry the other verdict outright — so a block claiming "its five findings are below" would have the owner
 * reading two contradicting verdicts on one screen and adopting the wrong one as the board's.
 */
export function briefBoardBlock(o: { verdict: string; notePath: string; questions: string[]; unusable?: string }): string {
  return [
    o.unusable
      ? `The board pressure-tested this before you saw it and ruled **${o.verdict}**, but ${o.unusable}. The \`${PRESSURE_TEST_SECTION}\` section below is the research office's draft, not the board's findings — read the argument itself in [[${o.notePath.replace(/\.md$/, '')}]].`
      : `The board pressure-tested this before you saw it and ruled **${o.verdict}**. Its five findings are the \`${PRESSURE_TEST_SECTION}\` section of the brief below, and the argument it took to get there is in [[${o.notePath.replace(/\.md$/, '')}]].`,
    ...(o.questions.length ? [
      '',
      BOARD_OPEN_QUESTIONS,
      '',
      ...o.questions.map((q) => `- ${q.replace(new RegExp(`^${OWNER_QUESTION}\\s*`, 'i'), '')}`),
      '',
      'The verdict stands as given; answering these only changes what the board re-argues next time.',
    ] : []),
  ].join('\n');
}

/**
 * The proposal body with the board's block above the document.
 *
 * **Above**, not below, and that is load-bearing: `splitRejectedBrief` reads everything *after* the fence as
 * the owner's own words when they turn a brief down (ruling C1, and the live run that handed a thousand
 * characters of the company's own prose back as the owner's). Anything the company added under the fence would
 * be quoted to the research office as the rejection.
 */
export function briefProposalBodyWithBoard(brief: string, board: string): string {
  const body = founderBriefProposalBody(brief, citedPaths(brief));
  const at = body.indexOf('## Proposed content');
  return at < 0 ? `${board}\n\n${body}` : `${body.slice(0, at)}${board}\n\n${body.slice(at)}`;
}

/**
 * The `founder_brief` proposal the board still owes a pressure test, or null.
 *
 * **Unresolved, not unapproved.** The owner can set `approved: true` in Obsidian while the session is still
 * owed, and the dispatcher skips that note precisely because the flag is on (ruling R-T3-3) — so requiring
 * `approved === null` here would make the two rules deadlock each other: the board would never sit, the flag
 * would never come off, and the approval would never be applied. A note that is actually *resolved* is another
 * matter, and the write at the end of the session re-reads for exactly that.
 */
export function briefAwaitingBoard(vault: Vault): { id: string; path: string; body: string } | null {
  const note = listInbox(vault).find((n) => n.data.kind === 'founder_brief' && n.data.board_pending === true && !n.data.resolved_at);
  return note ? { id: String(note.data.id), path: note.path, body: note.body } : null;
}

/** Take the flag off, so the owner is asked. Its own function because two paths do it for two reasons. */
function clearBoardPending(vault: Vault, path: string): void {
  vault.updateNote(path, (n) => ({ data: { ...n.data, board_pending: false }, body: n.body }), 'daemon');
}

/**
 * The brief's five parts with every part the truth check named replaced by the word it is asking for.
 *
 * Rule 3 of `checkFounderBrief` refuses a Founder-Market Fit that is anything but `unstated` while the
 * interview is unanswered and `Discovery/inbox/` is empty — which is exactly the owner's "type an idea in the
 * cabin and see what happens" first run, and exactly the round a chair is most likely to answer rather than ask
 * about. The word the check wants is the word the board owes there anyway, so the fill is retried once with it
 * before anything is thrown away (ruling R-T3-2).
 */
export function partsRefusedBy(findings: string[]): PressurePart[] {
  const said = findings.join('\n');
  return PRESSURE_PARTS.filter((p) => new RegExp(p.replace(/-/g, '[- ]'), 'i').test(said));
}

/** What the owner is told above the fence when the board's own section could not be used. */
export function briefBoardUnusable(check: string[]): string {
  return `its findings could not be used because ${check.join(' ')}`;
}

/**
 * The board's pressure test on the founder brief (ruling P8-6).
 *
 * The owner's ask was that the framework asks itself and talks to itself, and the brief is where that matters
 * most: it is the one document every plan is written against. So the same six-round dialogue that judges an
 * idea judges the brief, its five round findings **become** the brief's `## Pressure test` section, and the
 * proposal the owner adopts links the argument and names what the board could not know.
 *
 * It runs here rather than in `proposal.create` because a tool cannot hold a board session: the discovery job
 * files the brief, `board_pending` says the document is not finished yet, and this — called from the
 * heartbeat's `discovery` step, the first place the daemon has the org, a model and a finished discovery job
 * all at once — finishes it before the owner is asked anything. `board_dialogue: brief` keeps the discovery
 * job's own section and never sits.
 *
 * The truth check runs again on the filled brief, because the board has just rewritten a section of a document
 * that had passed it: a filled brief that fails goes back to the draft the author already got past the check,
 * with a warning, rather than reaching the owner unchecked.
 */
export async function runBriefBoardSession(deps: HeartbeatDeps, org: Org): Promise<{ notePath: string; verdict: string; questions: string[]; used: boolean } | null> {
  const vault = deps.vault;
  if (vault.constitution().board_dialogue === 'brief') return null;
  const proposal = briefAwaitingBoard(vault);
  if (!proposal) return null;
  const team = org.teams.board;
  const chair = team ? [...new Set([team.lead, ...team.members])].filter((r) => org.roles[r])[0] : undefined;
  const draft = briefFromProposalBody(proposal.body);
  // No board, no session — and no brief held hostage to one: the discovery job's own section stands and the
  // owner is asked. The flag comes off either way, or the brief would wait for a board that does not exist.
  if (!team || !chair) {
    clearBoardPending(vault, proposal.path);
    vault.events.emit({ type: 'daemon.warning', agent: 'daemon', payload: { where: 'brief_board', message: BOARD_UNREVIEWED_NOTE.replace('the plan passed', 'the founder brief passed') } });
    return null;
  }
  const session = await runBoardSession(deps, org, {
    kind: 'brief', text: draft, title: BRIEF_SUBJECT_TITLE, slug: BRIEF_SUBJECT_SLUG, key: briefSubjectKey(draft),
  }, { decision: briefDecisionId(proposal.id) });
  const verdict = session.pressure ?? (session.verdict === 'pass' ? 'STRONG' : 'WEAK');
  const ctx = briefCheckContext(vault);
  const fill = (findings: Partial<Record<PressurePart, string>>): string =>
    setSection(draft, PRESSURE_TEST_SECTION, renderBriefPressureSection(findings, verdict, session.notePath));

  // The same check `proposal.create` ran on the draft, run again on what the board made of it (ruling FR-4) —
  // and then once more with the parts it named written as `unstated`, which is the word it is asking for and
  // the word the board owes wherever the material establishes nothing (ruling R-T3-2).
  let brief = session.notePath ? fill(session.findingsByPart) : draft;
  let check = checkFounderBrief(vault, brief, ctx);
  if (!check.ok && session.notePath) {
    const refused = partsRefusedBy(check.findings);
    if (refused.length) {
      const trimmed = { ...session.findingsByPart };
      for (const p of refused) trimmed[p] = UNSTATED;
      const second = fill(trimmed);
      const recheck = checkFounderBrief(vault, second, ctx);
      if (recheck.ok) { brief = second; check = recheck; }
    }
  }
  // Still refused: the draft stands, and **the note says so**. A block claiming the board's five findings are
  // below the fence, over a section the research office wrote and a verdict that may be the other word, is the
  // one thing worse than no board at all (ruling R-T3-2).
  const unusable = check.ok ? '' : briefBoardUnusable(check.findings);
  if (unusable) {
    brief = draft;
    vault.events.emit({ type: 'daemon.warning', agent: chair, payload: { where: 'brief_board', message: `the board's pressure test did not pass the brief's own truth check, so the draft section stands: ${check.findings.join(' ')}`.slice(0, 400) } });
  }
  try {
    writeBoardDecision(vault, briefDecisionId(proposal.id), {
      verdict: session.verdict, findings: session.findings, decidedBy: chair, now: new Date(), answered: session.answered,
      chairLost: session.chairLost ?? undefined, cycle: proposal.id, inputs: [`[[${session.notePath.replace(/\.md$/, '')}]]`],
      unreviewedNote: BOARD_UNREVIEWED_NOTE.replace('the plan passed', 'the founder brief passed'),
      noFindingsNote: 'The board found nothing in this brief likely to sink the company.',
      context: unusable
        ? `The board pressure-tested ${BRIEF_SUBJECT_TITLE} before the owner was asked to adopt it, one question at a time, and ruled ${verdict}. The argument is in [[${session.notePath.replace(/\.md$/, '')}]], but ${unusable} — so the \`${PRESSURE_TEST_SECTION}\` section of ${FOUNDER_BRIEF} is the research office's draft and not the board's findings.`
        : `The board pressure-tested ${BRIEF_SUBJECT_TITLE} before the owner was asked to adopt it, one question at a time. The argument is in [[${session.notePath.replace(/\.md$/, '')}]]; its five findings are the \`${PRESSURE_TEST_SECTION}\` section of ${FOUNDER_BRIEF}.`,
      options: '- Adopt it: every plan is written against it\n- Send it back: the company writes it again from what the owner says',
      chosen: `The board's verdict on the brief as it stands: ${verdict}.`,
      why: 'The owner adopts the brief; the board only tells them what it is worth before they do.',
      risksHeading: 'Most likely ways this company fails, and what would prevent each:',
      epilogue: 'The owner rules; the board advises.',
      reviewDays: 30,
    });
  } catch { /* a record is never a reason to hold the brief back from the owner */ }
  // Re-read before the one write that matters (ruling R-T3-3). The owner can set `approved:` in Obsidian while
  // the session is in flight; the dispatcher skips the note while the flag is on, but a note that was resolved
  // some other way must not have its body rewritten underneath the decision.
  const now = listInbox(vault).find((n) => n.data.id === proposal.id);
  if (!now || now.data.resolved_at) {
    vault.events.emit({ type: 'daemon.warning', agent: chair, payload: { where: 'brief_board', message: `the founder brief was decided while the board was still sitting, so its findings were not written into it; they are in [[${session.notePath.replace(/\.md$/, '')}]]` } });
    return { notePath: session.notePath, verdict, questions: session.questions, used: false };
  }
  // An approval the owner set while the board was still sitting has to survive this write (ruling R-T3-3: it
  // "is applied after the flag clears"). The dispatcher honours a flip by comparing the file against the last
  // sha the daemon recorded, and rewriting the body would make the note look daemon-written and the owner's
  // yes would be refused as forged — so the owner's own last version is recorded as the written one, which is
  // what it is. Nothing is invented: this only runs when the flip was already there and already the owner's.
  const ownerFlipped = now.data.approved !== null && vault.isOwnerChanged(proposal.path);
  const ownerSha = ownerFlipped ? vault.currentSha(proposal.path) : null;
  vault.updateNote(proposal.path, (n) => ({
    data: { ...n.data, board_pending: false },
    body: briefProposalBodyWithBoard(brief, briefBoardBlock({ verdict, notePath: session.notePath, questions: session.questions, unusable })),
  }), chair);
  if (ownerSha) vault.recordWritten(proposal.path, ownerSha, 'owner');
  return { notePath: session.notePath, verdict, questions: session.questions, used: !unusable };
}
