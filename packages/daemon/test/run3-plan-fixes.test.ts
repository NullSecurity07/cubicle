/**
 * The third live run's findings about the *plan* and the CEO's own voice (ledger
 * `sdd/2026-09-13-run3-fixes/progress.md`), each pinned by the behaviour the owner saw:
 *
 * R3-1 (ruling W3-1) The company pivoted on its own. The board ruled PIVOT REQUIRED on the founder brief and on
 *      the one kept idea; the CEO's rewrite was "aligned with the board's recommendations"; and the plan became
 *      signed SBOM attestations, compliance design partners and maintainer outreach. Not one objective cited a
 *      kept idea, and nothing in the pipeline asked it to.
 * R3-2/R3-4 (ruling W3-2) A board "fix by …" never rewrites the plan: the chair's proposed pivot becomes a
 *      candidate idea card the owner rules on, and the plan goes on serving what they already kept.
 * R3-5 (ruling W3-6) "WhAtS hppening rn?" was answered with three paragraphs about governance teams monitoring
 *      compliance protocols, and ended on the founder interview's "just go" line.
 * R3-7 (ruling W3-7) The interview stayed open after the brief was adopted, so every reply asked the owner to
 *      add to a document the company had already finished acting on.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  scaffoldVault, Vault, createJob, createProposal, listJobs, listIdeas, readIdea, writeIdeaCard, updateIdea,
  renderInterviewAsked, interviewPhase, INTERVIEW_PATH, FOUNDER_BRIEF, hasFounderBrief,
  BOARD_IDEA_SOURCE, checkPlan, updateJob, readJob,
} from '@cubicle/core';
import { ToolRegistry, parseToolsConfig } from '@cubicle/tools';
import type { Llm } from '@cubicle/harness';
import {
  runHeartbeat, createHeartbeatJob, HEARTBEAT_STEPS,
  answerOwnerMessages, unansweredOwnerMessages, isStatusQuestion, statusFacts,
  chairPivotText, fileChairPivot, planIdeaRule, dispatchProposals,
} from '../src/index.js';
import { adoptFounderBrief } from './helpers/brief.js';
import { noLocalModel } from './helpers/no-local-model.js';

let dir: string; let vault: Vault;
beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-run3-plan-'));
  vault = (await scaffoldVault(dir)).vault;
  noLocalModel(vault);
});
afterEach(() => { try { vault.close(); } catch { /* already closed */ } rmSync(dir, { recursive: true, force: true }); });

/** No step under test here needs a model; the brief step falls back to its template when one throws. */
const mute: Llm = { async chat() { throw new Error('no model'); }, promptBudget: () => 6000 };

/** A model that says what the test told it to and records what it was asked. */
function scriptedLlm(replies: (string | null)[] = []): Llm & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    async chat(_req, chat) {
      const user = String(chat.messages.at(-1)?.content ?? '');
      prompts.push(user);
      const next = replies.length ? replies.shift() : user;
      return { content: next ?? '', toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 }, provider: 'fake', model: 'fake', tier: 'cheap', downgraded: false, parsedToolCalls: [] };
    },
    promptBudget: () => 6000,
  };
}

const parkAt = (hbId: string, step: (typeof HEARTBEAT_STEPS)[number]) => updateJob(vault, hbId, { checkpoint_step: HEARTBEAT_STEPS.indexOf(step) }, 'daemon');
const stateFile = (hbId: string, s: object) => {
  mkdirSync(path.join(dir, '.cubicle/jobs'), { recursive: true });
  writeFileSync(path.join(dir, '.cubicle/jobs', `${hbId}.heartbeat.json`), JSON.stringify(s));
};
const writePlan = (body: string) => vault.writeText('Plans/plan.md', `---\nupdated: "${new Date().toISOString().slice(0, 10)}"\ncycle: 1\n---\n${body}`, 'ceo');
const vetoed = () => vault.events.query({ types: ['plan.vetoed'] });
const warnings = () => vault.events.query({ types: ['daemon.warning'] }).map((e) => String(e.payload.message ?? e.payload.reason ?? ''));

function keepIdea(slug: string, title: string): void {
  writeIdeaCard(vault, { slug, title, source: 'discovery' }, 'daemon');
  updateIdea(vault, slug, { decision: 'keep', decided_by: 'owner', status: 'accepted' }, 'daemon');
}

/** The plan the live run wrote after the board's pivot, objective for objective (R3-1). */
const SBOM_PLAN = [
  '# Plan', '', '## Objectives', '',
  '### operations',
  '- Verify verification protocols and ensure weekly review integrity with zero discrepancies. stream: first-product', '',
  '### revenue',
  '- Acquire the first 10 commercial compliance design partners and validate pricing offer demand for signed SBOM attestations. stream: first-product', '',
  '### technology',
  '- Execute direct outreach and manual validation test with 20 maintainers on active supply-chain friction, replacing the static landing page build. stream: first-product', '',
].join('\n');

/** The same three divisions, planning the idea the owner actually kept. */
const ALTSTACK_PLAN = [
  '# Plan', '', '## Objectives', '',
  '### revenue',
  '- Get 200 newsletter subscribers from the directory. stream: first-product idea: altstack', '',
  '### technology',
  '- Publish 20 alternative pages with install notes. stream: first-product idea: altstack', '',
].join('\n');

/** The live plan board session's findings, verbatim from Meetings/2026-09-13-1826-board-plan.md. */
const LIVE_PLAN_FINDINGS = [
  'Demand: Open-source maintainers will not buy self-verification badges for $0-alternative tasks; fix by targeting commercial compliance needs where verification unblocks enterprise sales.',
  'Distribution: Static directories have zero organic reach for developers living in GitHub and Reddit; fix by executing direct outreach to maintainers with active supply-chain friction.',
  'Economics: A $100 price point fails if the value proposition is just developer convenience; fix by pricing the signed SBOM attestation at a level that offsets enterprise sales cycle costs.',
  'Execution: Cycle one objectives currently build a static landing page instead of testing the manual procurement bottleneck; fix by replacing the tech build with a 20-maintainer manual validation test.',
];

/** The live brief board's chair verdict, verbatim from the note the owner adopted. */
const LIVE_BRIEF_VERDICT = '**Brutal Verdict:** PIVOT REQUIRED — The static directory model fails to capture value from founders who trade their own labor for free software, necessitating a pivot from a subscription-based newsletter to a high-intent, affiliate-driven deployment service.';

/** The brief the live run adopted: eight sections, and a pressure test that ends on the board's own verdict line. */
const ALTSTACK_BRIEF = [
  '## What the company is', 'AltStack — a directory of open-source alternatives to expensive SaaS.',
  '## Who it is for', 'Budget-conscious founders.',
  '## What already exists', 'Nothing but the idea.',
  '## What success looks like', '200 newsletter subscribers by the end of the quarter.',
  '## Constraints', 'No money beyond the owner\'s own.',
  '## Candidate ideas', '- [[Ideas/altstack]]',
  '## What we do not know', 'Whether these founders ever pay for anything.',
  '## Pressure test', `**Core Assumption:** they pay for curation.\n${LIVE_BRIEF_VERDICT}`,
].join('\n\n') + '\n';

// ---------------------------------------------------------------------------------------------------------
// W3-1: a plan draws only on kept ideas, and every objective says which one
// ---------------------------------------------------------------------------------------------------------

describe('W3-1: the plan the board talked the CEO into is returned before the board is asked again', () => {
  beforeEach(() => { adoptFounderBrief(vault); keepIdea('altstack', 'AltStack: open-source SaaS alternatives'); });

  it('returns the live SBOM plan to the CEO once, naming every objective that serves no kept idea', async () => {
    writePlan(SBOM_PLAN);
    const hbId = createHeartbeatJob(vault, 'test');
    parkAt(hbId, 'board_premortem');

    const out = await runHeartbeat({ vault, llm: mute, env: {}, now: () => new Date() }, hbId);

    // Requeued at company_plan: "Rewrite the plan after the board", with the findings in the goal.
    expect(out.status).toBe('requeued');
    expect(readJob(vault, hbId)!.data.checkpoint_step).toBe(HEARTBEAT_STEPS.indexOf('board_premortem') - 1);
    // Not one model call was spent: the guard is arithmetic, and it runs before the advisors.
    expect(listJobs(vault).filter((j) => j.type === 'board.premortem')).toHaveLength(0);
    expect(vetoed()).toHaveLength(1);
    const findings = vetoed()[0].payload.findings as string[];
    expect(findings).toHaveLength(3);
    expect(findings.join(' ')).toContain('compliance design partners');
    expect(findings.join(' ')).toContain('altstack');
    expect(String(vetoed()[0].payload.reason)).toContain('no kept idea');
  });

  it('lets a plan whose every objective names the kept idea through to the board', async () => {
    writePlan(ALTSTACK_PLAN);
    const hbId = createHeartbeatJob(vault, 'test');
    parkAt(hbId, 'board_premortem');

    await runHeartbeat({ vault, llm: mute, env: {}, now: () => new Date() }, hbId);

    // The session was held (the advisors' model is mute, so it returns the plan unjudged) — what matters is that
    // the guard did not, and the return says so.
    expect(listJobs(vault).filter((j) => j.type === 'board.premortem')).toHaveLength(1);
    if (vetoed().length) expect(String(vetoed()[0].payload.reason)).toBe('board return');
    expect(checkPlan(vault, vault.readText('Plans/plan.md'))).toEqual({ ok: true, findings: [] });
  });

  it('a second failure asks the board nothing, warns, and names the owner in the brief', async () => {
    writePlan(SBOM_PLAN);
    const hbId = createHeartbeatJob(vault, 'test');
    parkAt(hbId, 'board_premortem');
    stateFile(hbId, { heartbeatId: hbId, vetoes: 1 });   // the one rewrite has already been spent

    const out = await runHeartbeat({ vault, llm: mute, env: {}, now: () => new Date() }, hbId);

    expect(out.status).toBe('done');
    expect(listJobs(vault).filter((j) => j.type === 'board.premortem')).toHaveLength(0);
    expect(warnings().join(' ')).toContain('returned twice');
    expect(warnings().join(' ')).toContain('the board was not asked');
    // …and the one place the owner actually reads: the brief's "What needs you".
    const run = vault.list('Runs', { ext: '.md' }).map((r) => vault.readText(r)).join('\n');
    expect(run).toContain('The plan was refused');
    expect(run).toContain('Keep an idea');
  });

  it('tells the CEO the rule in its own goal, and says the true thing when nothing is kept', () => {
    expect(planIdeaRule(['altstack'])).toContain('idea: <slug>');
    expect(planIdeaRule(['altstack'])).toContain('`altstack`');
    expect(planIdeaRule(['altstack'])).toContain('never a licence to plan a different business');
    expect(planIdeaRule([])).toContain(FOUNDER_BRIEF);
    expect(planIdeaRule([])).not.toContain('idea: <slug>');
  });
});

// ---------------------------------------------------------------------------------------------------------
// W3-2: a pivot is a candidate idea, never a rewritten plan
// ---------------------------------------------------------------------------------------------------------

describe('W3-2: the chair proposes a pivot; the owner rules on it', () => {
  it('reads the pivot out of a PIVOT REQUIRED verdict and out of a plan session\'s product fixes', () => {
    expect(chairPivotText({ text: LIVE_BRIEF_VERDICT, findings: [] })).toContain('affiliate-driven deployment service');
    const fromPlan = chairPivotText({ text: 'The plan is wrong.', findings: LIVE_PLAN_FINDINGS });
    expect(fromPlan).toContain('commercial compliance needs');
    expect(fromPlan).toContain('signed SBOM attestation');
    // The execution finding is a process change and belongs in the next plan, not on an idea card.
    expect(fromPlan).not.toContain('20-maintainer manual validation test');
    // A board that proposed nothing files nothing.
    expect(chairPivotText({ text: '**Brutal Verdict:** STRONG — the pain is real.', findings: [] })).toBe('');
  });

  it('files the SBOM pivot as a candidate card, once per session, and never plans against it', async () => {
    adoptFounderBrief(vault);
    keepIdea('altstack', 'AltStack: open-source SaaS alternatives');
    const transcript = 'Meetings/2026-09-13-1826-board-plan.md';
    const slug = fileChairPivot(vault, { text: LIVE_BRIEF_VERDICT, findings: LIVE_PLAN_FINDINGS, subject: "this cycle's plan", transcript, by: 'advisor_investor', now: new Date() })!;

    const card = readIdea(vault, slug)!;
    expect(card.data.source).toBe(BOARD_IDEA_SOURCE);
    expect(card.data.decision).toBe('undecided');
    expect(card.data.evidence).toEqual([transcript]);
    // The same session read a second time files no second card.
    expect(fileChairPivot(vault, { text: LIVE_BRIEF_VERDICT, findings: [], subject: "this cycle's plan", transcript, by: 'advisor_investor', now: new Date() })).toBe(slug);
    expect(listIdeas(vault).filter((c) => c.source === BOARD_IDEA_SOURCE)).toHaveLength(1);

    // …and a plan that tries to serve it anyway is returned: the plan waits for the owner to keep it.
    writePlan(`# Plan\n\n## Objectives\n\n### revenue\n- Sell signed SBOM attestations to compliance partners. idea: ${slug}\n`);
    const hbId = createHeartbeatJob(vault, 'test');
    parkAt(hbId, 'board_premortem');
    const out = await runHeartbeat({ vault, llm: mute, env: {}, now: () => new Date() }, hbId);

    expect(out.status).toBe('requeued');
    expect(String((vetoed()[0].payload.findings as string[]).join(' '))).toContain('has not ruled on');
    expect(listJobs(vault).filter((j) => j.type === 'board.premortem')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------
// W3-6: a status question is answered from the vault
// ---------------------------------------------------------------------------------------------------------

describe('W3-6: "WhAtS hppening rn?"', () => {
  it('is read as a status question, typo and all — and an instruction with a question mark is not', () => {
    expect(isStatusQuestion('WhAtS hppening rn?')).toBe(true);
    expect(isStatusQuestion("what's happening")).toBe(true);
    expect(isStatusQuestion('status')).toBe(true);
    expect(isStatusQuestion('where are we with the site?')).toBe(true);
    expect(isStatusQuestion('update?')).toBe(true);
    // Work, however it is punctuated.
    expect(isStatusQuestion('can you change the name?')).toBe(false);
    expect(isStatusQuestion('build the landing page')).toBe(false);
    expect(isStatusQuestion('')).toBe(false);
  });

  it('gathers the brief\'s verdict, the kept ideas, the objectives, the jobs and what needs the owner', () => {
    adoptFounderBrief(vault, ALTSTACK_BRIEF);
    keepIdea('altstack', 'AltStack: open-source SaaS alternatives');
    writePlan(ALTSTACK_PLAN);
    createProposal(vault, { kind: 'spend', from: 'cfo', target: 'Money/ledger.md', title: 'Pay for the domain', body: '# Pay for the domain\n\nUSD 12 a year.\n' }, 'cfo');
    const stuck = createJob(vault, { type: 'engineer.ship', title: 'Scaffold the site', assigned: 'backend_engineer', priority: 3, goal: 'g', team: 'dev' }, 'cto');
    updateJob(vault, stuck, { status: 'blocked', blocked_on: { kind: 'owner', id: stuck, since: new Date().toISOString() } }, 'cto');

    const facts = statusFacts(vault, new Date()).join('\n');
    expect(facts).toContain('Founder brief: adopted');
    expect(facts).toContain('PIVOT REQUIRED');
    expect(facts).toContain('AltStack');
    expect(facts).toContain('Publish 20 alternative pages');
    expect(facts).toContain('Scaffold the site');
    expect(facts).toContain('Pay for the domain');
  });

  it('answers from those facts and never asks the owner to say "go"', async () => {
    adoptFounderBrief(vault, ALTSTACK_BRIEF);
    keepIdea('altstack', 'AltStack: open-source SaaS alternatives');
    writePlan(ALTSTACK_PLAN);
    // An interview still open: the reply must not carry its line, because the owner asked a question.
    vault.writeText(INTERVIEW_PATH, renderInterviewAsked('2026-09-13T17:46:00.000Z'), 'daemon');
    vault.updateNote('Brand/name.md', (n) => ({ data: { ...n.data, name: 'AltStack' }, body: n.body }), 'owner');
    const rel = '00 Inbox/2026-09-13-msg-7bfdcb.md';
    vault.writeText(rel, '---\nid: msg_7bfdcb\nkind: message\nfrom: owner\nto: ceo\ncreated: 2026-09-13T14:19:06.383Z\n---\n# WhAtS hppening rn?\n\nWhAtS hppening rn?\n', 'owner');
    const llm = scriptedLlm();   // echoes the facts it was handed, so the reply is the facts

    expect(await answerOwnerMessages({ vault, llm }, vault, unansweredOwnerMessages(vault), { jobId: 'job_test' })).toBe(1);

    const reply = (vault.readNoteOrNull(rel)!.body.split(/^## CEO\s*$/m)[1] ?? '').trim();
    expect(reply).toContain('Founder brief: adopted');
    expect(reply).toContain('Publish 20 alternative pages');
    expect(reply).toContain('AltStack');
    expect(reply).toContain('five lines at most');       // the one rule it was given
    expect(reply).not.toContain('just "go"');
    expect(reply).not.toContain('correct me');
    // One call, and the interview was not touched: a question leaves it open (ruling FR-6).
    expect(llm.prompts).toHaveLength(1);
    expect(interviewPhase(vault.readTextOrNull(INTERVIEW_PATH))).toBe('asked');
  });
});

// ---------------------------------------------------------------------------------------------------------
// W3-7: adopting the brief closes the interview
// ---------------------------------------------------------------------------------------------------------

describe('W3-7: the interview closes when the brief is adopted', () => {
  const deps = () => ({ vault, registry: new ToolRegistry(), toolsConfig: parseToolsConfig('tools: {}\n'), scheduler: { enqueue: () => 'job_x' }, env: {} as NodeJS.ProcessEnv });
  const ownerEdit = (rel: string, f: (t: string) => string) => writeFileSync(path.join(dir, rel), f(readFileSync(path.join(dir, rel), 'utf8')));
  const BRIEF = ALTSTACK_BRIEF;

  it('stamps the transcript as superseded on the same pass that writes the brief', async () => {
    vault.writeText(INTERVIEW_PATH, renderInterviewAsked('2026-09-13T17:46:00.000Z'), 'daemon');
    const { path: rel } = createProposal(vault, { kind: 'founder_brief', from: 'research_manager', target: FOUNDER_BRIEF, title: 'What I understood', body: `## Proposed content\n\n\`\`\`\n${BRIEF}\n\`\`\`` }, 'research_manager');
    ownerEdit(rel, (t) => t.replace('approved: null', 'approved: true'));

    expect(await dispatchProposals(deps())).toBeGreaterThan(0);

    expect(hasFounderBrief(vault)).toBe(true);
    const transcript = vault.readTextOrNull(INTERVIEW_PATH)!;
    expect(transcript).toContain('## Superseded');
    expect(transcript).toContain('this interview is closed');
    expect(interviewPhase(transcript)).toBe('superseded');
  });

  it('and the CEO stops asking the owner to add to it', async () => {
    vault.writeText(INTERVIEW_PATH, renderInterviewAsked('2026-09-13T17:46:00.000Z'), 'daemon');
    const { path: rel } = createProposal(vault, { kind: 'founder_brief', from: 'research_manager', target: FOUNDER_BRIEF, title: 'What I understood', body: `## Proposed content\n\n\`\`\`\n${BRIEF}\n\`\`\`` }, 'research_manager');
    ownerEdit(rel, (t) => t.replace('approved: null', 'approved: true'));
    await dispatchProposals(deps());
    vault.updateNote('Brand/name.md', (n) => ({ data: { ...n.data, name: 'AltStack' }, body: n.body }), 'owner');

    // An ordinary instruction, so this is the general reply — the one that used to carry the line.
    const msg = '00 Inbox/2026-09-13-msg-later.md';
    vault.writeText(msg, '---\nid: msg_later\nkind: message\nfrom: owner\nto: ceo\ncreated: 2026-09-13T19:49:00.000Z\n---\n# Use Hetzner\n\nUse Hetzner for the hosting referrals please.\n', 'owner');
    const llm = scriptedLlm();

    await answerOwnerMessages({ vault, llm }, vault, unansweredOwnerMessages(vault), { jobId: 'job_test' });

    expect(llm.prompts[0]).not.toContain('still with them');
    expect(llm.prompts[0]).not.toContain('just "go"');
  });
});
