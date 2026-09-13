/**
 * Scripted model for the org-shaped planning cycle (spec §3): the CEO writes the plan; the board returns it once
 * then passes; division leads enqueue one job each; everyone else finishes. Shared by `packages/daemon/test/planning.test.ts`
 * and `scripts/test-kill9.ts` (planning fan-out scenario) so both exercise the exact same scripted behaviour.
 */
import type { RoutedChatResult, RouteRequest, ChatMessage, ToolSchema } from '@cubicle/router';
import type { Llm } from '@cubicle/harness';
import { DISCOVERY_INBOX, FOUNDER_BRIEF } from '@cubicle/core';

export const PLAN = '---\ncycle: 1\n---\n# Plan\n\n## Objectives\n\n### dev\n- Scaffold the site from Brand/\n\n### revenue\n- Find the first organic channel\n';

/**
 * The brief the scripted discovery job files. It used to be `founderBriefTemplate()` — the *empty* template,
 * which the dispatcher has always refused on adoption and which `checkFounderBrief` now refuses at
 * `proposal.create` (ruling FR-4), since a brief that is still the template is the one document guaranteed to
 * say nothing true.
 *
 * So it is written out, and written *honestly*: the company has no name and the brief says so, the interview
 * has not been answered and the brief says so, Founder-Market Fit is `unstated` because nothing establishes it,
 * and the pressure test ends on a verdict. That is exactly the shape a real discovery job now has to produce,
 * which is the point of a fixture.
 */
export const SCRIPTED_FOUNDER_BRIEF = [
  '## What the company is', '',
  'Meal kits for nurseries: a weekly box of ingredients and recipes, from what the owner dropped in the discovery inbox.', '',
  '## Who it is for', '',
  'Nursery managers who order lunch for 20–60 children a day and cook it on site.', '',
  '## What already exists', '',
  'Two nurseries already pay for a weekly box. The company has no name yet — Brand/name.md carries an empty name — and the founder interview has not been answered, so nothing is quoted from it here.', '',
  '## What success looks like', '',
  'Unstated: the owner has not said what three months from now would have to look like.', '',
  '## Constraints', '',
  'The free tier only, and no money out of pocket until a second nursery has paid twice.', '',
  '## Candidate ideas', '',
  '- the-idea-the-owner-described — a weekly meal-kit box for nurseries.', '',
  '## What we do not know', '',
  'Who the owner is, what a nursery spends on lunch today, and whether anybody has priced delivery.', '',
  '## Pressure test', '',
  '**Core Assumption:** nurseries will pay weekly for a box of food they currently buy and cook themselves.',
  '**Three Fatal Flaws:** delivery has never been priced; the manager orders but the parents pay; allergen liability follows whoever supplies the food.',
  '**Problem Validation:** a painkiller — two nurseries already pay, and the rest cook it on site every morning.',
  '**Founder-Market Fit:** unstated — nothing the owner has given us says who they are or what they have run before.',
  '**Brutal Verdict:** WEAK — delivery is unpriced and the second nursery has bought once.', '',
].join('\n');

/**
 * The three ideas the CEO offers an owner who typed "surprise me" (heartbeat `SURPRISE_ASK`).
 *
 * Written out in full, and each line complete, because `completeIdeaLines` drops a line the model stopped
 * mid-sentence: a fixture that hands back two-and-a-half ideas would test `SURPRISE_FAILED` and nothing else.
 */
export const THREE_IDEAS = [
  'CrateMate — weekly allergen-checked meal kits for nursery kitchens.',
  'Tuckbox — a Saturday recipe box for families who batch-cook on Sundays.',
  'Provender — per-child-per-week lunch supply for village pre-schools.',
];

/**
 * The CEO's own six answers to the founder interview (ruling P8-13), tagged the way `parseCeoAnswers` reads
 * them. Only the first is `[from the idea]` — the owner has said nothing else at this point, and a fixture that
 * tagged all six as established would let a brief cite the owner's word for answers nobody gave.
 */
export const SIX_CEO_ANSWERS = [
  'A weekly box of allergen-checked ingredients and recipes for nursery kitchens. [from the idea]',
  'Nursery managers who order lunch for twenty to sixty children and cook it on site. [from the idea]',
  'Nothing exists yet: no site, no customer, no price. [unstated]',
  'Ten nurseries on a weekly order would make three months worth it. [from the idea]',
  'I do not know what has been tried before. [unstated]',
  'Nothing has been ruled out yet. [unstated]',
];

export function orgLlm(opts: {
  vetoes?: number; plan?: string; boardSilent?: boolean; ideaVerdict?: 'pass' | 'return';
  ideaChair?: 'hedge-then-good' | 'hedge-then-refusal' | 'hedge-then-silence'; trustVerdict?: 'pass' | 'return';
  outboundEmail?: Record<string, unknown>; boardAsksOwner?: string;
  /**
   * The three ideas the surprise path files. Unset, that prompt takes the generic `ok` below, which
   * `completeIdeaLines` reads as "no complete idea" — the shape every test that is *not* about the surprise
   * path already relies on.
   */
  surpriseIdeas?: string[];
  /** The CEO's six answers to its own founder interview. Unset, the self-interview takes the generic `ok`. */
  selfInterview?: string[];
  /**
   * The pressure verdict the chair gives **the founder brief**, told apart from the idea's by the one phrase
   * only `chairRoundPrompt` for `kind: 'brief'` carries ("this founder brief"). A journey needs the brief to
   * come back WEAK (so the two-step adoption of ruling W3-3 is reachable) while the idea it came from passes,
   * and one global `ideaVerdict` cannot say both.
   */
  briefVerdict?: 'STRONG' | 'WEAK' | 'PIVOT REQUIRED';
  /**
   * Answer the two prompts the CEO writes *to the owner* — the general cabin reply and the "since you were
   * away" brief — instead of `ok`. Both are scripted from what the prompt itself carries, never invented: the
   * reply only invites a "go" when the prompt says the interview is still open (ruling W3-7), and the brief
   * quotes the fact lines it was given.
   */
  ownerReplies?: boolean;
  /**
   * Write a plan whose every objective names the kept idea the goal listed (ruling W3-1). The slug comes out of
   * the `Kept ideas — …` block in the plan job's own goal, so the fixture cannot name an idea the company has
   * not kept. Falls back to `plan` when the goal lists none.
   */
  planKeptIdea?: boolean;
  /**
   * The stream the scripted division plan puts on its `engineer.ship` request. `'site'` is the stream
   * `planning.test.ts` scaffolds; `null` omits it, which is what a company whose only stream was seeded this
   * cycle needs — `scheduler.request` then fills in the sole stream itself.
   */
  shipStream?: string | null;
  /**
   * The title of the one card the standing-intelligence sweeps file. `idea.card` derives `source` from the
   * calling job's type, so a card filed from an `intelligence` job carries `intelligence:<kind>` without being
   * told — which is the provenance ruling W3-5 turns on. Deliberately filed with no research half and no price,
   * because that is the state the ruling is about: the owner has never seen it, so it is listed in the brief for
   * them to promote and never put in front of the board.
   */
  intelligenceCard?: string;
} = {}): Llm & { calls: Record<string, number> } {
  let vetoes = opts.vetoes ?? 1;
  const plan = opts.plan ?? PLAN;
  const shipStream = opts.shipStream === undefined ? 'site' : opts.shipStream;
  const per = new Map<string, number>();
  const llm = {
    calls: {} as Record<string, number>,
    async chat(req: RouteRequest, chat: { messages: ChatMessage[]; tools?: ToolSchema[] }): Promise<RoutedChatResult> {
      const role = req.roleId ?? '?'; llm.calls[role] = (llm.calls[role] ?? 0) + 1;
      const base = { content: '', toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 5, completion_tokens: 1 }, provider: 'f', model: 'f', tier: 'medium' as const, downgraded: false, parsedToolCalls: [] as { name: string; args: Record<string, unknown> }[] };
      if (!chat.tools) {
        const last = String(chat.messages.at(-1)?.content ?? '');
        // A coffee in the pantry (SP5 §6). Answered properly rather than with the `ok` below, so a scripted run
        // exercises the whole path — six turns, the closing `IDEA:` line, and the deterministic rule that judges
        // it (ruling Q16). Checked first: the pantry's closing prompt is the only other one that says `IDEA:`,
        // and it says nothing about a verdict, so it can never be mistaken for the board's.
        if (/having a coffee in the pantry/.test(last)) {
          return { ...base, tier: 'cheap' as const, content: /IDEA: <one sentence>/.test(last)
            ? 'The nurseries would pay for it before we build anything.\nIDEA: A weekly meal-kit box for nurseries'
            : 'The nurseries keep asking whether we deliver a weekly box.' };
        }
        // The surprise path (heartbeat `SURPRISE_ASK`, ruling FR-2): three *complete* numbered lines, or the CEO
        // files nothing. Checked here because the same cycle's other prompts never say "surprise them".
        if (opts.surpriseIdeas && /surprise them/.test(last)) {
          return { ...base, content: opts.surpriseIdeas.map((l, i) => `${i + 1}. ${l}`).join('\n') };
        }
        // The CEO answering the six founder questions itself (ruling P8-13). One numbered line per question,
        // each ending in one of the three tags `parseCeoAnswers` accepts.
        if (opts.selfInterview && /answering the founder interview \*\*yourself\*\*/.test(last)) {
          return { ...base, content: opts.selfInterview.map((a, i) => `${i + 1}. ${a}`).join('\n') };
        }
        // The CEO's reply in the cabin. Deliberately literal about the one thing ruling W3-7 turns on: the
        // invitation to add, correct or say "go" is written only when the prompt asked for it, so a test can
        // prove the invitation stops once the interview is closed rather than prove the fixture's own taste.
        if (opts.ownerReplies && /^The owner wrote:/.test(last)) {
          const open = /still with them/.test(last);
          const brief = /long brief rather than a one-line idea/.test(last);
          return { ...base, content: [
            'Understood. The research office reads everything you have given us and files the founder brief you approve; nothing is planned until you do.',
            brief ? 'Your document goes to them in full — I will not summarise it for you.' : '',
            open ? 'Anything to add, any correction, or just "go", is all I need.' : '',
          ].filter(Boolean).join(' ') };
        }
        // The "since you were away" brief. Built from the fact lines the prompt carries — the three headings the
        // heartbeat validates, and the facts verbatim underneath — so the note the owner reads cannot contain
        // anything the cycle did not report.
        if (opts.ownerReplies && /Write the owner's "since you were away" brief/.test(last)) {
          const factLine = (label: string) => last.match(new RegExp(`^${label}: (.*)$`, 'm'))?.[1] ?? 'nothing';
          return { ...base, content: [
            '## What happened', `- Finished jobs: ${factLine('Finished jobs')}`, '',
            "## What's next", `- Queued next: ${factLine('Queued next')}`, '',
            '## What needs you', ...factLine('Needs owner').split(' | ').map((r) => `- ${r.replace(/^- /, '')}`),
          ].join('\n') };
        }
        // A board chair's merge prompt, for either subject, names the exact verdict line; an advisor's does not.
        // Since SP3 the board also sits on ideas, and both chair prompts ask for "VERDICT: pass" — so the plan's
        // chair is identified by the phrase only its prompt carries ("this plan"; the idea's says "this idea").
        // Without that, an idea session would spend the scripted plan veto below.
        const planChair = /VERDICT: pass/.test(last) && /this plan/.test(last);
        // SP8 §3: the same test, held as a dialogue. The chair's round turn closes the part just argued and
        // opens the next; the verdict turn closes the last part and votes. The five parts the owner reads are
        // the round findings, so the `PART` table below is what a full session files too — one round at a time
        // instead of all five in one merge. Checked before `planChair`, whose phrases the dialogue's own plan
        // verdict turn also carries.
        const dialogueChair = /^You chair the board of this company\./.test(last);
        const dialogueAdvisor = /The chair has asked, on \*\*/.test(last);
        if (opts.boardSilent && (dialogueChair || dialogueAdvisor)) throw new Error('no model available');
        if (dialogueAdvisor) return { ...base, content: 'Two nurseries already pay a caterer every term, so the pain is priced; nobody has quoted the 7am van.' };
        // `boardSilent` simulates "no model was available" for every board call (advisors and chair alike),
        // the same way askAs's catch does when deps.llm.chat throws — used to test the zero-advisors-answered path.
        if (opts.boardSilent && (/VERDICT: pass/.test(last) || /VERDICT: STRONG/.test(last) || /Imagine the cycle has already failed/.test(last) || /Pressure test it the way Paul Graham reads a YC application/.test(last))) throw new Error('no model available');
        if (planChair && !dialogueChair) { const v = vetoes-- > 0; return { ...base, content: v ? 'VERDICT: return\n- growth objective has no metric' : 'VERDICT: pass\n- watch the free tier' }; }
        if (/Imagine the cycle has already failed/.test(last)) return { ...base, content: '- the plan names no metric — add one\n- nobody owns the deploy — name them' };
        // The board sitting on an idea (SP3, re-shaped by SP5b): the chair's merge prompt asks for one of the
        // three pressure-test words where the plan's asks for pass/return, and the advisors are asked to
        // pressure test rather than to imagine a lost quarter. `ideaVerdict` drives both outcomes — a pass
        // leaves the score's recommendation standing, a return parks the card — and the chair answers in the
        // words `readPressureVerdict` accepts, rubric line and all, so a scripted run exercises the real parse.
        // The five parts in full, not just the two machine lines and the flaws: the chair's whole answer is kept
        // now (ruling H3), so the scripted chair has to write the whole answer for a scripted run to exercise it.
        //
        // Written as a table keyed on the part because SP8's dialogue reaches the same five findings one round
        // at a time: the brief chair merges them in one call, the full chair rules on one per round, and both
        // have to land the same words on the card or a scripted run would be testing the script.
        const PART: Record<string, string> = opts.ideaVerdict === 'return' ? {
          'Core Assumption': 'Nurseries buy food centrally, not per site.',
          'Three Fatal Flaws': '- nobody has priced delivery',
          'Problem Validation': 'A vitamin at the single site: the cook already shops on the way in.',
          'Founder-Market Fit': 'The owner ran a nursery kitchen for six years.',
          'Brutal Verdict': 'Attack the chain, not the site.',
        } : {
          'Core Assumption': 'Nurseries will pay 40 a week to stop planning meals.',
          'Three Fatal Flaws': '- watch the free tier',
          'Problem Validation': 'A painkiller: they already pay a caterer every term.',
          'Founder-Market Fit': 'The owner ran a nursery kitchen for six years.',
          'Brutal Verdict': 'Build the cheap test this week.',
        };
        const PARTS = ['Core Assumption', 'Three Fatal Flaws', 'Problem Validation', 'Founder-Market Fit', 'Brutal Verdict'];
        // Which subject this chair is ruling on. `chairRoundPrompt` writes "this founder brief" for a brief
        // session and "this idea" for an idea one, and that phrase is the only thing that tells them apart — so
        // a journey can have the brief come back WEAK while the idea it came from passes.
        const briefChair = /pressure-testing this founder brief/.test(last);
        const machineLines = briefChair && opts.briefVerdict
          ? `VERDICT: ${opts.briefVerdict}\nRUBRIC: core assumption 1, fatal flaws 2, pain 2, founder fit 1, why now 1${opts.briefVerdict === 'PIVOT REQUIRED' ? '\nWEDGE: the one nursery chain that already orders together' : ''}`
          : opts.ideaVerdict === 'return'
          ? 'VERDICT: PIVOT REQUIRED\nRUBRIC: core assumption 1, fatal flaws 1, pain 1, founder fit 1, why now 1\nWEDGE: the one nursery chain that already orders together'
          : 'VERDICT: STRONG\nRUBRIC: core assumption 2, fatal flaws 1, pain 2, founder fit 1, why now 1';
        const ideaMerge = `${machineLines}\n\n${PARTS.map((p) => `## ${p}\n${PART[p]}`).join('\n\n')}`;
        if (dialogueChair) {
          const close = last.match(/close the round on \*\*([^*]+)\*\*/)?.[1] ?? '';
          const open = last.match(/the question of \*\*([^*]+)\*\*/)?.[1] ?? '';
          // SP8 §3: one round the material cannot answer, so the chair asks the owner instead of guessing.
          const finding = !close ? ''
            : close === opts.boardAsksOwner ? `QUESTION FOR THE OWNER: what have you actually run before?\n\n`
            : `FINDING: ${PART[close] ?? `the board holds ${close} answered.`}\n\n`;
          if (/VERDICT: STRONG or WEAK or PIVOT REQUIRED/.test(last)) return { ...base, content: `${finding}${opts.ideaChair ? 'VERDICT: STRONG\nIt has potential, but the margins worry me.' : machineLines}` };
          if (/First line exactly "VERDICT: pass"/.test(last)) { const v = vetoes-- > 0; return { ...base, content: `${finding}${v ? 'VERDICT: return\n- growth objective has no metric' : 'VERDICT: pass\n- watch the free tier'}` }; }
          return { ...base, content: `${finding}NEXT: On ${open}: what does this rest on, and how would we know it was false?` };
        }
        // The chair's one re-ask (SP5b). It repeats the whole format the first ask gave, so it matches the idea
        // chair's own discriminator too and must be tested FIRST; "That answer was not usable" is the phrase
        // only it carries. `hedge-then-silence` throws the way `askAs`'s catch sees a model that has gone away.
        if (/That answer was not usable/.test(last)) {
          if (opts.ideaChair === 'hedge-then-silence') throw new Error('no model available');
          return { ...base, content: opts.ideaChair === 'hedge-then-refusal' ? 'VERDICT: it depends' : ideaMerge };
        }
        if (/VERDICT: STRONG/.test(last) && /this idea/.test(last)) {
          // `ideaChair` makes the one re-ask scriptable: the chair hedges first, and the branch above decides
          // what it does when asked again. Left unset, the chair answers properly the first time, as it does
          // in every existing scenario, and the re-ask branch is never reached.
          return { ...base, content: opts.ideaChair ? 'VERDICT: STRONG\nIt has potential, but the margins worry me.' : ideaMerge };
        }
        if (/Pressure test it the way Paul Graham reads a YC application/.test(last)) return { ...base, content: '1. Core Assumption — nurseries will pay weekly.\n2. Three Fatal Flaws\n- nobody has priced delivery — get a quote first\n3. Problem Validation — painkiller.\n4. Founder-Market Fit — the owner ran a kitchen.\n5. Brutal Verdict — WEAK.' };
        return { ...base, content: /NAME:/.test(last) ? 'NAME: X\nTAGLINE: y' : 'ok' };
      }
      const jobMsg = String(chat.messages[1]?.content ?? '');
      // A first cut on a stream that has no pipeline yet. §17's guardrail refuses `finish(done)` on an
      // `engineer.ship` with no green CI record, and hands the refusal back as a tool result — so an author that
      // read it would stop rather than call `finish` again for ever. Without this the scripted engineer retries
      // until the worker pool gives up, which spends a free tier on a job that cannot succeed and drowns the
      // event log in one message. A test with a green record (planning.test.ts) never reaches this.
      if (/no CI record for stream/.test(chat.messages.map((m) => String(m.content ?? '')).join('\n'))) {
        return { ...base, parsedToolCalls: [{ name: 'finish', args: { status: 'blocked', summary: 'this stream has no pipeline yet, so the first cut cannot be validated; it waits for one' } }] };
      }
      const jobId = jobMsg.match(/Jobs\/(job_\w+)\.md/)?.[1] ?? 'x';
      const n = per.get(jobId) ?? 0; per.set(jobId, n + 1);
      const jobType = jobMsg.match(/type: ([\w.]+)/)?.[1] ?? '';
      const jobTitle = jobMsg.match(/title: ([^·\n]+)/)?.[1]?.trim() ?? '';
      // The "launch" process's step titles ("Build: ...", "Announce: ...", "Outreach: ...", "Measure launch") —
      // never finish these so they are provably still open (queued/running) when the heartbeat completes, proving
      // division_plans does not wait on process-expanded jobs (Task 9 review round 2). No other test's jobs use these
      // titles, so this is a no-op everywhere else.
      if (/^(Build|Announce|Outreach|Measure launch):? /.test(jobTitle) || jobTitle === 'Measure launch') return { ...base, parsedToolCalls: [{ name: 'vault.read', args: { path: 'Plans/plan.md' } }] };
      // A standing-intelligence sweep that found one thing worth doing. Every kind proposes the same title, so
      // `idea.card`'s own same-title rule leaves the company with one card and not four.
      if (jobType === 'intelligence' && opts.intelligenceCard) {
        const calls = [
          { name: 'idea.card', args: { title: opts.intelligenceCard, evidence: ['Research/index.md'], what_changed: 'The sweep found this while reading, not the owner.', why_it_matters: 'Nobody has asked for it yet.' } },
          { name: 'finish', args: { status: 'done', summary: 'swept and filed one card' } },
        ];
        return { ...base, parsedToolCalls: [calls[Math.min(n, 1)]] };
      }
      if (jobType === 'company.plan') {
        // Ruling W3-1: every objective names the idea it serves, and the only ideas it may name are the ones the
        // goal's `Kept ideas` block lists. Read from the goal rather than from a constant, so the fixture cannot
        // invent a kept idea — and so a run where the board kept nothing falls back to the plain plan.
        const kept = opts.planKeptIdea ? [...jobMsg.matchAll(/\[\[Ideas\/([a-z0-9][a-z0-9-]*)\]\]/g)].map((m) => m[1])[0] : undefined;
        const text = kept ? [
          '---', 'cycle: 1', '---', '# Plan', '', '## Objectives', '',
          '### dev',
          `- Ship the first cut of Site/ so a visitor can say what we sell — idea: [[Ideas/${kept}]]`, '',
          '### revenue',
          `- Find the first organic channel and publish three things on it — idea: [[Ideas/${kept}]]`, '',
        ].join('\n') : plan;
        return { ...base, parsedToolCalls: [n === 0 ? { name: 'vault.write', args: { path: 'Plans/plan.md', content: text } } : { name: 'finish', args: { status: 'done', summary: 'objectives written' } }] };
      }
      // Discovery (SP3): read everything once, file one candidate card, propose the founder brief, finish. The
      // real job also runs `research.start`; the scripted one skips it so a test does not need a project
      // directory, but it leaves behind exactly what the heartbeat's next two steps read — an `Ideas/<slug>.md`
      // card for `ideas_board` to price and sit on, and one open `founder_brief` proposal, which is what stops
      // the next cycle asking the owner the same thing again.
      if (jobType === 'discovery') {
        const calls = [
          { name: 'discovery.inputs', args: { max_chars: 6000 } },
          // Evidence points at the material the card was read from, which exists; citing the founder brief here
          // would cite a file this job has not proposed yet. `source: discovery` is not an argument — `idea.card`
          // derives provenance from the calling job's type — so the real card carries it without being told.
          // The research half rides along, as a real discovery job's does "where your research supports a view":
          // without it the card can never be scored, so the board could never sit on it in the same cycle.
          { name: 'idea.card', args: { title: 'The idea the owner described', evidence: [DISCOVERY_INBOX], what_changed: 'The owner told us what they are building.', why_it_matters: 'It is the only candidate on the table.', research: { report: 'Research/the-idea/report.md', confidence: 'medium', summary: 'Two comparable services charge for this today.', evidence: 4, fit: 4 } } },
          { name: 'proposal.create', args: { kind: 'founder_brief', target: FOUNDER_BRIEF, title: 'The founder brief', body: `## Proposed content\n\n\`\`\`\n${SCRIPTED_FOUNDER_BRIEF}\n\`\`\`\n` } },
        ];
        return { ...base, parsedToolCalls: [calls[n] ?? { name: 'finish', args: { status: 'done', summary: 'the founder brief is with the owner' } }] };
      }
      // Pricing one card (SP3 §5.3): the CFO reads the slug out of its own goal — `estimateGoal` writes
      // `slug: "<id>"` — and answers the two numbers only the finance office may write. With this the scripted
      // first run really does reach the board: discovery files a card, finance prices it, the score completes.
      if (jobType === 'finance.estimate') {
        const slug = jobMsg.match(/slug: "([a-z0-9-]+)"/)?.[1];
        if (n === 0 && slug) return { ...base, parsedToolCalls: [{ name: 'idea.card', args: { title: 'The idea the owner described', slug, estimate: { text: 'Two people for three weeks, no money out of pocket.', value: 4, effort: 4 } } }] };
        return { ...base, parsedToolCalls: [{ name: 'finish', args: { status: 'done', summary: slug ? `priced ${slug}` : 'no card named' } }] };
      }
      if (jobType === 'division.plan') {
        // The division leads: the CTO schedules into the Dev room, the CFO asks Research for the revenue question.
        const member = role === 'cto' ? 'backend_engineer' : role === 'cfo' ? 'research_manager' : null;
        const isResearch = member === 'research_manager';
        const research = isResearch ? {
          decision: 'Ship the pricing page or keep the waitlist',
          decision_owner: role,
          question: 'Does a public price reduce signups?',
          hypothesis: 'A public price cuts signups by more than 20%',
          known_evidence: 'Two competitors publish prices',
          unknowns: 'Whether our visitors are price-sensitive',
          constraints: 'No paid tooling',
          deadline: '2026-09-25',
          required_confidence: 'medium',
          potential_decisions: ['Publish the price', 'Keep the waitlist'],
          portfolio: 'incremental',
          impact: 4, uncertainty: 4, cost_of_being_wrong: 4,
        } : undefined;
        return { ...base, parsedToolCalls: [n === 0 && member ? { name: 'scheduler.request', args: { type: isResearch ? 'research' : 'engineer.ship', title: `Do ${role}`, assigned: member, goal: 'g', done_when: 'd', for: isResearch ? role : undefined, risk: isResearch ? undefined : 'low', stream: member === 'backend_engineer' ? (shipStream ?? undefined) : undefined, research } } : { name: 'finish', args: { status: 'done', summary: 'planned' } }] };
      }
      // SP5: a trust review reads the exact call out of its own goal and answers with one verdict. Identified by
      // the words only `trustGateGoal` writes, so an ordinary chain `office:security.review` (which has a parent
      // and a different goal) still takes the generic pass below.
      if (/before it leaves the company/.test(jobMsg)) {
        const verdict = opts.trustVerdict ?? 'pass';
        return { ...base, parsedToolCalls: [{ name: 'finish', args: { status: 'done', verdict, findings: verdict === 'return' ? ['the body has no unsubscribe line'] : [], summary: `read the call and ${verdict === 'return' ? 'returned' : 'passed'} it` } }] };
      }
      // SP5: an outreach job that actually sends something, so a test can watch a call leave the company. One
      // send, then finish: the counter is per job, so a resumed job (its proposal answered) finishes rather than
      // filing a second call — which is why a test must keep one scripted model for the whole life of a job.
      if (jobType === 'growth.outreach' && opts.outboundEmail) {
        const calls = [{ name: 'email.send', args: opts.outboundEmail }, { name: 'finish', args: { status: 'done', summary: 'the email is with the offices' } }];
        return { ...base, parsedToolCalls: [calls[Math.min(n, 1)]] };
      }
      return { ...base, parsedToolCalls: [{ name: 'finish', args: { status: 'done', summary: `${role} done`, verdict: 'pass' } }] };
    },
    promptBudget: () => 6000,
  };
  return llm;
}
