import { z } from 'zod';
import { defineTool } from '../registry.js';
import {
  loadOrg, listInbox, officeHolder, teamOf, subtreeRoles, readJob, type Office, type Org, type Vault,
  DISCOVERY_INBOX, INTERVIEW_PATH, listDiscoveryInputs, interviewPhase, interviewAnswer, isLongPrompt,
  IdeaScoreInputs, missingScoreInputs, readIdea, updateIdea, writeIdeaCard, ideaSlug, ideaPath, renderScoreSection,
} from '@cubicle/core';

/**
 * Discovery's two tools (SP3 spec §1, §2.5): `discovery.inputs` reads everything the owner has said about what
 * the company is for, in one call; `idea.card` is the only way an agent writes or updates an idea dossier.
 */

/**
 * Split a character budget over several files so that a folder of one huge document and six short notes still
 * shows all seven. Smallest first, each taking at most an equal share of what is left, unused share carried
 * forward: nothing short is ever truncated, and the long one absorbs whatever remains.
 */
export function fairShare(sizes: number[], budget: number): number[] {
  const out = new Array<number>(sizes.length).fill(0);
  const order = sizes.map((n, i) => ({ n, i })).sort((a, b) => a.n - b.n);
  let left = budget;
  let remaining = order.length;
  for (const { n, i } of order) {
    const take = Math.min(n, Math.floor(left / remaining));
    out[i] = take;
    left -= take;
    remaining--;
  }
  return out;
}

/** One `### path` block per input, truncated to its share, with the cut marked rather than hidden. */
export function renderDiscoveryBundle(parts: { path: string; text: string; budget: number }[]): string {
  return parts.map((p) => {
    const cut = p.text.length > p.budget;
    return `### ${p.path}\n\n${p.text.slice(0, p.budget)}${cut ? `\n\n_[truncated: ${p.text.length - p.budget} more characters — vault.read this file directly if you need the rest]_` : ''}`;
  }).join('\n\n');
}

export const discoveryInputs = defineTool({
  name: 'discovery.inputs',
  description: 'Everything the owner has told this company about what it is for, in one call: the files they dropped in Discovery/inbox/, the founder interview transcript, and their own messages. Call it first on a discovery job — this is the whole brief, and there is nothing else to go on. Files it cannot read are listed by name so you can say so in the founder brief rather than guessing at them.',
  schema: {
    max_chars: z.number().int().min(1000).max(200000).default(6000).describe('total characters this call returns, across the inbox files, the interview and the owner\'s cabin messages together; the longest items are truncated first and every cut is marked'),
  },
  async handler({ max_chars }, ctx) {
    const vault = ctx.vault;
    const inputs = listDiscoveryInputs(vault);
    const readable = inputs.filter((f) => f.readable);
    const unreadable = inputs.filter((f) => !f.readable);
    const fileParts = readable.map((f) => ({ path: f.path, text: vault.readTextOrNull(f.path) ?? '' }));

    const transcript = vault.readTextOrNull(INTERVIEW_PATH);
    const phase = interviewPhase(transcript);
    const interviewText = phase === 'answered' ? interviewAnswer(transcript) : '';
    const interviewParts = interviewText ? [{ path: INTERVIEW_PATH, text: interviewText }] : [];

    // Newest first: when the budget cannot cover every message, a tie in fairShare's stable sort resolves in
    // the order given here, so the owner's most recent words are the ones that keep their full share.
    const ownerMessages = listInbox(vault)
      .filter((n) => n.data.kind === 'message' && n.data.from === 'owner')
      .map((n) => ({ at: n.data.created, path: n.path, text: n.body.split(/^## CEO\s*$/m)[0].replace(/^#\s.*$/m, '').trim() }))
      .filter((m) => m.text)
      .sort((a, b) => b.at.localeCompare(a.at));
    const messageParts = ownerMessages.map((m) => ({ path: `${m.path} (${m.at.slice(0, 10)})`, text: m.text }));

    // One budget for the whole bundle: a founder brief written from a silently-clipped interview answer or the
    // owner's own most recent words is written from less than it looks like, and worse, from the wrong half.
    const allParts = [...fileParts, ...interviewParts, ...messageParts];
    const budgets = fairShare(allParts.map((p) => p.text.length), max_chars);
    let cursor = 0;
    const fileBudgeted = fileParts.map((p) => ({ ...p, budget: budgets[cursor++] }));
    const interviewBudgeted = interviewParts.map((p) => ({ ...p, budget: budgets[cursor++] }));
    const messageBudgeted = messageParts.map((p) => ({ ...p, budget: budgets[cursor++] }));

    const sources = [...readable.map((f) => f.path), ...(phase === 'answered' ? [INTERVIEW_PATH] : []), ...(ownerMessages.length ? ['00 Inbox/ (owner messages)'] : [])];
    const sections = [
      `## Files in ${DISCOVERY_INBOX}/ (${readable.length} readable${unreadable.length ? `, ${unreadable.length} unread` : ''})`,
      readable.length
        ? renderDiscoveryBundle(fileBudgeted)
        : inputs.length ? '_Nothing readable was dropped in — see the unreadable list below._' : '_The owner dropped nothing in._',
      ...(unreadable.length ? ['', `**Present but unreadable** (say so in the brief; do not guess at them): ${unreadable.map((f) => f.path).join(', ')}.`] : []),
      '',
      '## The founder interview',
      phase === 'answered' ? renderDiscoveryBundle(interviewBudgeted) : phase === 'skipped' ? '_The owner skipped the interview. Work from everything else, and list what you would have asked under "What we do not know"._' : '_Not answered yet._',
      '',
      '## What the owner has typed in the cabin',
      messageBudgeted.length ? renderDiscoveryBundle(messageBudgeted) : '_Nothing._',
    ];
    return {
      ok: true,
      text: sections.join('\n'),
      data: {
        sources,
        files: inputs,
        interview: phase,
        messages: ownerMessages.length,
        long_prompt: ownerMessages.some((m) => isLongPrompt(m.text)),
      },
    };
  },
});

/** The two offices that may fill score inputs, and what each of them owns (spec §2.5). */
const FILLERS = { research: ['evidence', 'fit'], finance: ['value', 'effort'] } as const;

/** True when `role` holds an office or sits anywhere under the team that office's holder leads. */
export function inOffice(org: Org, role: string, office: Office): boolean {
  if (role === officeHolder(org, office)) return true;
  if (role === officeHolder(org, 'chief_executive')) return true;   // the chief executive answers for any desk
  const t = teamOf(org, officeHolder(org, office));
  return !!t && subtreeRoles(org, t.id).includes(role);
}

/** The `## Evidence` body, exactly as `writeIdeaCard` renders it — kept as one function so the two never drift. */
function renderEvidenceSection(evidence: string[]): string {
  return evidence.length ? evidence.map((e) => `- ${e}`).join('\n') : '_None yet. An idea with no evidence is a hunch; say so rather than dressing it up._';
}

/**
 * Merge new evidence into a card's frontmatter and re-render its `## Evidence` section from the merged list, so
 * the body a person reads never disagrees with the list the daemon reads. Returns whether anything actually
 * grew, so a call that adds nothing new does not get reported as a change.
 */
function mergeEvidence(vault: Vault, slug: string, by: string, extra: string[]): boolean {
  const cur = readIdea(vault, slug)!;
  const merged = [...new Set([...cur.data.evidence, ...extra])];
  if (merged.length === cur.data.evidence.length) return false;
  updateIdea(vault, slug, { evidence: merged }, by, { heading: '## Evidence', content: renderEvidenceSection(merged) });
  return true;
}

/**
 * Where a card came from, decided by the tool from who is calling it — never from an argument, so an agent
 * cannot claim the owner said something or forge a discovery job's authorship (spec review finding 6/ruling 4).
 * A job of a type discovery already owns is named for what it is; anything else falls back to the job id
 * itself, which is still checkable (`ideaSourceKind` reads a `job_...` id as `'job'`), or `'owner'` outside a job.
 */
function provenanceFor(vault: Vault, jobId: string | null): string {
  const job = jobId ? readJob(vault, jobId) : null;
  if (job?.data.type === 'discovery') return 'discovery';
  if (job?.data.type === 'intelligence') return 'intelligence';
  return jobId ?? 'owner';
}

export const ideaCard = defineTool({
  name: 'idea.card',
  description: 'File a new idea card at Ideas/<slug>.md, or fill in the part of an existing one your office owns. The research office sets the research link, its confidence, and the evidence and fit scores; the finance office sets the estimate and the value and effort scores. The score itself is arithmetic and is never written by hand. One card per idea, never a digest of several. Provenance is set from who is calling this, not from an argument.',
  schema: {
    title: z.string().describe('one line naming the opening, not the observation'),
    slug: z.string().optional().describe('the existing card to update; omit to derive one from the title'),
    what_changed: z.string().optional(),
    why_it_matters: z.string().optional(),
    evidence: z.array(z.string()).default([]).describe('paths or URLs; a card with none is a hunch'),
    research: z.object({
      report: z.string().describe('Research/<slug>/report.md'),
      confidence: z.enum(['high', 'medium', 'low']),
      summary: z.string().describe('what the investigation found, in the words a decision owner needs'),
      evidence: z.number().int().min(1).max(5).describe('how well the research supports the demand; 5 is customers already paying someone for it'),
      fit: z.number().int().min(1).max(5).describe('how much this uses what the company already has'),
    }).optional().describe('the research office only'),
    estimate: z.object({
      text: z.string().describe('a rough order of magnitude in words — people, weeks, money — and the assumption behind it'),
      value: z.number().int().min(1).max(5).describe('what this is worth to the company if it works'),
      effort: z.number().int().min(1).max(5).describe('how cheap it is to try, inverted: 5 is a week, 1 is a quarter'),
    }).optional().describe('the finance office only'),
  },
  async handler(args, ctx) {
    const org = loadOrg(ctx.vault);
    if (args.research && !inOffice(org, ctx.roleId, 'research')) {
      return { ok: false, text: `the research half of a card (research, confidence, evidence, fit) is filled by the research office — ${officeHolder(org, 'research')} or someone in that room. File the card without it and say what you need looked into.` };
    }
    if (args.estimate && !inOffice(org, ctx.roleId, 'finance')) {
      return { ok: false, text: `the cost half of a card (estimate, value, effort) is filled by the finance office — ${officeHolder(org, 'finance')} or someone in that division. File the card without it; the heartbeat asks them to price it.` };
    }

    // A card is an update only when the caller named its slug and that slug already exists, or when the title
    // matches the card the derived slug already points to — never merely because two titles slugify the same.
    // A different title on a slug that is already taken is `writeIdeaCard`'s own collision to resolve (the
    // `-2` suffix); reaching that card here first would silently fold two different ideas into one (review T4
    // finding 1 / coordinator ruling 1).
    const wanted = args.slug ? ideaSlug(args.slug) : ideaSlug(args.title);
    const found = readIdea(ctx.vault, wanted);
    const existing = found && (args.slug !== undefined || found.data.title.trim().toLowerCase() === args.title.trim().toLowerCase()) ? found : null;
    const source = provenanceFor(ctx.vault, ctx.jobId);
    const slug = existing
      ? wanted
      : writeIdeaCard(ctx.vault, {
        slug: args.slug, title: args.title, source,
        evidence: args.evidence, what_changed: args.what_changed, why_it_matters: args.why_it_matters,
      }, ctx.roleId);

    let changed = !existing;
    // On a genuine update, merge rather than drop: `writeIdeaCard` already used these on the create path, so
    // replaying them there would be a no-op at best and a stale overwrite at worst (finding 2 / ruling 2).
    if (existing) {
      if (args.what_changed) { updateIdea(ctx.vault, slug, {}, ctx.roleId, { heading: '## What changed', content: args.what_changed }); changed = true; }
      if (args.why_it_matters) { updateIdea(ctx.vault, slug, {}, ctx.roleId, { heading: '## Why it might matter', content: args.why_it_matters }); changed = true; }
    }
    if (mergeEvidence(ctx.vault, slug, ctx.roleId, [...args.evidence, ...(args.research ? [args.research.report] : [])])) changed = true;

    const filled: string[] = [];
    if (args.research) {
      updateIdea(ctx.vault, slug, {
        research: args.research.report, research_confidence: args.research.confidence, status: 'triaged',
        score_inputs: { evidence: args.research.evidence, fit: args.research.fit },
      }, ctx.roleId, { heading: '## Research', content: `${args.research.summary}\n\nReport: [[${args.research.report.replace(/\.md$/, '')}]] — confidence ${args.research.confidence}.` });
      filled.push(...FILLERS.research);
      changed = true;
    }
    if (args.estimate) {
      updateIdea(ctx.vault, slug, {
        estimate: args.estimate.text, status: 'triaged',
        score_inputs: { value: args.estimate.value, effort: args.estimate.effort },
      }, ctx.roleId, { heading: '## What it would cost', content: args.estimate.text });
      filled.push(...FILLERS.finance);
      changed = true;
    }
    const card = readIdea(ctx.vault, slug)!;
    const complete = IdeaScoreInputs.safeParse(card.data.score_inputs);
    if (complete.success) updateIdea(ctx.vault, slug, {}, ctx.roleId, { heading: '## Score', content: renderScoreSection(complete.data, { board: card.data.board_verdict }) });
    const missing = missingScoreInputs(card.data.score_inputs);
    const waiting = missing.length ? ` Still waiting on ${missing.join(', ')}.` : ` Score ${card.data.score}; the board reads it next cycle.`;
    const verb = !existing ? 'filed' : changed ? 'updated' : 'left unchanged — nothing new in this call';
    return {
      ok: true,
      text: `${verb} ${ideaPath(slug)}${filled.length ? ` (${filled.join(', ')})` : ''}.${waiting}`,
      data: { slug, path: ideaPath(slug), score: card.data.score, missing },
    };
  },
});
