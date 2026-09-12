import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  scaffoldVault, Vault, createJob, readJob, listInbox, findInboxById,
  recordTrustVerdict, TRUST_GATES, trustState,
} from '@cubicle/core';
import type { RoutedChatResult, RouteRequest, ChatMessage, ToolSchema } from '@cubicle/router';
import { parseToolsConfig, ToolRegistry, phase3Tools, phase6Tools } from '@cubicle/tools';
import { runJob, vaultScheduler, type Llm, type HarnessDeps } from '../src/index.js';

const cfgText = readFileSync(path.resolve(__dirname, '../../../config/tools.yaml'), 'utf8');
const cfg = parseToolsConfig(cfgText);
// `trust_review` on the five tools that reach somebody is Task 3's: the flag in `config/tools.yaml` *and* the
// field on `ToolPolicy` (a zod object strips a key its schema does not declare, so the flag alone is invisible).
// The harness reads the field structurally, so it behaves the same either way; this loop is what lets the harness
// suite be green on its own branch, and is a no-op once Task 3's schema carries the key.
for (const tool of ['email.send', 'social.post', 'browser.submit', 'stripe.payment_link', 'deploy.site']) {
  const pol = cfg.tools[tool] as unknown as Record<string, unknown> | undefined;
  if (pol) pol.trust_review = true;
}
let dir: string; let vault: Vault;
beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-h-trust-')); vault = (await scaffoldVault(dir)).vault; });
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

type Step = { tool: string; args: Record<string, unknown> };
function scripted(steps: Step[]): Llm {
  let i = 0;
  return {
    async chat(_r: RouteRequest, _c: { messages: ChatMessage[]; tools?: ToolSchema[] }): Promise<RoutedChatResult> {
      const s = steps[Math.min(i++, steps.length - 1)];
      return { content: '', toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 5, completion_tokens: 1 }, provider: 'f', model: 'f', tier: 'medium', downgraded: false, parsedToolCalls: [{ name: s.tool, args: s.args }] };
    },
    promptBudget: () => 6000,
  };
}
const deps = (llm: Llm, extra: Partial<HarnessDeps> = {}): HarnessDeps => ({
  vault, llm, toolsConfig: cfg,
  registry: new ToolRegistry().registerAll([...phase3Tools(), ...phase6Tools()]),
  scheduler: vaultScheduler(vault), env: {}, ...extra,
});
const EMAIL = { to: 'nursery@example.com', subject: 'Hello', body: 'We run a weekly box for nurseries.' };
const send: Step = { tool: 'email.send', args: EMAIL };
const done: Step = { tool: 'finish', args: { status: 'done', summary: 'sent' } };
const clear = (key: string, proposal = 'prop_t') => { for (const gate of TRUST_GATES) recordTrustVerdict(vault, { key, proposal, gate, verdict: 'pass', by: 'daemon' }); };
const outreach = () => createJob(vault, { type: 'growth.outreach', title: 'Email nurseries', assigned: 'cmo', goal: 'send one' }, 'cto');

describe('a leaving call is filed, never made in the same breath (spec §3, Decision 6)', () => {
  it('`auto` is raised to `propose`: the call is filed, the job carries on, nothing is sent', async () => {
    vault.writeText('Memory/owner_preferences.md', '```yaml\napprovals:\n  email.send: auto\n```\n', 'owner');
    const id = outreach();
    const out = await runJob(deps(scripted([send, done])), id);
    expect(out.status).toBe('done');                          // the job was not refused mid-flight
    const props = listInbox(vault).filter((n) => n.data.call?.tool === 'email.send');
    expect(props).toHaveLength(1);
    expect(props[0].data.kind).toBe('outbound_batch');
    expect(props[0].body).toContain('office:compliance.review and office:security.review');
    expect(props[0].body).toContain('leaves the company');    // says why it is here even though the owner said auto
    expect(vault.events.count('email.sent')).toBe(0);
    expect(readJob(vault, id)!.data.side_effects_done).toEqual([]);
  });

  it('a proposal for a call that leaves names the two offices that will read it', async () => {
    const id = outreach();
    await runJob(deps(scripted([send, done])), id);           // email.send is `ask` by default → blocks
    const prop = findInboxById(vault, readJob(vault, id)!.data.blocked_on!.id)!;
    expect(prop.body).toContain('a return closes it unsent');
    expect(prop.body).not.toContain('You set');               // not raised: the owner never said auto
  });
});

describe('nothing is spent while the reviews are out (spec §3)', () => {
  it('an approved call whose reviews are pending stays blocked with its key unspent', async () => {
    const id = outreach();
    expect((await runJob(deps(scripted([send, done])), id)).status).toBe('blocked');
    const prop = findInboxById(vault, readJob(vault, id)!.data.blocked_on!.id)!;
    const key = prop.data.call!.idempotency_key;
    vault.updateNote(prop.path, (n) => ({ data: { ...n.data, approved: true }, body: n.body }), 'owner');

    // The owner approved before the offices finished (spec §9): the job is held, not sent.
    const held = await runJob(deps(scripted([done])), id);
    expect(held.status).toBe('blocked');
    expect(vault.events.count('email.sent')).toBe(0);
    expect(readJob(vault, id)!.data.side_effects_done).toEqual([]);
    expect(trustState(vault.events, key).pending).toHaveLength(2);

    // One office is not enough.
    recordTrustVerdict(vault, { key, proposal: prop.data.id, gate: 'office:compliance.review', verdict: 'pass', by: 'clo' });
    expect((await runJob(deps(scripted([done])), id)).status).toBe('blocked');
    expect(vault.events.count('email.sent')).toBe(0);

    // Both, and it goes — on the same key, ten minutes later.
    recordTrustVerdict(vault, { key, proposal: prop.data.id, gate: 'office:security.review', verdict: 'pass', by: 'ciso' });
    expect((await runJob(deps(scripted([done])), id)).status).toBe('done');
    expect(vault.events.count('email.sent')).toBe(1);
    expect(readJob(vault, id)!.data.side_effects_done).toEqual([key]);
  });

  it('a classifier that could not run leaves the job blocked and the key unspent, and the send goes out when it can', async () => {
    // The path an approved outbound call actually takes: the waiting job's own resume, not the dispatcher's
    // `spend` branch (re-review 1, CRITICAL). A guardrail that could not reach a model has refused nothing,
    // so recording "blocked even though approved" here would spend the owner's approval on a model outage.
    const { CLASSIFIER_UNAVAILABLE_PREFIX } = await import('@cubicle/tools');
    const outage = `${CLASSIFIER_UNAVAILABLE_PREFIX} (no answer in 20000 ms), so the call is refused rather than sent unchecked. Try it again once a model is answering.`;
    let down = true;
    const guardrails = [{ check: () => (down ? outage : null) }];

    const id = outreach();
    await runJob(deps(scripted([send, done])), id);
    const prop = findInboxById(vault, readJob(vault, id)!.data.blocked_on!.id)!;
    const key = prop.data.call!.idempotency_key;
    vault.updateNote(prop.path, (n) => ({ data: { ...n.data, approved: true }, body: n.body }), 'owner');
    clear(key, prop.data.id);   // both offices are happy; only the constitution check is missing

    const held = await runJob(deps(scripted([done]), { guardrails }), id);
    expect(held.status).toBe('blocked');
    expect(held.status === 'blocked' && held.on.id).toBe(prop.data.id);   // still waiting on the same proposal
    expect(vault.events.count('email.sent')).toBe(0);
    expect(readJob(vault, id)!.data.side_effects_done).toEqual([]);       // the key is not spent on a non-answer
    // A deferral, not a refusal: the job note and the event log must not say the call was turned down.
    expect(vault.events.count('guardrail.blocked')).toBe(0);
    expect(vault.events.count('guardrail.deferred')).toBe(1);
    expect(readJob(vault, id)!.body).toContain('waiting for the constitution guardrail');
    expect(readJob(vault, id)!.body).not.toContain('BLOCKED even though approved');

    // A model answers, and the next run sends it — on the same key, under the same approval.
    down = false;
    expect((await runJob(deps(scripted([done]), { guardrails }), id)).status).toBe('done');
    expect(vault.events.count('email.sent')).toBe(1);
    expect(readJob(vault, id)!.data.side_effects_done).toEqual([key]);
  });

  it('a returned review tells the job what the review said, and the job runs on unsent', async () => {
    const id = outreach();
    await runJob(deps(scripted([send, done])), id);
    const prop = findInboxById(vault, readJob(vault, id)!.data.blocked_on!.id)!;
    const key = prop.data.call!.idempotency_key;
    vault.updateNote(prop.path, (n) => ({ data: { ...n.data, approved: true }, body: n.body }), 'owner');
    recordTrustVerdict(vault, { key, proposal: prop.data.id, gate: 'office:compliance.review', verdict: 'return', findings: ['no unsubscribe link in the body'], by: 'clo' });

    const out = await runJob(deps(scripted([done])), id);
    expect(out.status).toBe('done');                          // the job is not stuck; it may file a fresh call
    expect(vault.events.count('email.sent')).toBe(0);
    expect(readJob(vault, id)!.data.side_effects_done).toEqual([]);   // the key is never spent on a refusal
    const blocked = vault.events.query({ types: ['guardrail.blocked'] }).at(-1)!;
    expect(String(blocked.payload.reason)).toContain('no unsubscribe link in the body');
    expect(readJob(vault, id)!.body).toContain('BLOCKED even though approved');
  });

  it('a call the offices returned while the owner was still deciding is closed unsent', async () => {
    const id = outreach();
    await runJob(deps(scripted([send, done])), id);
    const prop = findInboxById(vault, readJob(vault, id)!.data.blocked_on!.id)!;
    const key = prop.data.call!.idempotency_key;
    // No `approved` flip at all: the owner never answered, and a return outranks an approval on every path, so
    // waiting for one is waiting for something that cannot help. (Task 5's sweep closes the proposal note.)
    recordTrustVerdict(vault, { key, proposal: prop.data.id, gate: 'office:compliance.review', verdict: 'return', findings: ['the claim about 400 nurseries is not supported'], by: 'clo' });

    const out = await runJob(deps(scripted([done])), id);
    expect(out.status).toBe('blocked');
    expect(vault.events.count('email.sent')).toBe(0);
    expect(readJob(vault, id)!.data.side_effects_done).toEqual([]);
    const note = readJob(vault, id)!;
    expect(note.data.status).toBe('blocked');
    expect(note.data.blocked_on!.kind).toBe('owner');         // closed, not still waiting on the proposal
    expect(note.body).toContain('the claim about 400 nurseries is not supported');   // the verdict's own words
    const blocked = vault.events.query({ types: ['guardrail.blocked'] }).at(-1)!;
    expect(String(blocked.payload.reason)).toContain('the claim about 400 nurseries is not supported');
  });

  it('a held `deploy.site` burns no key and still goes live once, after clearance', async () => {
    // R17 meets the raise. A live deploy is on the record, so `first_time_only` relaxes `deploy.site` to `auto`
    // — and the trust raise runs *after* that relaxation, or an auto live deploy would spend its key on a call
    // the tool layer refuses, and no verdict landing later could ever send it.
    mkdirSync(path.join(dir, 'Site/dist'), { recursive: true });
    writeFileSync(path.join(dir, 'Site/dist/index.html'), '<h1>v1</h1>');
    vault.events.emit({ type: 'deploy.done', agent: 'daemon', payload: { url: 'https://acme.pages.dev', project: 'acme', mode: 'mock', stage: 'live' } });
    const deployJob = (title: string) => createJob(vault, { type: 'custom', title, assigned: 'platform_engineer', goal: 'deploy the site' }, 'cto');
    const live: Step = { tool: 'deploy.site', args: { stage: 'live', metrics: ['error rate'] } };

    // A preview and a canary of this build: internal steps of progressive delivery, so no review is owed and
    // both run on the spot (§20 requires them before a live deploy of the same build).
    const staging = deployJob('Stage it');
    expect((await runJob(deps(scripted([{ tool: 'deploy.site', args: { stage: 'preview' } }, { tool: 'deploy.site', args: { stage: 'canary', metrics: ['error rate'] } }, done])), staging)).status).toBe('done');
    expect(vault.events.count('deploy.done')).toBe(3);        // the hand-written one, plus preview and canary
    expect(listInbox(vault).filter((n) => n.data.call?.tool === 'deploy.site')).toHaveLength(0);

    // The live deploy would have run automatically. It leaves the company, so it is filed instead.
    const raised = deployJob('Go live');
    expect((await runJob(deps(scripted([live, done])), raised)).status).toBe('done');
    expect(vault.events.count('deploy.done')).toBe(3);        // nothing went out
    expect(readJob(vault, raised)!.data.side_effects_done).toEqual([]);   // and no key was spent on it
    const filed = listInbox(vault).find((n) => n.data.call?.tool === 'deploy.site')!;
    expect(filed.body).toContain('leaves the company');

    // The same call with the tool pinned to `ask`, which is the path the harness itself resumes.
    vault.writeText('Memory/owner_preferences.md', '```yaml\napprovals:\n  deploy.site: ask\n```\n', 'owner');
    const held = deployJob('Go live, please');
    expect((await runJob(deps(scripted([live, done])), held)).status).toBe('blocked');
    const prop = findInboxById(vault, readJob(vault, held)!.data.blocked_on!.id)!;
    const key = prop.data.call!.idempotency_key;
    vault.updateNote(prop.path, (n) => ({ data: { ...n.data, approved: true }, body: n.body }), 'owner');
    expect((await runJob(deps(scripted([done])), held)).status).toBe('blocked');
    expect(vault.events.count('deploy.done')).toBe(3);        // approved, reviews out: still nothing
    expect(readJob(vault, held)!.data.side_effects_done).toEqual([]);

    clear(key, prop.data.id);
    expect((await runJob(deps(scripted([done])), held)).status).toBe('done');
    expect(vault.events.count('deploy.done')).toBe(4);        // once, on the key that was reviewed
    expect(readJob(vault, held)!.data.side_effects_done).toEqual([key]);
  });
});

describe('a finished review is the record (spec §4, §9)', () => {
  const review = (extra: Record<string, unknown> = {}) => createJob(vault, {
    id: 'job_rev_1', type: 'office:compliance.review', title: 'Compliance review: email.send', assigned: 'clo',
    goal: 'Review the call below as the office:compliance.review gate before it leaves the company.',
    trust_key: 'job_out:1:3', trust_proposal: 'prop_out', ...extra,
  }, 'daemon');

  it('a pass is recorded against the call, keyed on it and on nothing else', async () => {
    const id = review();
    expect((await runJob(deps(scripted([{ tool: 'finish', args: { status: 'done', verdict: 'pass', summary: 'the claim checks out' } }])), id)).status).toBe('done');
    const st = trustState(vault.events, 'job_out:1:3');
    expect(st.passed).toEqual(['office:compliance.review']);
    const e = vault.events.query({ types: ['review.passed'] }).at(-1)!;
    expect(e.payload).toMatchObject({ gate: 'office:compliance.review', key: 'job_out:1:3', proposal: 'prop_out', trust: true });
    // The review gates a call, so it has no parent and never advanced anyone's gate chain.
    expect(readJob(vault, id)!.data.parent).toBeUndefined();
    expect(readJob(vault, id)!.data.status).toBe('done');
  });

  it('a return is recorded with its findings', async () => {
    const id = review();
    await runJob(deps(scripted([{ tool: 'finish', args: { status: 'done', verdict: 'return', findings: ['the body promises a refund we do not offer'], summary: 'returned' } }])), id);
    const st = trustState(vault.events, 'job_out:1:3');
    expect(st.returned).toEqual(['office:compliance.review']);
    expect(st.findings).toEqual(['the body promises a refund we do not offer']);
  });

  it('a review that ran out of steps is a return, not a pass (Decision 14)', async () => {
    const id = review({ max_attempts: 1 });
    const out = await runJob(deps(scripted([{ tool: 'vault.read', args: { path: 'Plans/plan.md' } }]), { maxSteps: 2 }), id);
    expect(out.status).toBe('failed');
    const st = trustState(vault.events, 'job_out:1:3');
    expect(st.returned).toEqual(['office:compliance.review']);
    expect(st.passed).toEqual([]);
    expect(st.findings.join(' ')).toMatch(/step_limit/);
  });

  it('an ordinary job finishing done records nothing at all', async () => {
    const id = createJob(vault, { type: 'custom', title: 'x', assigned: 'cmo', goal: 'g' }, 'cto');
    await runJob(deps(scripted([done])), id);
    expect(vault.events.query({ types: ['review.passed', 'review.returned'] })).toEqual([]);
  });
});
