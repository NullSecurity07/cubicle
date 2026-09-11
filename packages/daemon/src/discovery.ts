import {
  type Vault, type Org, type InterviewPhase, type ResearchRequest,
  createJob, createProposal, findInboxById, listInbox, jobPath, idFromKey, officeHolder, teamOf, listIdeas,
  DISCOVERY_INBOX, FOUNDER_BRIEF, INTERVIEW_PATH, discoveryDigest, hasFounderBrief, founderBriefTemplate,
  interviewPhase, renderInterviewAsk, renderInterviewAsked, closeInterview, listDiscoveryInputs, isLongPrompt,
} from '@cubicle/core';

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
 * Whether this cycle runs discovery, asks the interview, or does neither.
 *
 * The order matters and is the whole rule: a brief already waiting for the owner stops everything (asking twice
 * for the same decision is how an inbox becomes noise); material the owner gave us beats an unanswered
 * interview (they wrote a document, do not make them answer a questionnaire too); and an empty vault with no
 * interview yet gets the questions, because there is genuinely nothing else to plan from.
 */
export function discoveryStatus(o: {
  hasBrief: boolean;
  briefProposalOpen: boolean;
  inputs: number;
  interview: InterviewPhase;
  longPrompt: boolean;
  /** A discovery job for exactly this material already exists (see `discoveryDigest`). */
  alreadyRun: boolean;
}): DiscoveryStatus {
  if (o.briefProposalOpen) return { run: false, ask: false, why: 'a founder brief is already waiting for your verdict' };
  const material = o.inputs > 0 || o.longPrompt || o.interview === 'answered';
  if (!material && !o.hasBrief) {
    if (o.interview === 'none') return { run: false, ask: true, why: 'nothing to read yet: asking the founder interview' };
    if (o.interview === 'asked') return { run: false, ask: false, why: 'the founder interview is waiting for an answer' };
    // skipped: the owner does not want to be interviewed, so work from whatever the vault already holds.
    return { run: !o.alreadyRun, ask: false, why: o.alreadyRun ? 'discovery has already read what there is' : 'the owner skipped the interview; reading the vault instead' };
  }
  if (!material && o.hasBrief) return { run: false, ask: false, why: 'the founder brief covers everything the owner has given us' };
  if (o.alreadyRun) return { run: false, ask: false, why: 'discovery has already read this material' };
  return { run: true, ask: false, why: o.hasBrief ? 'new material since the founder brief' : 'first discovery over the owner\'s material' };
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
 * The discovery job's brief. It names the tools in the order they are meant to be used, the exact file the
 * founder brief must be proposed as, and the one rule that keeps the brief honest — every claim about what
 * already exists cites the file it came from.
 */
export function discoveryGoal(opts: { founderBrief: string; briefTemplate: string; hasBrief: boolean; research: string }): string {
  return [
    opts.hasBrief
      ? `The owner has added new material since the founder brief was adopted. Read all of it, then propose an *edit* to ${opts.founderBrief} — never a second brief — and file cards for anything genuinely new.`
      : `This company does not know what it is for yet. Everything the owner has given us is in one call. Turn it into the founder brief they approve, and into one idea card per candidate.`,
    '',
    'Do, in this order:',
    '1. `discovery.inputs` — the files, the interview and the cabin messages. This is the whole brief; there is nothing else to go on.',
    '2. `research.start` — open the project directory, then follow `Processes/research_lifecycle.md`. Existing evidence first: `memory.search` and `vault.search` before you fetch anything, and `http.fetch { archive: true }` + `sources.cite` for every page you do fetch.',
    `3. \`idea.card\` — one card per candidate idea, \`source: discovery\`, with the evidence that points at it and, where your research supports a view, the research half (report, confidence, evidence 1–5, fit 1–5). One card per idea, never a digest of several. Do not price anything: the finance office does that.`,
    `4. \`proposal.create\` with \`kind: founder_brief\` and \`target: ${opts.founderBrief}\`, carrying the whole brief inside a \`## Proposed content\` fence. These seven sections, all of them:`,
    '',
    opts.briefTemplate,
    '',
    `Rules: every claim about what already exists cites the file it came from. Where the owner's material and the interview disagree, say so rather than picking one. Never invent a customer, a number or a date. The report goes to ${opts.research}; the brief goes to the owner.`,
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
 * Everything the owner has typed in the cabin, oldest first — the "long prompt" input, and part of the digest.
 *
 * Two things are cut out of each note: the `# title` line, anchored to the first line of the body so a `# …`
 * further down is the owner's own writing and survives; and everything from `## CEO` on, which is the CEO's
 * reply appended to the same note. Letting the reply through would feed discovery the company's own words back
 * and, worse, move `discoveryDigest` every time anyone answered, re-queueing discovery for ever.
 */
export function ownerPrompt(vault: Vault): string {
  return listInbox(vault)
    .filter((n) => n.data.kind === 'message' && n.data.from === 'owner')
    .map((n) => n.body.split(/^## CEO\s*$/m)[0].replace(/^#\s[^\n]*\r?\n?/, '').trim())
    .filter(Boolean)
    .join('\n\n');
}

/**
 * The id of the one cabin message an interview is ever sent as. Keyed by the asking role rather than by the
 * material, because the digest moves the moment the transcript is written and this id has to be the same on
 * both sides of that write.
 */
export function interviewMessageId(ceo: string): string { return idFromKey('msg', `interview:${ceo}`); }

/**
 * Ask the six questions, once: one cabin message from the chief executive, then the transcript that records it.
 *
 * The message goes **first**, and "the message exists" is what counts as asked. Written the other way round, a
 * kill between the two writes leaves a transcript reading `asked` with nothing in the owner's inbox — and since
 * `discoveryStatus` then answers "waiting for an answer" for ever, on an empty vault the company would be
 * silently dead. In this order a kill resumes into the transcript write: `createProposal` is idempotent on the
 * deterministic id, so the owner is never asked twice.
 *
 * Returns the message id when this call is what sent it, and null when the interview had already been asked —
 * including the resume, where the transcript is written but no new message goes out.
 */
export function askInterview(vault: Vault, ceo: string, now: Date): string | null {
  if (interviewPhase(vault.readTextOrNull(INTERVIEW_PATH)) !== 'none') return null;
  const id = interviewMessageId(ceo);
  const resumed = findInboxById(vault, id) !== null;
  createProposal(vault, {
    id, kind: 'message', from: ceo, to: 'owner',
    title: 'Six questions before I plan anything', body: renderInterviewAsk(),
  }, ceo);
  vault.writeText(INTERVIEW_PATH, renderInterviewAsked(now.toISOString()), 'daemon');
  return resumed ? null : id;
}

/**
 * Close an open interview with whatever the owner said next. Returns false when there is nothing open, so the
 * caller can tell "recorded" from "the owner was just talking".
 */
export function captureInterviewAnswer(vault: Vault, text: string, now: Date): boolean {
  const transcript = vault.readTextOrNull(INTERVIEW_PATH);
  if (interviewPhase(transcript) !== 'asked') return false;
  vault.writeText(INTERVIEW_PATH, closeInterview(transcript!, text, now.toISOString()), 'daemon');
  return true;
}

/** True while a founder brief is sitting in `00 Inbox/` unanswered — the one state that stops everything. */
export function briefProposalOpen(vault: Vault): boolean {
  return listInbox(vault).some((n) => n.data.kind === 'founder_brief' && n.data.approved === null && !n.data.resolved_at);
}

/** One job per set of material: the id is the digest, so the same inputs can never queue a second one. */
export function discoveryJobId(digest: string): string { return idFromKey('job', `discovery-${digest}`); }

/** The status of discovery right now, read entirely from the vault. */
export function currentDiscoveryStatus(vault: Vault): DiscoveryStatus & { digest: string } {
  const prompt = ownerPrompt(vault);
  const digest = discoveryDigest(vault, prompt);
  return {
    ...discoveryStatus({
      hasBrief: hasFounderBrief(vault),
      briefProposalOpen: briefProposalOpen(vault),
      inputs: listDiscoveryInputs(vault).length,
      interview: interviewPhase(vault.readTextOrNull(INTERVIEW_PATH)),
      longPrompt: isLongPrompt(prompt),
      alreadyRun: vault.exists(jobPath(discoveryJobId(digest))),
    }),
    digest,
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
export function enqueueDiscovery(vault: Vault, org: Org): string | null {
  const status = currentDiscoveryStatus(vault);
  if (!status.run) return null;
  const research = officeHolder(org, 'research');
  const ceo = officeHolder(org, 'chief_executive');
  const hasBrief = hasFounderBrief(vault);
  const deadline = new Date(Date.now() + DISCOVERY_DEADLINE_DAYS * 86_400_000).toISOString().slice(0, 10);
  return createJob(vault, {
    id: discoveryJobId(status.digest), type: 'discovery', priority: 1,
    title: hasBrief ? 'Read the new material and revise the founder brief' : 'Read what the owner gave us and write the founder brief',
    assigned: research, for: ceo, owner_role: ceo, team: teamOf(org, research)?.id,
    goal: discoveryGoal({ founderBrief: FOUNDER_BRIEF, briefTemplate: founderBriefTemplate(), hasBrief, research: ceo }),
    research: discoveryRequest({ ceo, hasBrief, deadline }),
    done_when: `${FOUNDER_BRIEF} is filed as a founder_brief proposal with all seven sections, and every candidate idea it names is its own Ideas/<slug>.md card with evidence.`,
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
