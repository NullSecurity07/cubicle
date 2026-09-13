import type { Vault } from './vault.js';
import { IDEA_SLUG_SRC, listIdeas, keptIdeas, type IdeaDecision } from './ideas.js';

/**
 * Does the company plan only serve ideas the owner kept? (Spec §4, ruling W3-1.)
 *
 * The third live run is what this module exists for. The board ruled `PIVOT REQUIRED` on the founder brief and on
 * the one kept idea; the CEO "aligned the plan with the board's recommendations"; and by the time the owner
 * looked, the company was selling signed SBOM attestations to compliance design partners — a business nobody had
 * asked for, planned in a document whose every objective was about something the owner had never seen. Nothing in
 * the pipeline noticed, because nothing in the pipeline asked the plan which idea it was serving.
 *
 * So every objective names one: `idea: <slug>`, the same way it already names its stream. Read in code rather
 * than promised in a prompt — the prompt asks too, and the run above is what a prompt is worth on its own — and
 * before the board sits, because an advisor asked to spot a missing slug in a wall of markdown will miss it.
 */

/** The marker an objective carries to say which kept idea it serves: `idea: <slug>`, beside `stream: <slug>`. */
export const PLAN_IDEA_MARKER = 'idea:';
const PLAN_IDEA_RE = new RegExp(`(?:^|[\\s(\\[])idea:[ \\t]*\`?(${IDEA_SLUG_SRC})\`?`, 'i');

/**
 * A bullet that is a **job**, not an objective: the division leads append the ids of the jobs they queued under
 * their own `### <team>` section, as wikilinks or as bare ids. Those are the plan's record of what came of it and
 * are never asked to name an idea — only the objectives the CEO wrote are.
 */
const JOB_BULLET_RE = /^(?:\[\[)?Jobs\/|^job_/i;

/** One objective of the plan: the section it sits under, its own text, and the idea it says it serves. */
export interface PlanObjective {
  /** The `### ` header as the CEO wrote it — prose, not a team id (`resolveTeamSection` is the daemon's job). */
  team: string;
  /** The bullet and every continuation line under it (a `process:` line, a wrapped sentence), trimmed. */
  text: string;
  /** The slug off its `idea:` marker, lower-cased, or `null` when it carries none. */
  idea: string | null;
}

/**
 * Every objective in `Plans/plan.md`, by section.
 *
 * A separate parser from the daemon's `parseObjectiveSections` because it answers a different question: that one
 * hands a division lead its whole section to plan against, this one needs each objective on its own so a plan can
 * be refused for the one bullet that names nothing. Continuation lines belong to the bullet above them, so an
 * `idea:` the CEO put on its own line under an objective counts — the marker is a fact about the objective, not
 * about where on the page it was typed.
 */
export function planObjectives(plan: string): PlanObjective[] {
  const out: PlanObjective[] = [];
  for (const chunk of (plan ?? '').split(/^### /m).slice(1)) {
    const nl = chunk.indexOf('\n');
    const team = (nl < 0 ? chunk : chunk.slice(0, nl)).trim();
    if (!team) continue;
    let lines: string[] | null = null;
    const flush = (): void => {
      if (!lines) return;
      const text = lines.join('\n').trim();
      if (text) out.push({ team, text, idea: text.match(PLAN_IDEA_RE)?.[1]?.toLowerCase() ?? null });
      lines = null;
    };
    for (const line of (nl < 0 ? '' : chunk.slice(nl + 1)).split('\n')) {
      const bullet = line.trim().match(/^[-*+]\s+(.*)$/);
      if (bullet) {
        flush();
        if (!JOB_BULLET_RE.test(bullet[1].trim())) lines = [bullet[1]];
        continue;
      }
      if (lines && line.trim()) lines.push(line.trim());
      else if (!line.trim()) flush();
    }
    flush();
  }
  return out;
}

/** How much of an objective a finding quotes back: enough for the CEO to find the bullet, not the whole bullet. */
export const PLAN_QUOTE_CHARS = 90;

function quote(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > PLAN_QUOTE_CHARS ? `${one.slice(0, PLAN_QUOTE_CHARS).replace(/\s+\S*$/, '')}…` : one;
}

/** What the plan may draw on, listed the way the findings ask for it. */
function keptList(kept: string[]): string {
  return kept.map((k) => `\`${k}\``).join(', ');
}

export interface PlanCheck {
  ok: boolean;
  findings: string[];
}

/**
 * Check a written plan against the ideas the company kept.
 *
 * Two ways an objective fails, and the finding names the objective either way so the CEO can fix the bullet
 * rather than guess at the document:
 *
 * 1. **It names no idea.** Every objective serves something the owner agreed to; one that names nothing is the
 *    company deciding for them.
 * 2. **It names an idea nobody kept** — parked, scrapped, still undecided, or no card at all. Each gets its own
 *    sentence, because "we parked that" and "there is no such card" are different mistakes.
 *
 * With **no kept ideas at all** the check passes and says nothing. That is not a loophole: on the cycle after the
 * founder brief is adopted there is often nothing kept yet (the board rules on one card a cycle), the plan writer
 * is told to plan from the brief in exactly that case, and a check that demanded a slug that cannot exist would
 * return every plan for ever and stop the company before it started.
 */
export function checkPlan(vault: Vault, planMd: string): PlanCheck {
  const objectives = planObjectives(planMd);
  if (!objectives.length) return { ok: true, findings: [] };
  const all = listIdeas(vault);
  const kept = keptIdeas(vault).map((i) => i.id);
  if (!kept.length) return { ok: true, findings: [] };
  const decisions = new Map<string, IdeaDecision>(all.map((i) => [i.id.toLowerCase(), i.decision]));
  const findings: string[] = [];
  for (const o of objectives) {
    if (!o.idea) {
      findings.push(`The objective "${quote(o.text)}" under \`### ${o.team}\` names no idea. End every objective with \`${PLAN_IDEA_MARKER} <slug>\` naming the kept idea it serves — the ideas the owner kept are ${keptList(kept)}.`);
      continue;
    }
    if (kept.some((k) => k.toLowerCase() === o.idea)) continue;
    const decision = decisions.get(o.idea);
    const what = decision === undefined
      ? `which is not an idea card at all (there is no \`Ideas/${o.idea}.md\`)`
      : decision === 'undecided'
        ? 'which the owner has not ruled on yet'
        : `which the company ${decision === 'scrap' ? 'scrapped' : 'parked'}`;
    findings.push(`The objective "${quote(o.text)}" under \`### ${o.team}\` serves \`${PLAN_IDEA_MARKER} ${o.idea}\`, ${what}. A plan may only draw on ideas the owner kept: ${keptList(kept)}.`);
  }
  return { ok: findings.length === 0, findings };
}
