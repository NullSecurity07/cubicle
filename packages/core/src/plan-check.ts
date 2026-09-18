import type { Vault } from './vault.js';
import { IDEA_SLUG_SRC, listIdeas, keptIdeas, readIdea, ideaPath, type IdeaDecision } from './ideas.js';

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

/**
 * The marker an objective carries to say which kept idea it serves: `idea: <slug>`, beside `stream: <slug>`.
 *
 * Read in every spelling a writer reaches for, because refusing one costs a whole rewrite over punctuation: the
 * bare slug the prompt asks for, the same slug wrapped in the wikilink markdown actually uses to name a note
 * (`idea: [[Ideas/altstack]]`, with or without the `.md`), a bare path, and any of those in backticks. The slug
 * itself is the answer in all of them.
 */
export const PLAN_IDEA_MARKER = 'idea:';
const PLAN_IDEA_RE = new RegExp(`(?:^|[\\s(\\[])idea:[ \\t]*(?:\`|\\[\\[)?(?:Ideas/)?(${IDEA_SLUG_SRC})(?:\\.md)?(?:\`|\\]\\])?`, 'i');

/**
 * A bullet that is a **record**, not an objective: the division leads append the jobs they queued under their own
 * `### <team>` section, and the live vault shows all three spellings — `- [[Jobs/job_x.md]]`, `- Jobs/job_x.md`
 * and a bare `- job_x`. Those are what came of the plan, and are never asked to name an idea; only the objectives
 * the CEO wrote are.
 *
 * A bullet that is **nothing but a wikilink** counts too, whatever it points at: an objective states an outcome
 * in words, so a bare link is somebody's cross-reference. That is the shape the division lead's goal now asks
 * for, and reading a link as an objective would refuse the next plan for a bullet nobody wrote as one.
 */
const JOB_BULLET_RE = /^(?:\[\[)?Jobs\/|^job_/i;
const LINK_ONLY_RE = /^\[\[[^\]]+\]\]\.?$/;

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
        const head = bullet[1].trim();
        if (!JOB_BULLET_RE.test(head) && !LINK_ONLY_RE.test(head)) lines = [bullet[1]];
        continue;
      }
      if (lines && line.trim()) lines.push(line.trim());
      else if (!line.trim()) flush();
    }
    flush();
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// Does the plan still sell what the card says? (Ruling W4-2)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The sections of an idea card the **board** and the arithmetic wrote, which are never the card's own account
 * of the product.
 *
 * Load-bearing, and the whole reason this check works. `## The board` carries the chair's pivot verbatim — on
 * the live run, `Ideas/speedaudit.md` held "WEDGE: E-commerce founders doing $10k–$50k/month on Shopify…" and
 * four `Fix:` clauses proposing a different business. Match an objective against *that* and the drift launders
 * itself: the plan pivots, the board's own words are on the card, and the card agrees with the plan about a
 * product the owner never picked.
 */
const CARD_WRITTEN_SECTIONS = ['## The board', '## Score', '## Decision'];

/** The card as its author described the product: the title, and the body with the board's sections dropped. */
export function ideaProductText(vault: Vault, slug: string): string {
  const card = readIdea(vault, slug);
  if (!card) return '';
  const out: string[] = [card.data.title];
  let dropping = false;
  for (const line of card.body.replace(/\r/g, '').split('\n')) {
    if (/^## /.test(line)) dropping = CARD_WRITTEN_SECTIONS.includes(line.trim());
    if (!dropping) out.push(line);
  }
  return out.join('\n');
}

/**
 * Words that say **how** a company works rather than **what** it sells, and are therefore no evidence that an
 * objective and a card are about the same thing.
 *
 * Calibrated against the live run, not guessed at. Every word in here appears both in the drifted technology
 * objective ("Ship a zero-install, read-only public URL scanner with automated Stripe webhook replay
 * protection and static snapshot analysis, complete with automated tests and a green CI record") and somewhere
 * in `Ideas/speedaudit.md` — `automated`, `tests`, `zero`, `complete`, `record` — so a rule that counted them
 * would have found the plan and the card in perfect agreement about two different businesses.
 */
const PLAN_FILLER = new Set([
  'ship', 'build', 'builds', 'launch', 'deliver', 'create', 'develop', 'define', 'secure', 'verify', 'reconcile',
  'maintain', 'ensure', 'establish', 'complete', 'execute', 'review', 'audit', 'implement', 'improve', 'increase',
  'reduce', 'validate', 'measure', 'report', 'deploy', 'enable', 'support', 'provide', 'with', 'that', 'this',
  'from', 'into', 'their', 'them', 'they', 'have', 'been', 'will', 'while', 'when', 'where', 'which', 'what',
  'initial', 'baseline', 'first', 'second', 'third', 'across', 'using', 'than', 'then', 'only', 'also', 'more',
  'most', 'less', 'least', 'week', 'month', 'year', 'quarter', 'cycle', 'plan', 'objective', 'stream', 'idea',
  'team', 'work', 'jobs', 'test', 'tests', 'testing', 'automated', 'automation', 'record', 'green', 'zero',
  'metric', 'number', 'outcome', 'process', 'target', 'goal', 'each', 'every', 'some', 'over', 'under', 'after',
  'before', 'between', 'through', 'during', 'against', 'about', 'above', 'below', 'again', 'further', 'once',
  'here', 'there', 'whose', 'being', 'does', 'doing', 'could', 'should', 'would', 'might', 'must', 'shall',
]);

/** How short a word may be and still say what a company sells. `URL` and `API` are three letters and generic. */
const PRODUCT_WORD_MIN = 4;

/**
 * The words of a stretch of text that could name a product, folded so a plural and its singular are one word.
 * Both sides of the comparison are folded the same way, so `diagnostics` on the card answers `diagnostic` in
 * the objective and neither side has to guess the other's grammar.
 */
export function productWords(text: string): string[] {
  const out = new Set<string>();
  for (const raw of (text ?? '').toLowerCase().replace(/\b(?:idea|stream|process):\s*\S+/g, ' ').split(/[^a-z0-9]+/)) {
    if (raw.length < PRODUCT_WORD_MIN) continue;
    const word = raw.length > PRODUCT_WORD_MIN && raw.endsWith('s') ? raw.slice(0, -1) : raw;
    if (PLAN_FILLER.has(raw) || PLAN_FILLER.has(word)) continue;
    out.add(word);
  }
  return [...out];
}

/**
 * The verbs that promise a **thing**, and the only objectives the product check applies to.
 *
 * The drift is always in what the company builds. "Get 200 newsletter subscribers" and "Secure the first 3
 * pilot users" are distribution and revenue work that legitimately names no product — asking them to repeat
 * the card's nouns would refuse half of every honest plan — whereas "Ship a zero-install, read-only public URL
 * scanner" is a promise to build something, and what it builds has to be the thing on the card.
 */
const BUILD_VERB_RE = /^(?:ship|build|launch|develop|create|implement|release)\b/i;

/** True for an objective that promises to build something, which is the one kind this check can judge. */
export function promisesAProduct(text: string): boolean {
  return BUILD_VERB_RE.test((text ?? '').trim().replace(/^[-*+]\s+/, ''));
}

/** Where an objective stops naming the thing and starts naming how it will be done. */
const PRODUCT_TAIL_RE = /\s+(?:with|by|for|to|that|while|using|through|across|and|complete)\s|,\s*complete\b|\b(?:idea|stream|process):/i;

/**
 * The product an objective says it will produce: the object of its leading verb, up to the first word that
 * turns the sentence into a method. "Ship a zero-install, read-only public URL scanner with automated Stripe
 * webhook replay protection" is a promise about a scanner; everything after `with` is how.
 *
 * Quoted in the finding so the CEO reads what its own bullet named, beside the card it claimed to serve.
 */
export function objectiveProduct(text: string): string {
  const one = (text ?? '').replace(/\s+/g, ' ').trim().replace(/^[-*+]\s+/, '');
  const body = one.replace(/^(?:\w+)\s+/, (m) => (/^(?:ship|build|launch|deliver|create|develop|define|secure|verify|reconcile|maintain|ensure|establish|execute|review|audit|implement|improve|increase|reduce|validate|measure|deploy|enable|support|provide)\s+$/i.test(m) ? '' : m));
  const cut = body.split(PRODUCT_TAIL_RE)[0].trim().replace(/[.,;:]+$/, '');
  return cut || one;
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
    if (kept.some((k) => k.toLowerCase() === o.idea)) {
      // Rule 3 (ruling W4-2). Naming a kept idea is not serving it: the live run's technology objective ended
      // `stream: speedaudit` and shipped a zero-install URL scanner with Stripe webhook replay protection,
      // which is not what the SpeedAudit card says the company sells. An objective and the card it serves have
      // to share at least one word that names a product — not a word about how the work is done.
      if (!promisesAProduct(o.text)) continue;
      const card = productWords(ideaProductText(vault, o.idea));
      if (!card.length) continue;   // a card with no prose yet cannot refute anything
      const said = productWords(o.text);
      if (said.some((w) => card.includes(w))) continue;
      findings.push(`The objective "${quote(o.text)}" under \`### ${o.team}\` serves \`${PLAN_IDEA_MARKER} ${o.idea}\`, but nothing it names is on that card: it is about "${quote(objectiveProduct(o.text))}", and [[${ideaPath(o.idea).replace(/\.md$/, '')}]] is about "${quote(readIdea(vault, o.idea)?.data.title ?? o.idea)}". A plan may not change what the company sells. If the board wants a different product, the owner keeps its pivot card first.`);
      continue;
    }
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

/** The `idea:` slugs a plan's objectives serve, lower-cased and deduplicated, in the order they appear. */
export function planIdeaSlugs(planMd: string): string[] {
  return [...new Set(planObjectives(planMd).map((o) => o.idea).filter((s): s is string => !!s))];
}

/**
 * Does the rewrite the board asked for serve the same ideas the plan it returned did? (Ruling W4-2.)
 *
 * `plan.vetoed` at 07:32, `job_20260914_7b93ca` "Rewrite the plan after the board", and by 13:02 the technology
 * objective had gone from "Ship the initial SpeedAudit diagnostic service baseline" to "Ship a zero-install,
 * read-only public URL scanner with automated Stripe webhook replay protection". No return, no owner decision.
 * A board return is a request to answer findings about the ideas the owner kept; it is never a licence to plan
 * a different business, and a rewrite that reaches for a new slug has taken it as one.
 *
 * **Only an added slug is refused, never a dropped one.** A CEO that answers a finding by cutting an objective
 * has done what it was asked; refusing that too would leave a rewrite with no legal move and stall the company
 * behind a plan nobody can write. Adding is the drift direction, and the CEO can always avoid it.
 */
export function checkPlanRewrite(planMd: string, vetoed: readonly string[]): PlanCheck {
  if (!vetoed.length) return { ok: true, findings: [] };
  const was = new Set(vetoed.map((s) => s.toLowerCase()));
  const findings = planIdeaSlugs(planMd).filter((s) => !was.has(s)).map((s) =>
    `The rewritten plan serves \`${PLAN_IDEA_MARKER} ${s}\`, which the plan the board returned did not: it served ${keptList([...was])}. A rewrite answers the board's findings about the ideas the owner kept; it does not change what the company sells. If the board wants a different product, the owner keeps its pivot card first.`);
  return { ok: findings.length === 0, findings };
}

/**
 * What the owner is told on the plan verdict when the board asked for a different product and the CEO wrote the
 * plan it was asked to write anyway (ruling W4-2). The disagreement is real and it is theirs to settle, so it
 * is said in one sentence with both options in it rather than resolved by whichever of the two wrote last.
 */
export function planPivotDisagreement(pivotSlug: string): string {
  return `The board and the CEO disagree: approve the plan as written, or keep the pivot card [[${ideaPath(pivotSlug).replace(/\.md$/, '')}]].`;
}
