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
  officeHolder, listInbox, createProposal, renderRubric,
  PRESSURE_PARTS, type PressurePart, PRESSURE_HANDBOOK_PATH, BANNED_HEDGE, OWNER_QUESTION, isOwnerQuestion, hedges,
} from '@cubicle/core';
import {
  type HeartbeatDeps, type BoardSubject, type BoardMerge, type BoardSessionResult,
  boardSubject, boardAgenda, mergeBoardVerdict, unansweredMerge, chairReaskPrompt, chairLostNote,
  chairFormat, ADVISOR_ASK, askAs, advisorSystem, SUBJECT_CHARS, CHAIR_IDEA_TOKENS,
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

/** One turn as it is written to the note and emitted. */
export interface BoardTurn { round: number; role: string; text: string }

/** The empty session: no board room, or a board whose charters are all gone. Identical to the brief path's. */
function noBoard(s: BoardSubject): BoardSessionResult {
  return {
    verdict: 'pass', findings: [], pressure: null, rubric: null, refused: null,
    advisors: [], transcript: '', answered: 0, subject: s, calls: 0, reasked: false, chairLost: null,
    chairText: '', notePath: '', questions: [],
  };
}

/** `this cycle's plan` → `plan`; an idea keeps the slug it already has. Filenames only. */
function subjectSlug(s: BoardSubject): string {
  return s.slug ?? 'plan';
}

/** How a subject is recognised across sessions, so the re-run rule can find the last one. */
export function boardSubjectKey(s: BoardSubject): string {
  return s.kind === 'idea' ? `idea:${subjectSlug(s)}` : 'plan';
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
  const what = s.kind === 'idea' ? 'this idea' : 'this plan';
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
  if (o.verdict && s.kind === 'idea') {
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
  for (const part of PRESSURE_PARTS) {
    const m = section.match(new RegExp(`^### ${part}[ \\t]*$([\\s\\S]*?)(?=^### |$)`, 'm'));
    const text = (m?.[1] ?? '').trim();
    if (text && text !== '(not reached)') out[part] = text;
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

/** The id of the one cabin message a session's questions go out as. Keyed on the session, so a replay is a no-op. */
export function boardQuestionsMessageId(meetingId: string): string {
  return idFromKey('msg', `board-questions:${meetingId}`);
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
 */
export async function runBoardDialogue(deps: HeartbeatDeps, org: Org, subject: string | BoardSubject): Promise<BoardSessionResult> {
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

  vault.events.emit({ type: 'meeting.opened', agent: chair, payload: { id: meetingId, room: 'board', participants, agenda: boardAgenda(s), subject: s.kind, title: s.title, path: rel } });
  vault.writeText(rel, render('in_progress'), chair, { generated: true });

  // What this session may keep from the last one on the same subject (spec §3, "Questions to the owner"): a
  // round is re-run when its question has an answer in the vault, and reused verbatim when it does not. A round
  // that reached a finding is never re-run — the board already answered it, and paying for that twice is how a
  // company spends a day's quota re-litigating the argument it won yesterday.
  const prior = priorBoardDialogue(vault, subjectKey);
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
      o.verdict ? (s.kind === 'idea' ? CHAIR_IDEA_TOKENS : 600) : CHAIR_TURN_TOKENS, leadTier);
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
  let chairText = s.kind === 'idea' && verdictTurn !== null && !merge.refused ? chairPage() : '';
  let reasked = false;
  let chairLost: string | null = null;
  if (merge.refused) {
    reasked = true;
    calls++;
    const again = await askAs(deps, chair, advisorSystem(vault, chair), chairReaskPrompt(s, transcriptSoFar(), merge.refused), s.kind === 'idea' ? CHAIR_IDEA_TOKENS : 600, leadTier);
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
  vault.writeText(rel, render('done'), chair, { generated: true });

  const out: BoardSessionResult = {
    ...merge,
    advisors, transcript: turns.map((t) => `**Round ${t.round} — ${t.role}:** ${t.text}`).join('\n\n'),
    answered: answeredBy.size, subject: s, calls, reasked, chairLost, chairText,
    notePath: rel, questions,
  };
  vault.events.emit({
    type: 'meeting.closed', agent: chair,
    payload: {
      id: meetingId, room: 'board', subject: s.kind, title: s.title, verdict: out.verdict, findings: out.findings,
      pressure: out.pressure ?? '', rubric: out.rubric ? renderRubric(out.rubric) : '',
      decision: `VERDICT: ${out.pressure ?? out.verdict}`, path: rel, turns: turns.length, calls,
    },
  });
  // One cabin message, from the chair, carrying everything the board could not know (spec §3). Keyed on the
  // session, so a resumed cycle never asks the owner the same questions twice.
  if (questions.length) {
    try {
      createProposal(vault, {
        id: boardQuestionsMessageId(meetingId), kind: 'message', from: chair, to: 'owner',
        title: `The board needs ${questions.length} answer${questions.length === 1 ? '' : 's'} from you`,
        body: boardQuestionsBody({ title: s.title, questions, notePath: rel, verdict: out.pressure ?? out.verdict }),
      }, chair);
    } catch { /* a question is worth asking, never worth stalling the cycle over */ }
  }
  return out;
}

/**
 * Point a finished transcript at the `Decisions/` note the session produced (spec §3: the note ends with status
 * `done` and a `decision`). Separate from the session because the decision note is written by the caller, after
 * the session returns — the meeting note and the decision note are each other's inputs, and one of them has to
 * be written second.
 */
export function linkBoardTranscript(vault: Vault, notePath: string, decisionId: string, by: string): void {
  if (!notePath || !decisionId) return;
  try {
    vault.updateNote(notePath, (n) => ({ data: { ...n.data, decision: decisionId }, body: n.body }), by);
  } catch { /* the transcript is the record; a missing back-link is not worth a cycle */ }
}
