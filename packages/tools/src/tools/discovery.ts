import { z } from 'zod';
import { defineTool } from '../registry.js';
import {
  loadOrg, listInbox, officeHolder, teamOf, subtreeRoles, type Office, type Org,
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
    max_chars: z.number().int().min(1000).max(200000).default(60000).describe('total characters of file text to return; the longest files are truncated first and the cut is marked'),
  },
  async handler({ max_chars }, ctx) {
    const vault = ctx.vault;
    const inputs = listDiscoveryInputs(vault);
    const readable = inputs.filter((f) => f.readable);
    const unreadable = inputs.filter((f) => !f.readable);
    const texts = readable.map((f) => ({ path: f.path, text: vault.readTextOrNull(f.path) ?? '' }));
    const budgets = fairShare(texts.map((t) => t.text.length), max_chars);
    const transcript = vault.readTextOrNull(INTERVIEW_PATH);
    const phase = interviewPhase(transcript);
    const messages = listInbox(vault)
      .filter((n) => n.data.kind === 'message' && n.data.from === 'owner')
      .map((n) => ({ at: n.data.created, text: n.body.split(/^## CEO\s*$/m)[0].replace(/^#\s.*$/m, '').trim() }))
      .filter((m) => m.text);
    const sources = [...readable.map((f) => f.path), ...(phase === 'answered' ? [INTERVIEW_PATH] : []), ...(messages.length ? ['00 Inbox/ (owner messages)'] : [])];
    const sections = [
      `## Files in ${DISCOVERY_INBOX}/ (${readable.length} readable${unreadable.length ? `, ${unreadable.length} unread` : ''})`,
      readable.length ? renderDiscoveryBundle(texts.map((t, i) => ({ ...t, budget: budgets[i] }))) : '_The owner dropped nothing in._',
      ...(unreadable.length ? ['', `**Present but unreadable** (say so in the brief; do not guess at them): ${unreadable.map((f) => f.path).join(', ')}.`] : []),
      '',
      '## The founder interview',
      phase === 'answered' ? interviewAnswer(transcript) : phase === 'skipped' ? '_The owner skipped the interview. Work from everything else, and list what you would have asked under "What we do not know"._' : '_Not answered yet._',
      '',
      '## What the owner has typed in the cabin',
      messages.length ? messages.map((m) => `- _${m.at.slice(0, 10)}_ ${m.text}`).join('\n') : '_Nothing._',
    ];
    return {
      ok: true,
      text: sections.join('\n'),
      data: {
        sources,
        files: inputs,
        interview: phase,
        messages: messages.length,
        long_prompt: messages.some((m) => isLongPrompt(m.text)),
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

export const ideaCard = defineTool({
  name: 'idea.card',
  description: 'File a new idea card at Ideas/<slug>.md, or fill in the part of an existing one your office owns. The research office sets the research link, its confidence, and the evidence and fit scores; the finance office sets the estimate and the value and effort scores. The score itself is arithmetic and is never written by hand. One card per idea, never a digest of several.',
  schema: {
    title: z.string().describe('one line naming the opening, not the observation'),
    slug: z.string().optional().describe('the existing card to update; omit to derive one from the title'),
    source: z.string().optional().describe('discovery | intelligence:<kind> | pantry | owner; defaults to the job that filed it'),
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
    const wanted = args.slug ? ideaSlug(args.slug) : ideaSlug(args.title);
    const existing = readIdea(ctx.vault, wanted);
    const slug = existing
      ? wanted
      : writeIdeaCard(ctx.vault, {
        slug: args.slug, title: args.title, source: args.source ?? (ctx.jobId ?? 'owner'),
        evidence: args.evidence, what_changed: args.what_changed, why_it_matters: args.why_it_matters,
      }, ctx.roleId);
    const filled: string[] = [];
    if (args.research) {
      updateIdea(ctx.vault, slug, {
        research: args.research.report, research_confidence: args.research.confidence, status: 'triaged',
        score_inputs: { evidence: args.research.evidence, fit: args.research.fit },
        evidence: [...new Set([...(readIdea(ctx.vault, slug)?.data.evidence ?? []), ...args.evidence, args.research.report])],
      }, ctx.roleId, { heading: '## Research', content: `${args.research.summary}\n\nReport: [[${args.research.report.replace(/\.md$/, '')}]] — confidence ${args.research.confidence}.` });
      filled.push(...FILLERS.research);
    }
    if (args.estimate) {
      updateIdea(ctx.vault, slug, {
        estimate: args.estimate.text, status: 'triaged',
        score_inputs: { value: args.estimate.value, effort: args.estimate.effort },
      }, ctx.roleId, { heading: '## What it would cost', content: args.estimate.text });
      filled.push(...FILLERS.finance);
    }
    const card = readIdea(ctx.vault, slug)!;
    const complete = IdeaScoreInputs.safeParse(card.data.score_inputs);
    if (complete.success) updateIdea(ctx.vault, slug, {}, ctx.roleId, { heading: '## Score', content: renderScoreSection(complete.data, { board: card.data.board_verdict }) });
    const missing = missingScoreInputs(card.data.score_inputs);
    const waiting = missing.length ? ` Still waiting on ${missing.join(', ')}.` : ` Score ${card.data.score}; the board reads it next cycle.`;
    return {
      ok: true,
      text: `${existing ? 'updated' : 'filed'} ${ideaPath(slug)}${filled.length ? ` (${filled.join(', ')})` : ''}.${waiting}`,
      data: { slug, path: ideaPath(slug), score: card.data.score, missing },
    };
  },
});
