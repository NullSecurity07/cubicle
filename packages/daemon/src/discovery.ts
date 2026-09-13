import {
  type Vault, type Org, type InterviewPhase, type ResearchRequest, type DiscoveryInput,
  createJob, createProposal, findInboxById, listInbox, listJobs, jobPath, idFromKey, officeHolder, teamOf, listIdeas,
  DISCOVERY_INBOX, FOUNDER_BRIEF, INTERVIEW_PATH, discoveryDigest, hasFounderBrief, founderBriefTemplate,
  interviewPhase, renderInterviewAsk, renderInterviewAsked, closeInterview, closesInterview, isSkip, listDiscoveryInputs, isLongPrompt,
  ownerSaid, isDiscoveryMaterial, ownerPick, asksForSurprise, SURPRISE_ME, BRAND_NAME_PATH, OWNER_PICK_LABEL, type OwnerPick, ideaPath, IDEA_SCORE_MAX,
  INTERVIEW_QUESTIONS, openInterviewQuestions, interviewAskTitle, renderInterviewCovered, questionsAsked,
  PRESSURE_TEST_SECTION, PRESSURE_HANDBOOK_PATH,
  sha256, extractOwnerComments, PROPOSED_CONTENT_FENCE,
} from '@cubicle/core';

// `ownerSaid` moved to core so the `discovery.inputs` tool cuts a cabin note the same way this module does
// (whole-branch review, minor 2). `isDiscoveryMaterial` and `ownerPick` moved for exactly that reason and one
// more (ruling FR-3b): the tool that hands a discovery job its material must answer "is this material?" and
// "what did the owner pick?" with the same code that decided to start the job. Re-exported here because they
// were part of this module's surface first.
export { ownerSaid, isDiscoveryMaterial, ownerPick, asksForSurprise, SURPRISE_ME, BRAND_NAME_PATH, OWNER_PICK_LABEL, type OwnerPick };

/**
 * The discovery step: what the company reads before it plans anything, who is asked when there is nothing to
 * read, and who prices the ideas that come out of it.
 *
 * Everything in this file is deterministic daemon work — no model call anywhere. The decisions are made from
 * the vault (the interview transcript, `Discovery/inbox/`, the owner's cabin messages, the open proposals) and
 * turned into ordinary queued jobs, which is what makes a replayed cycle safe: both job ids are derived from
 * their material, so the same inputs can never queue a second job.
 */

export interface DiscoveryStatus {
  /** Queue (or keep waiting for) a discovery job this cycle. */
  run: boolean;
  /** Ask the six interview questions first: there is nothing else to work from. */
  ask: boolean;
  /** What the checkpoint log and the brief say happened. */
  why: string;
}

/**
 * Material the company has **not read yet**: what arrived after the newest `discovery` job, or everything at
 * all when discovery has never run.
 *
 * The distinction is the whole of C2. `ownerPrompt` used to concatenate every cabin message the inbox had ever
 * held, and the digest — which is the discovery job's id — moved every time anyone typed anything. "Thanks" to
 * the CEO therefore bought a full research lifecycle, a `requester.review` gate and a founder-brief edit
 * proposal, and the heartbeat blocked on it: five chats in a day were five research projects.
 */
export interface UnreadMaterial {
  /** A `Discovery/inbox/` file written since discovery last ran (any of them, the first time). */
  newInput: boolean;
  /** The founder interview was answered since discovery last ran. */
  newInterview: boolean;
  /** Unread owner words that are themselves a document (`isLongPrompt`) — a brief typed into the cabin. */
  longPrompt: boolean;
  /** Any unread owner words at all, one line included: the single-prompt path (spec §1.3, §5.5). */
  anyPrompt: boolean;
  /**
   * The owner picked one of the three ideas the CEO proposed, since discovery last read the vault (ruling
   * FR-3). It is the answer to "surprise me": until it lands there is nothing to research, and once it lands
   * the chosen line is what the company is for.
   */
  pick?: boolean;
}

/** A re-run has to be worth a research job. A short reply is not; these four are. */
function isSubstantive(u: UnreadMaterial): boolean {
  return u.newInput || u.newInterview || u.longPrompt || !!u.pick;
}

/**
 * Whether this cycle runs discovery, asks the interview, or does neither. **Both can be true**: asking costs no
 * model call and writes two notes, so an owner who types one line gets the name proposal, the six questions and
 * a discovery job on the same cycle — which is what §1.3, §1.8 and §5.5 all describe ("the owner types one
 * line, the CEO proposes a name, and discovery still runs over that line"). Treating them as alternatives left
 * the single-prompt company waiting for an interview answer for ever, and it is the one path the spec calls out
 * as having to work.
 *
 * `ask` is about one thing only: **has anybody been asked yet**. It used to be about the vault being thin as
 * well — no files, no typed document, no brief — and preflight G2 deleted those three clauses, because the
 * vault they refused to interview is exactly the vault whose material already answers some of the six, which
 * made the coverage check that decides *which* questions to ask unreachable. How much of the interview is
 * still worth asking is `askInterview`'s judgement now, per question, not this gate's, all or nothing.
 *
 * `run` is about there being something unread to read, and about that something being worth a research job the
 * second time onwards: the first run takes anything, a re-run needs a substantive increment and is floored at
 * one a calendar day, the same backstop `intelligenceDue` uses.
 */
export function discoveryStatus(o: {
  hasBrief: boolean;
  briefProposalOpen: boolean;
  /** How many files sit in `Discovery/inbox/` at all — what "the vault is thin" means, read or not. */
  inputs: number;
  interview: InterviewPhase;
  /** The three ideas are in the inbox, unpicked: the company is waiting for the owner and must say so. */
  pickPending?: boolean;
  unread: UnreadMaterial;
  /** Discovery has run at least once before (there is a `discovery` job in the log). */
  everRun: boolean;
  /** A discovery job for exactly this material already exists (see `discoveryDigest`). */
  alreadyRun: boolean;
  /** One of those jobs was queued today: the once-a-day floor on re-runs. */
  ranToday: boolean;
}): DiscoveryStatus {
  if (o.briefProposalOpen) return { run: false, ask: false, why: 'a founder brief is already waiting for your verdict' };
  // The interview is asked once, ever, and the *coverage check* — not this gate — decides how much of it is
  // still worth asking (preflight G2). This used to read "thin vault only": no brief, no inbox file, nothing
  // typed at length. That made the two routes the coverage check exists for into dead code, because the vault
  // it refused to interview is exactly the vault whose material already answers some of the six. Now the
  // questions go out whenever nobody has been asked yet, and `askInterview` sends only the ones the founder
  // brief, the inbox files and the owner's cabin text have not already answered — or, when they answer all
  // six, sends nothing at all and records the `covered` phase.
  const ask = o.interview === 'none';
  const status = (run: boolean, why: string): DiscoveryStatus => ({ run, ask, why });
  if (o.alreadyRun) return status(false, 'discovery has already read this material');

  if (!o.everRun) {
    // The first read takes whatever there is, one line included, and an empty vault whose owner skipped the
    // interview still gets one: §1.8 — the company must be able to start from a single line, or from nothing.
    // `covered` is the owner's material having answered all six (spec §5): like `skipped`, it means the
    // interview is closed and there is something to read — never that the company is still waiting.
    // Three ideas filed and unpicked comes first, before anything the owner has merely *typed* (whole-branch
    // review, Important 2). Their real follow-up in the live run — "your text i only hAlf", a complaint about
    // the CEO's truncated reply — is five words and cleared the material floor, so the company bought a
    // research lifecycle off a note that described nothing while the pick it was waiting for sat in the inbox.
    // While the ideas are unpicked and there is no file and no answered interview, the pick is the material.
    const onlyTyped = !isSubstantive(o.unread) && o.inputs === 0 && !['answered', 'covered'].includes(o.interview);
    if (o.pickPending && onlyTyped) return status(false, 'waiting for you to pick one of the three ideas; the one you choose is what discovery reads');
    const anything = isSubstantive(o.unread) || o.unread.anyPrompt || o.inputs > 0 || ['answered', 'skipped', 'covered'].includes(o.interview);
    if (anything) return status(true, ask ? 'reading what the owner gave us, and asking the interview as well — only the questions it does not already answer' : 'first discovery over the owner\'s material');
    // Nothing to read at all, and three ideas waiting: that is not an idle company, it is a company waiting on
    // the owner, and the checkpoint log must say which (finding F3).
    if (o.pickPending) return status(false, 'waiting for you to pick one of the three ideas; the one you choose is what discovery reads');
    if (ask) return status(false, 'nothing to read yet: asking the founder interview');
    if (o.interview === 'asked') return status(false, 'the founder interview is waiting for an answer');
    return status(false, 'nothing to read yet');
  }
  if (!isSubstantive(o.unread)) {
    if (o.pickPending) return status(false, 'waiting for you to pick one of the three ideas; the one you choose is what discovery reads');
    if (o.unread.anyPrompt) return status(false, 'nothing new to read: a reply to the CEO is not material for a second discovery job');
    return status(false, o.hasBrief ? 'the founder brief covers everything the owner has given us' : 'nothing new since discovery last read the vault');
  }
  // The day floor guards against *typing*: a long message is the one increment an owner can produce over and
  // over in an afternoon, and each one costs a research lifecycle. A file dropped in the inbox and an answered
  // interview are not that. The interview especially — it is answered once, ever, and its answers are the
  // richest material the company will ever be given; deferring them to tomorrow because cycle one already read
  // the owner's one line would make the CEO's own promise ("what you say next goes into the founder brief the
  // next plan is written against") false on the day it matters most.
  // The owner's pick is not typing either: it happens once, it is a click on a note the CEO filed, and
  // deferring the company's whole reason for existing to tomorrow's first cycle would be absurd (ruling FR-3).
  const onlyTyping = !o.unread.newInput && !o.unread.newInterview && !o.unread.pick;
  if (o.ranToday && onlyTyping) return status(false, 'discovery already read a document you typed today; the next one is read on the next day\'s first cycle');
  return status(true, o.hasBrief ? 'new material since the founder brief' : 'new material since the last discovery');
}

/** How many `finance.estimate` jobs one cycle may queue: the free tier pays for these, and the board only sits once. */
export const MAX_ESTIMATES_PER_CYCLE = 3;

/**
 * The ideas this cycle asks the finance office to price: unpriced, undecided, best-evidenced first.
 *
 * "Unpriced" is read off the two numbers the finance office owns, never off the `estimate` prose: a card whose
 * estimate says "a few weeks" and carries no `value` still needs the finance office, and a card whose numbers
 * are in has been priced whatever its prose says.
 */
export function ideasNeedingEstimate<T extends { id: string; decision: string; score_inputs: { value?: number; effort?: number; evidence?: number } }>(ideas: T[], max = MAX_ESTIMATES_PER_CYCLE): T[] {
  return ideas
    .filter((i) => i.decision === 'undecided' && (i.score_inputs.value === undefined || i.score_inputs.effort === undefined))
    .sort((a, b) => (b.score_inputs.evidence ?? 0) - (a.score_inputs.evidence ?? 0) || a.id.localeCompare(b.id))
    .slice(0, max);
}

/**
 * True once the owner has **adopted** a founder brief — the one gate every planning step in the heartbeat now
 * stands behind (ruling S-1).
 *
 * It is `hasFounderBrief` under a name that says what the file's existence means, because in this vault the two
 * are the same fact and nothing else may write that file: `Memory/founder-brief.md` is not scaffolded, the
 * `vault.write` tool refuses it by name ("adopted by the owner, never written directly"), and the only code
 * path that ever creates it is the dispatcher's `founder_brief` case, which runs on the owner's own approval.
 * So a non-empty brief *is* an approved brief, and a predicate that tried to prove it a second way — walking
 * the event log for the write, or re-finding the proposal that carried it — would only add a way to be wrong
 * about a file the owner has already signed.
 */
export function hasApprovedBrief(vault: Vault): boolean {
  return hasFounderBrief(vault);
}

/**
 * The sentence the re-run's goal opens on, and the marker the tests read. A constant because the whole point of
 * ruling S-2 is that the owner's words reach the research office verbatim: if this label drifted from what
 * `enqueueRejectionDiscovery` writes, a rejection would quietly become the silent re-run the ruling rejected.
 */
export const REJECTED_BRIEF_LABEL = 'The owner rejected the previous brief, saying:';

/**
 * The owner asking for a different company rather than a better write-up of this one. Deliberately narrow — the
 * four phrases ruling S-2 names — because the consequence is expensive: the CEO puts three fresh ideas to them
 * and they have to pick again. "make it better" on its own must never reach this.
 */
export function rejectionAsksForNewIdea(comment: string): boolean {
  return /\b(?:new idea|another idea|different idea|surprise)\b/i.test(comment);
}

/** Lines the CEO wrote in a `founder_brief` note, never the owner (see `briefRejectionComment`). */
const BRIEF_BOILERPLATE = [
  /^This is what I understood from what you gave me\./,
  /^\*\*Read from:\*\*$/,
  /^Set `approved:/,
  /^_(?:Resolved|Not applied)\b/,           // the dispatcher's own footers
];

/**
 * A line that belongs to the *document* rather than to a note somebody typed underneath it: a heading, a
 * bullet, a numbered item, a quote, a table row, a fence, a rule, or the bold lead-in the pressure test's five
 * parts are written as. The owner's rejection comment is prose; the brief's last line never is.
 */
const BRIEF_STRUCTURE = /^(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|\||`{3,}|-{3,}$|\*\*)/;

/** How many trailing lines may be read as the owner's note. A sentence or two, not a page. */
const MAX_COMMENT_LINES = 12;

/**
 * What the owner actually typed when they turned a founder brief down, from every place they can have typed it:
 * a `why`/`comment`/`reason` field in the frontmatter, a `%%cubicle: …%%` comment anywhere in the note, and —
 * the one the live run used — a line or two added at the end of the note.
 *
 * **Read positively, never by subtraction** (ruling C1). The first cut of this dropped the fence, dropped the
 * lines `founderBriefProposalBody` writes, and called whatever survived the owner's — on the premise that that
 * function is the only thing that ever writes this note. It was not: a brief filed without the fence left the
 * whole document standing, and the live rejection handed back a thousand characters of the company's own prose
 * as the owner's words. `proposal.create` now enforces the fence, and this reads only what lies *after* the
 * document either way:
 *
 * - with the fence: everything after the closing backticks, minus the CEO's two closing lines;
 * - without one (a note filed by an older build): the trailing run of plain prose, stopping at the first line
 *   that belongs to the document — which for the live note is `**Brutal Verdict:** WEAK. …`, one line above
 *   the owner's sentence.
 *
 * And a last guard that holds whichever branch ran: a line that also appears verbatim higher up in the note is
 * the brief quoting itself, not the owner, and is dropped.
 */
export function briefRejectionComment(note: { data: Record<string, unknown>; body: string }): string {
  return splitRejectedBrief(note).comment;
}

/**
 * The two halves of a rejected `founder_brief` note: the document the company wrote, and what the owner typed
 * under it. One split, because the halves are defined by each other — the comment is what the brief is not —
 * and two readers with two ideas of where the line falls is how the live note came to be read as its own
 * rejection (ruling C1). The dispatcher hands `brief` to the research office as material and `comment` to the
 * chief executive as the instruction.
 *
 * `brief` is the fenced `## Proposed content` block when there is one (the shape `proposal.create` now enforces
 * and the dispatcher adopts from), and otherwise everything above the owner's trailing note — so a brief filed
 * by an older build is still handed over whole rather than as "(no readable brief)".
 */
export function splitRejectedBrief(note: { data: Record<string, unknown>; body: string }): { brief: string; comment: string } {
  const fields = ['why', 'comment', 'reason'].map((k) => String(note.data[k] ?? '').trim()).filter(Boolean);
  const comments = extractOwnerComments(note.body);
  // The dispatcher's own footers go on *after* whatever the owner typed, so they are cut before the walk
  // rather than stopped at: left in place they are the last line of the note, and the walk would end on them
  // one line short of the owner's sentence. A note can carry more than one (a refusal, then a resolution).
  let text = note.body.replace(/%%\s*cubicle:[\s\S]*?%%/g, '');
  for (let n = 0; n < 4; n++) {
    const cut = text.replace(/\n*-{3,}[ \t]*\n_(?:Resolved|Not applied)[^\n]*_[ \t]*\n?\s*$/, '\n');
    if (cut === text) break;
    text = cut;
  }
  const fence = text.match(/## Proposed content\s*\n+(`{3,})[a-z]*\n([\s\S]*?)\n\1[ \t]*(?:\n|$)/);
  let head: string;
  let tail: string[];
  if (fence) {
    head = text.slice(0, fence.index! + fence[0].length);
    tail = text.slice(head.length).split('\n');
  } else {
    // No fence: walk up from the end over plain prose and stop at the document.
    const lines = text.split('\n');
    let i = lines.length;
    let kept = 0;
    while (i > 0 && kept < MAX_COMMENT_LINES) {
      const line = lines[i - 1].trim();
      if (!line) { i--; continue; }                                   // blank lines cost nothing
      if (BRIEF_STRUCTURE.test(line) || BRIEF_BOILERPLATE.some((re) => re.test(line))) break;
      i--; kept++;
    }
    head = lines.slice(0, i).join('\n');
    tail = lines.slice(i);
  }
  const typed = tail
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !BRIEF_BOILERPLATE.some((re) => re.test(l)) && !/^-{3,}$/.test(l))
    .filter((l) => !head.includes(l))
    .join(' ')
    .trim();
  return {
    // The title line the cabin prepends is the note's, not the brief's; everything after it is the document.
    brief: (fence ? fence[2] : head.replace(/^#\s[^\n]*\r?\n?/, '')).trim(),
    comment: [...fields, ...comments, typed].filter(Boolean).join(' ').replace(/\s+/g, ' ').slice(0, 1000),
  };
}

/**
 * The re-run's job id. A discovery job id is normally a digest of its *material*, and a rejection changes none
 * of that material — the same files, the same interview, the same cabin messages — so the ordinary id would
 * name the job that has already run and `createJob` would hand it back untouched, which is exactly the silent
 * no-op ruling S-2 (b) is about. The rejection is material in its own right, so it goes into the key: one
 * re-run per rejected proposal per comment, idempotent across a replayed tick, and a second, different
 * rejection still gets its own job.
 */
export function rejectionDiscoveryJobId(proposalId: string, comment: string): string {
  return idFromKey('job', `discovery-rejected-${proposalId}-${sha256(comment.trim()).slice(0, 12)}`);
}

/**
 * Queue the discovery job a rejected founder brief asks for: the owner's own words as the instruction, and the
 * brief they turned down as the thing not to file again.
 *
 * Its own function rather than a flag on `enqueueDiscovery`, because the two differ in everything that matters:
 * this one runs whatever `discoveryStatus` thinks about unread material (the rejection *is* the material), it
 * never revises an adopted brief (there is none — a rejected brief was never written), and its id comes from
 * the rejection rather than from the digest.
 */
/**
 * How much of the rejected brief the re-run's goal carries (ruling I2).
 *
 * The goal is prepended to **every** model turn of that job, and `max_prompt_tokens` is as low as 6000 on groq
 * and 7000 on the gemma models — a 4 KB brief pasted whole (the live one is exactly that) costs a quarter of
 * the budget on every turn, for ever. Four thousand characters is enough to see what was written and what the
 * owner objected to; past that the goal names the note instead, and the job can `vault.read` it.
 */
export const REJECTED_BRIEF_CHARS = 4000;

/** The rejected brief as the re-run's goal carries it: capped, fenced, and pointing at the note when it was cut. */
export function rejectedBriefBlock(brief: string, proposalPath?: string): string[] {
  const full = brief.trim();
  const cut = full.length > REJECTED_BRIEF_CHARS;
  const where = proposalPath ? `\`${proposalPath}\`` : 'the rejected `founder_brief` note in `00 Inbox/`';
  if (!full) return [`The proposal carried no readable brief; read it yourself at ${where}.`];
  return [
    cut ? `The brief they turned down, its first ${REJECTED_BRIEF_CHARS} characters — the whole of it is at ${where}:` : `The brief they turned down, in full (it is also at ${where}):`,
    '',
    PROPOSED_CONTENT_FENCE,
    full.slice(0, REJECTED_BRIEF_CHARS),
    PROPOSED_CONTENT_FENCE,
    ...(cut ? ['', `That is where it was cut. \`vault.read ${proposalPath ?? 'the note'}\` for the rest before you rewrite it.`] : []),
  ];
}

export function enqueueRejectionDiscovery(vault: Vault, org: Org, opts: { proposalId: string; proposalPath?: string; comment: string; brief: string }): string {
  const research = officeHolder(org, 'research');
  const ceo = officeHolder(org, 'chief_executive');
  const deadline = new Date(Date.now() + DISCOVERY_DEADLINE_DAYS * 86_400_000).toISOString().slice(0, 10);
  const comment = opts.comment.trim() || '(they gave no reason)';
  const goal = [
    discoveryGoal({ founderBrief: FOUNDER_BRIEF, briefTemplate: founderBriefTemplate(), hasBrief: false, research: ceo, pick: ownerPick(vault)?.line ?? null }),
    '',
    `${REJECTED_BRIEF_LABEL} "${comment}"`,
    '',
    'That is an instruction, not a complaint. Answer it in the brief you file: say, in the brief itself, what changed because of it. Do not file the rejected brief again unchanged, and do not argue with them.',
    ...(rejectionAsksForNewIdea(comment)
      ? ['', 'They have asked for a different idea, not a better write-up of this one. The chief executive is putting three fresh ideas to them in `00 Inbox/`; read what they pick before you commit the brief to a direction.']
      : []),
    '',
    ...rejectedBriefBlock(opts.brief, opts.proposalPath),
  ].join('\n');
  return createJob(vault, {
    id: rejectionDiscoveryJobId(opts.proposalId, comment), type: 'discovery', priority: 1,
    title: 'Rewrite the founder brief the owner turned down',
    assigned: research, for: ceo, owner_role: ceo, team: teamOf(org, research)?.id,
    goal,
    research: discoveryRequest({ ceo, hasBrief: false, deadline }),
    done_when: `${FOUNDER_BRIEF} is filed as a founder_brief proposal with all eight sections, including a ${PRESSURE_TEST_SECTION} that ends on the verdict line (STRONG, WEAK or PIVOT REQUIRED), and it answers what the owner said when they turned the last one down.`,
  }, 'daemon');
}

/**
 * The discovery job's brief. It names the tools in the order they are meant to be used, the exact file the
 * founder brief must be proposed as, and the one rule that keeps the brief honest — every claim about what
 * already exists cites the file it came from.
 */
export function discoveryGoal(opts: { founderBrief: string; briefTemplate: string; hasBrief: boolean; research: string; pick?: string | null }): string {
  return [
    opts.hasBrief
      ? `The owner has added new material since the founder brief was adopted. Read all of it, then propose an *edit* to ${opts.founderBrief} — never a second brief — and file cards for anything genuinely new.`
      : `This company does not know what it is for yet. Everything the owner has given us is in one call. Turn it into the founder brief they approve, and into one idea card per candidate.`,
    // The pick is the whole brief when the owner said "surprise me" (ruling FR-3b): the job must open on the
    // line they chose, not find it three sections into a tool's output — or not at all, which is how the first
    // live run's job came to write a brief about a company nobody had described.
    ...(opts.pick ? ['', `${OWNER_PICK_LABEL} **${opts.pick}**. That is what this company is; read everything else in the light of it, and never contradict it without saying so.`] : []),
    '',
    'Do, in this order:',
    '1. `discovery.inputs` — the files, the interview and the cabin messages. This is the whole brief; there is nothing else to go on.',
    '2. `research.start` — open the project directory, then follow `Processes/research_lifecycle.md`. Existing evidence first: `memory.search` and `vault.search` before you fetch anything, and `http.fetch { archive: true }` + `sources.cite` for every page you do fetch.',
    `3. \`idea.card\` — one card per candidate idea, \`source: discovery\`, with the evidence that points at it and, where your research supports a view, the research half (report, confidence, evidence 1–5, fit 1–5). One card per idea, never a digest of several. Do not price anything: the finance office does that.`,
    `4. \`proposal.create\` with \`kind: founder_brief\` and \`target: ${opts.founderBrief}\`, carrying the whole brief inside a \`## Proposed content\` fence. These eight sections, all of them:`,
    '',
    opts.briefTemplate,
    '',
    `Rules: every claim about what already exists cites the file it came from. Where the owner's material and the interview disagree, say so rather than picking one. Never invent a customer, a number or a date.`,
    '',
    // The truth rules, from the owner's first live run: the brief that went to them claimed a brand the company
    // does not have, an interview nobody had answered, and an idea the owner never picked — each of which the
    // vault contradicts in one line. `checkFounderBrief` refuses all three at `proposal.create`; this is the
    // same rule said once, up front, so the author writes the honest brief instead of being returned one.
    `Say only what a file says. If \`Brand/name.md\` has no name, say the company has no name yet. If the interview has no answers, do not describe it as answered and write "unstated" for Founder-Market Fit and for anything the material does not establish. Never infer that the owner chose an idea from their asking to be surprised. \`proposal.create\` checks all of this against the vault before it files anything, and hands you back what it found.`,
    '',
    `\`${PRESSURE_TEST_SECTION}\` is the Paul Graham test on the company as a whole — read \`${PRESSURE_HANDBOOK_PATH}\` first, write the five parts in order, and end on the verdict line: the verdict first — STRONG, WEAK or PIVOT REQUIRED — then the reasons. Never write "it has potential, but". Put the same five parts in your research report. The report goes to ${opts.research}; the brief goes to the owner.`,
  ].join('\n');
}

/** The finance office's brief for one card: a rough order of magnitude, and the two numbers only it can answer. */
export function estimateGoal(idea: { id: string; title: string }): string {
  return [
    `Price the idea in [[Ideas/${idea.id}]] — "${idea.title}" — well enough for the owner to rule on it.`,
    '',
    `Do: (1) \`vault.read\` the card, including what the research office found; (2) work out what trying it would actually cost — people, weeks, money out of pocket — and what it is worth if it works; (3) \`idea.card\` with \`slug: "${idea.id}"\` and an \`estimate\` carrying that text plus \`value\` and \`effort\`.`,
    '',
    '`value` is 1–5: what this is worth to the company if it works. `effort` is 1–5 **inverted**: 5 is a week, 1 is a quarter. Say the assumption each number rests on, in one line.',
    '',
    'A rough order of magnitude is the answer. Do not build a model, do not write a revenue projection as though it were a fact, and do not touch the ledger — there is not one yet.',
  ].join('\n');
}

/**
 * What the owner has typed in the cabin and the company has not read yet, oldest first — the "long prompt"
 * input, and the part of the digest that moves.
 *
 * `since` is the newest discovery job's creation time: messages older than that were read by that job, and
 * feeding them back would keep the digest — and so the job id — moving for ever on material nobody added.
 * Omitted, it is everything, which is what the first run wants.
 */
export function ownerPrompt(vault: Vault, since: string | null = null): string {
  return listInbox(vault)
    .filter((n) => n.data.kind === 'message' && n.data.from === 'owner' && (!since || String(n.data.created ?? '') > since))
    .map((n) => ownerSaid(n.body))
    .filter(Boolean)
    .join('\n\n');
}

/** The owner's cabin words, minus everything that is only a reply to the CEO. What discovery may read. */
export function discoveryPrompt(vault: Vault, since: string | null = null): string {
  return listInbox(vault)
    .filter((n) => n.data.kind === 'message' && n.data.from === 'owner' && (!since || String(n.data.created ?? '') > since))
    .map((n) => ownerSaid(n.body))
    .filter(isDiscoveryMaterial)
    .join('\n\n');
}

/**
 * The three ideas are in the inbox and nobody has picked one: the company is waiting for the owner, not idle.
 *
 * "Three ideas" is read the way the dispatcher reads it (`dispatcher.ts`, the `brand_change` case): numbered
 * option lines and no `## Proposed content` fence. The *other* `brand_change` on `Brand/name.md` — the name
 * the CEO proposes for an idea the owner typed themselves — carries the fence and is not a pick anyone is
 * waiting on, so saying "waiting for you to pick one of the three" about it would be a lie.
 */
export function pickPending(vault: Vault): boolean {
  return listInbox(vault).some((n) => n.data.kind === 'brand_change' && n.data.target === BRAND_NAME_PATH && !n.data.resolved_at
    && !/^## Proposed content/m.test(n.body) && n.body.split('\n').some((l) => /^\s*\d+\.\s/.test(l))
    && (n.data.approved !== true || n.data.chosen === null || n.data.chosen === undefined));
}

/**
 * The statuses that mean a discovery job is still *reading*. `in_review` is deliberately not one of them: by
 * then the job has filed its founder brief and its cards and is waiting on a reviewer, so there is nothing
 * left for the cycle to wait for — and holding the whole company behind a gate is how one slow review costs
 * every later cycle its wait budget.
 */
const STILL_READING = ['queued', 'running', 'blocked'];

/** Every `discovery` job in the log, oldest first. */
export function discoveryJobs(vault: Vault): { id: string; created: string; updated: string; status: string }[] {
  return listJobs(vault).filter((j) => j.type === 'discovery').map((j) => ({ id: j.id, created: j.created, updated: j.updated, status: j.status }))
    .sort((a, b) => a.created.localeCompare(b.created));
}

/** When discovery last read the vault, or null if it never has. The line between read and unread material. */
export function lastDiscoveryAt(vault: Vault): string | null {
  const jobs = discoveryJobs(vault);
  return jobs.length ? jobs[jobs.length - 1].created : null;
}

/**
 * A discovery job the company is reading **right now** — so nothing plans past it.
 *
 * `movedSince` is the line between "still reading" and stranded. A job that has not been touched since then —
 * a saturated research team, an assignee that stopped being claimable, a worker killed mid-job — is left
 * behind rather than waited for: the caller's wait is bounded within a cycle, but `blocked_on.since` restarts
 * with every heartbeat, so without this a permanently stuck job costs *every* later cycle its whole wait
 * budget at this step and the company never reads anything new again. A job that is progressing keeps its
 * `updated` moving and keeps being waited for, which is the distinction that matters.
 */
export function openDiscoveryJob(vault: Vault, movedSince?: string): string | null {
  return discoveryJobs(vault).find((j) => STILL_READING.includes(j.status) && (!movedSince || j.updated >= movedSince))?.id ?? null;
}

/**
 * When each of `paths` was last written, from **one** pass over the log rather than one query per path
 * (`vault.wrote` is the most common event there is, so a query inside a loop reads the whole log again for
 * every file). A path nobody wrote is absent from the map.
 */
export function lastWriteTimes(vault: Vault, paths: string[]): Map<string, string> {
  const want = new Set(paths);
  const out = new Map<string, string>();
  for (const e of vault.events.query({ types: ['owner.edited', 'vault.wrote'] })) {
    const p = String((e.payload as { path?: string }).path ?? '');
    if (want.has(p) && (out.get(p) ?? '') < e.ts) out.set(p, e.ts);
  }
  return out;
}

/**
 * The id of the one cabin message an interview is ever sent as. Keyed by the asking role rather than by the
 * material, because the digest moves the moment the transcript is written and this id has to be the same on
 * both sides of that write.
 */
export function interviewMessageId(ceo: string): string { return idFromKey('msg', `interview:${ceo}`); }

/** How much of the owner's material the coverage check reads. A cap, not a sample: it is read once, ever. */
export const INTERVIEW_MATERIAL_CHARS = 20_000;

/**
 * Everything the company has been told, for the coverage check: every cabin message the owner has typed (read
 * or unread — coverage is about knowledge, not about increments), every readable file in `Discovery/inbox/`,
 * and the founder brief if one is adopted.
 *
 * The brief comes back twice on purpose. As `brief` it is read by heading, which is the strict route: a
 * section counts only when it is written rather than left as the template's prose. As part of `text` it is
 * read by cue, which is the only route open to "what have you already tried that did not work" — no brief
 * heading answers that one, so a brief that says "we tried X and it did not work" would otherwise buy the
 * owner a question they had already answered in the very document the company planned from.
 *
 * Putting it in `text` is safe because `coveredQuestions` runs `ownerAuthored` over everything first, which
 * takes out the template's own prose and every `## ` heading. Without that it was not safe: `## Who it is for`
 * is itself a match for that question's `/it is for/` cue, and `## Pressure test`'s template prompt contains
 * "the workaround these people use today", so an entirely unwritten brief covered question 1 (review T4).
 */
export function interviewMaterial(vault: Vault): { text: string; brief: string } {
  const brief = vault.readTextOrNull(FOUNDER_BRIEF) ?? '';
  const parts = [ownerPrompt(vault)];
  for (const f of listDiscoveryInputs(vault)) if (f.readable) parts.push(vault.readTextOrNull(f.path) ?? '');
  parts.push(brief);
  return { text: parts.filter(Boolean).join('\n\n').slice(0, INTERVIEW_MATERIAL_CHARS), brief };
}

/**
 * Ask the six questions, once: one cabin message from the chief executive, then the transcript that records it.
 *
 * The message goes **first**, and "the message exists" is what counts as asked. Written the other way round, a
 * kill between the two writes leaves a transcript reading `asked` with nothing in the owner's inbox — and since
 * `discoveryStatus` then answers "waiting for an answer" for ever, on an empty vault the company would be
 * silently dead. In this order a kill resumes into the transcript write: `createProposal` is idempotent on the
 * deterministic id, so the owner is never asked twice.
 *
 * **The resume check comes before every write** (review T4, Important 2). Coverage made the two writes
 * material-dependent for the first time, and that turned the one-write gap into two bugs. A kill after the
 * message left phase `none`; on the next cycle, material that had since grown could make the covered branch
 * fire, writing `## Already answered` while the CEO's six questions sat in the owner's inbox — and
 * `captureInterviewAnswer` only closes an `asked` transcript, so the owner's reply to a message they can see
 * would never have been recorded by anything. Even without new material, `createProposal`'s idempotent replay
 * does not rewrite the body, so re-deriving the open questions on a resume recorded one set in the transcript
 * and left the owner reading another. So: if the message is already out, the transcript is written from *that
 * message's* questions, and `covered` is never reachable once anybody has been asked anything.
 *
 * Returns the message id when this call is what sent it, and null when the interview had already been asked —
 * including the resume, where the transcript is written but no new message goes out.
 */
export function askInterview(vault: Vault, ceo: string, now: Date): string | null {
  if (interviewPhase(vault.readTextOrNull(INTERVIEW_PATH)) !== 'none') return null;
  const id = interviewMessageId(ceo);
  const sent = findInboxById(vault, id);
  if (sent) {
    // The resume. The owner can see this message, so the transcript records exactly the questions it carries.
    vault.writeText(INTERVIEW_PATH, renderInterviewAsked(now.toISOString(), questionsAsked(sent.body)), 'daemon');
    return null;
  }
  const m = interviewMaterial(vault);
  const open = openInterviewQuestions(m.text, m.brief);
  // Nothing to ask: the owner said all six in their own material. Nobody is sent anything, and the transcript
  // says so. Reachable only here, where it is already known that no message has gone out.
  if (!open.length) { vault.writeText(INTERVIEW_PATH, renderInterviewCovered(now.toISOString()), 'daemon'); return null; }
  createProposal(vault, {
    id, kind: 'message', from: ceo, to: 'owner',
    title: interviewAskTitle(open.length), body: renderInterviewAsk(open, INTERVIEW_QUESTIONS.length - open.length),
  }, ceo);
  vault.writeText(INTERVIEW_PATH, renderInterviewAsked(now.toISOString(), open), 'daemon');
  return id;
}

/**
 * Close an open interview with the owner's **answer**. Returns false when there is nothing open, so the caller
 * can tell "recorded" from "the owner was just talking".
 *
 * It also returns false — and writes nothing — when what the owner typed is not an answer at all (ruling
 * FR-6). It used to close on the next message whatever it said (spec §1.4 as written), which is finding F5:
 * "your text is only half" would have been filed as the six answers and the founder brief written against it.
 * `closesInterview` is the whole of that judgement, and it costs no model call.
 */
export function captureInterviewAnswer(vault: Vault, text: string, now: Date): boolean {
  const transcript = vault.readTextOrNull(INTERVIEW_PATH);
  if (interviewPhase(transcript) !== 'asked') return false;
  if (!closesInterview(text)) return false;
  vault.writeText(INTERVIEW_PATH, closeInterview(transcript!, text, now.toISOString()), 'daemon');
  return true;
}

/** True while a founder brief is sitting in `00 Inbox/` unanswered — the one state that stops everything. */
export function briefProposalOpen(vault: Vault): boolean {
  return listInbox(vault).some((n) => n.data.kind === 'founder_brief' && n.data.approved === null && !n.data.resolved_at);
}

/** One job per set of material: the id is the digest, so the same inputs can never queue a second one. */
export function discoveryJobId(digest: string): string { return idFromKey('job', `discovery-${digest}`); }

/**
 * The status of discovery right now, read entirely from the vault. Everything it needs from the inbox is read
 * once: the file list carries its own shas, the digest is handed that list, and the event log is walked once
 * for every path at issue.
 */
export function currentDiscoveryStatus(vault: Vault, now = new Date()): DiscoveryStatus & { digest: string; inputs: DiscoveryInput[] } {
  const since = lastDiscoveryAt(vault);
  // `discoveryPrompt`, not `ownerPrompt`: a note that is only a reply to the CEO — "surprise me", "skip", two
  // words of thanks — is not material, and discovery must not start on it (finding F3, ruling FR-3).
  const prompt = discoveryPrompt(vault, since);
  const pick = ownerPick(vault);
  const inputs = listDiscoveryInputs(vault);
  const interview = interviewPhase(vault.readTextOrNull(INTERVIEW_PATH));
  const written = lastWriteTimes(vault, [...inputs.map((f) => f.path), INTERVIEW_PATH, ...(pick ? [pick.path] : [])]);
  // No discovery job yet means nothing has been read, so everything counts as new; after one, a file is new
  // when it was written after that job was queued.
  const unread = (p: string): boolean => !since || (written.get(p) ?? '') > since;
  const digest = discoveryDigest(vault, prompt, inputs);
  return {
    ...discoveryStatus({
      hasBrief: hasFounderBrief(vault),
      briefProposalOpen: briefProposalOpen(vault),
      inputs: inputs.length,
      interview,
      pickPending: pickPending(vault),
      unread: {
        newInput: inputs.some((f) => unread(f.path)),
        newInterview: interview === 'answered' && unread(INTERVIEW_PATH),
        longPrompt: isLongPrompt(prompt),
        anyPrompt: prompt.trim().length > 0,
        pick: !!pick && unread(pick.path),
      },
      everRun: since !== null,
      alreadyRun: vault.exists(jobPath(discoveryJobId(digest))),
      ranToday: since !== null && since.slice(0, 10) === now.toISOString().slice(0, 10),
    }),
    digest,
    inputs,
  };
}

/** How long the owner is asked to wait for the brief. The deadline the research request is written against. */
export const DISCOVERY_DEADLINE_DAYS = 7;

/**
 * The research request the discovery job carries, complete in the sense `missingRequestFields` means it.
 *
 * `discoveryGoal` orders `research.start`, and `research.start` scaffolds the project directory out of
 * `job.data.research`: with no request it writes a README saying the project was opened ad hoc and a
 * `question.md` with no question, no known evidence and no unknowns. The company's first and most consequential
 * piece of research is not the one to run without a request behind it, and the daemon already knows every field.
 */
export function discoveryRequest(opts: { ceo: string; hasBrief: boolean; deadline: string }): ResearchRequest {
  return {
    decision: 'what this company is for, and what it does first',
    decision_owner: opts.ceo,
    question: 'What is the owner building, who is it for, and which candidate is worth trying first?',
    hypothesis: '',
    exploration: opts.hasBrief
      ? 'The founder brief exists; what the new material changes about it is unknown until it is read.'
      : 'The company has no brief yet; everything is unknown until the owner\'s material is read.',
    known_evidence: `Everything the owner has given us: ${DISCOVERY_INBOX}/, the cabin messages, and ${INTERVIEW_PATH}. ${opts.hasBrief ? `${FOUNDER_BRIEF} is adopted and is the baseline.` : `${FOUNDER_BRIEF} does not exist yet.`}`,
    unknowns: 'What the company is, who buys it, what already exists, and what success looks like.',
    constraints: '',
    deadline: opts.deadline,
    required_confidence: 'medium',
    potential_decisions: ['adopt the brief as written', 'adopt it with edits', 'ask the owner for more material'],
    portfolio: 'exploratory',
    impact: 5,
    uncertainty: 5,
    cost_of_being_wrong: 4,
  };
}

/**
 * Queue the discovery job for whatever the owner has given us, or null when this cycle has nothing new to read.
 * Assigned by office: the research office owns the investigation, the chief executive owns the decision, which
 * is what `for:` means and what `requester.review` in `config/gates.yaml` reads.
 */
export function enqueueDiscovery(vault: Vault, org: Org, precomputed?: DiscoveryStatus & { digest: string }): string | null {
  // The caller has almost always just asked the same question; reading (and hashing) the whole inbox a second
  // time to get the same answer is the cost this parameter removes.
  const status = precomputed ?? currentDiscoveryStatus(vault);
  if (!status.run) return null;
  const research = officeHolder(org, 'research');
  const ceo = officeHolder(org, 'chief_executive');
  const hasBrief = hasFounderBrief(vault);
  const deadline = new Date(Date.now() + DISCOVERY_DEADLINE_DAYS * 86_400_000).toISOString().slice(0, 10);
  return createJob(vault, {
    id: discoveryJobId(status.digest), type: 'discovery', priority: 1,
    title: hasBrief ? 'Read the new material and revise the founder brief' : 'Read what the owner gave us and write the founder brief',
    assigned: research, for: ceo, owner_role: ceo, team: teamOf(org, research)?.id,
    goal: discoveryGoal({ founderBrief: FOUNDER_BRIEF, briefTemplate: founderBriefTemplate(), hasBrief, research: ceo, pick: ownerPick(vault)?.line ?? null }),
    research: discoveryRequest({ ceo, hasBrief, deadline }),
    done_when: `${FOUNDER_BRIEF} is filed as a founder_brief proposal with all eight sections, including a ${PRESSURE_TEST_SECTION} that ends on the verdict line (STRONG, WEAK or PIVOT REQUIRED), and every candidate idea it names is its own Ideas/<slug>.md card with evidence.`,
  }, 'daemon');
}

/** Job id per idea, so a replayed cycle re-finds the estimate it already asked for. */
export function estimateJobId(slug: string): string { return idFromKey('job', `estimate-${slug}`); }

/**
 * Ask the finance office to price the cards the board will read. At most `MAX_ESTIMATES_PER_CYCLE`, best
 * evidence first, one per card ever — the id is the slug, so a card whose estimate job exists is skipped
 * whatever its state.
 *
 * The cards that already have a job are dropped **before** the cap, not after. Sliced first, three estimate jobs
 * that never finished — failed, cancelled by the fire path, abandoned — would fill all three slots every cycle
 * for ever, and the fourth card would never be priced or reach the board. The cap is there to protect the free
 * tier from new work, not to hold a queue open for stalled work.
 */
export function enqueueEstimates(vault: Vault, org: Org): string[] {
  const finance = officeHolder(org, 'finance');
  const team = teamOf(org, finance)?.id;
  const pending = listIdeas(vault).filter((i) => !vault.exists(jobPath(estimateJobId(i.id))));
  return ideasNeedingEstimate(pending).map((idea) => createJob(vault, {
    id: estimateJobId(idea.id), type: 'finance.estimate', title: `What would "${idea.title}" cost?`, priority: 2,
    assigned: finance, owner_role: finance, team,
    goal: estimateGoal(idea),
    done_when: `Ideas/${idea.id}.md carries an estimate in words, a value and an effort, each with the assumption behind it.`,
  }, 'daemon'));
}

/**
 * The other half of the score. `nextIdeaForBoard` needs all four inputs, and until now only `finance.estimate`
 * had a producer: the research half was written by the `discovery` job, when it chose to, and by nothing else
 * ever. Every card the daily intelligence sweep files — and every `owner`- or `pantry`-sourced card — was
 * therefore unscorable for ever: it could never reach the board, never be kept, parked or scrapped, and nothing
 * anywhere reported it. §2.5 names the mechanism ("`discovery`, **or a follow-up `research` job**"); this is it.
 */
export function ideasNeedingResearch<T extends { id: string; decision: string; score_inputs: { evidence?: number; fit?: number; value?: number } }>(ideas: T[], max = MAX_ESTIMATES_PER_CYCLE): T[] {
  return ideas
    .filter((i) => i.decision === 'undecided' && (i.score_inputs.evidence === undefined || i.score_inputs.fit === undefined))
    // Best-priced first, for the reason estimates go best-evidenced first: when the cap bites, spend the cycle
    // on the card the other office already thinks is worth something.
    .sort((a, b) => (b.score_inputs.value ?? 0) - (a.score_inputs.value ?? 0) || a.id.localeCompare(b.id))
    .slice(0, max);
}

/** Job id per idea, so a replayed cycle re-finds the investigation it already asked for. */
export function researchJobId(slug: string): string { return idFromKey('job', `research-${slug}`); }

/** The research office's brief for one card: the two numbers it owns, the report behind them, and its confidence. */
export function researchHalfGoal(idea: { id: string; title: string }): string {
  return [
    `Answer the research half of [[${ideaPath(idea.id).replace(/\.md$/, '')}]] — "${idea.title}" — so the board can read a score on it.`,
    '',
    `Do: (1) \`vault.read\` the card; (2) \`research.start\` and follow \`Processes/research_lifecycle.md\` — \`memory.search\` and \`vault.search\` before the web, \`http.fetch { archive: true }\` + \`sources.cite\` for every page you lean on; (3) \`idea.card\` with \`slug: "${idea.id}"\` and a \`research\` block carrying the report path, its confidence, what you found, and \`evidence\` and \`fit\`.`,
    '',
    '`evidence` is 1–5: how well the research supports the demand — 5 is customers already paying someone for it. `fit` is 1–5: how much this uses what the company already has. Say the assumption each number rests on, in one line.',
    '',
    `Do not price it and do not score it: \`value\` and \`effort\` are the finance office's, and the score itself is arithmetic over all four (out of ${IDEA_SCORE_MAX}). A card you cannot support is worth a low \`evidence\`, not a missing one.`,
  ].join('\n');
}

/** The request a `research` job needs before anyone may work on it (`missingRequestFields`), built per card. */
export function researchHalfRequest(idea: { id: string; title: string }, opts: { owner: string; deadline: string }): ResearchRequest {
  return {
    decision: `whether the company keeps, parks or scraps "${idea.title}"`,
    decision_owner: opts.owner,
    question: `Is there real demand for "${idea.title}", and how much of what this company already has would it use?`,
    hypothesis: '',
    exploration: 'The card names a candidate; whether anyone wants it, and how well it fits, is unknown until it is looked into.',
    known_evidence: `Whatever [[${ideaPath(idea.id).replace(/\.md$/, '')}]] already carries under ## Evidence and ## What changed.`,
    unknowns: 'Who would pay for this, what they use instead today, and which of our existing assets it leans on.',
    constraints: '',
    deadline: opts.deadline,
    required_confidence: 'medium',
    potential_decisions: ['the evidence supports building it', 'the evidence does not support building it yet'],
    portfolio: 'exploratory',
    impact: 4,
    uncertainty: 4,
    cost_of_being_wrong: 3,
  };
}

/**
 * Ask the research office to fill `evidence` and `fit` on the cards that have neither. Shaped exactly like
 * `enqueueEstimates` — same cap, one job per card ever (the id is the slug), jobs dropped before the cap so
 * three stalled ones cannot starve a fourth card — so that the board's readiness rule has a producer on both
 * sides of it rather than only one.
 */
export function enqueueResearchHalf(vault: Vault, org: Org): string[] {
  const research = officeHolder(org, 'research');
  const team = teamOf(org, research)?.id;
  const owner = officeHolder(org, 'chief_executive');
  const deadline = new Date(Date.now() + DISCOVERY_DEADLINE_DAYS * 86_400_000).toISOString().slice(0, 10);
  const pending = listIdeas(vault).filter((i) => !vault.exists(jobPath(researchJobId(i.id))));
  return ideasNeedingResearch(pending).map((idea) => createJob(vault, {
    id: researchJobId(idea.id), type: 'research', title: `Is "${idea.title}" worth trying?`, priority: 2,
    assigned: research, for: owner, owner_role: owner, team,
    goal: researchHalfGoal(idea),
    research: researchHalfRequest(idea, { owner, deadline }),
    done_when: `Ideas/${idea.id}.md carries a research report link, its confidence, and an evidence and a fit score, each with the assumption behind it.`,
  }, 'daemon'));
}
