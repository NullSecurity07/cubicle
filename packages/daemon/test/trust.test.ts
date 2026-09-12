import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  scaffoldVault, Vault, createJob, createProposal, readJob, updateJob, cancelJob, listJobs, listInbox, findInboxById, loadOrg, loadGates, nowIso,
  recordTrustVerdict, trustState, trustJobId, TRUST_GATES, TRUST_PENDING_HOLD,
} from '@cubicle/core';
import { parseToolsConfig, ToolRegistry, phase3Tools, phase6Tools, type ToolPolicy } from '@cubicle/tools';
import { runJob, vaultScheduler, type HarnessDeps } from '@cubicle/harness';
import { sweepTrustReviews, dispatchProposals, requeueUnblocked, resetTrustWarnings } from '../src/index.js';
import { orgLlm } from '../../../scripts/lib/org-llm.js';

const root = path.resolve(__dirname, '../../..');
const cfg = parseToolsConfig(readFileSync(path.join(root, 'config/tools.yaml'), 'utf8'));
/**
 * `trust_review: true` in `config/tools.yaml` — and the `ToolPolicy` field that keeps it, without which zod
 * silently strips the key — belong to the tools task of this sub-project. Until that lands, a config parsed here
 * would flag no tool at all and this file would assert nothing; setting the flag is a no-op once the shipped
 * config carries it. The five tools are the ones that reach somebody outside the company (spec §2).
 */
for (const t of ['email.send', 'social.post', 'browser.submit', 'stripe.payment_link', 'deploy.site']) {
  cfg.tools[t] = { ...cfg.tools[t], trust_review: true } as ToolPolicy;
}
const gates = loadGates(path.join(root, 'config/gates.yaml'));
const EMAIL = { to: 'nursery@example.com', subject: 'A weekly box', body: 'We run a weekly box for nurseries.' };

let dir: string; let vault: Vault;
beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-d-trust-')); vault = (await scaffoldVault(dir)).vault; resetTrustWarnings(); });
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

/**
 * One scripted model and one registry for the whole life of a case.
 *
 * The model counts steps per job, so a fresh one would answer a *resumed* outreach job at step 0 and file a
 * second call instead of finishing — which is the whole thing these tests are here to watch.
 */
function scene(verdict: 'pass' | 'return') {
  const registry = new ToolRegistry().registerAll([...phase3Tools({ includeMock: true }), ...phase6Tools()]);
  const h: HarnessDeps = { vault, llm: orgLlm({ trustVerdict: verdict, outboundEmail: EMAIL }), toolsConfig: cfg, registry, scheduler: vaultScheduler(vault), env: {} };
  return { h, dispatch: () => dispatchProposals({ vault, registry, toolsConfig: cfg, scheduler: h.scheduler, env: {} }) };
}
const sweep = () => sweepTrustReviews({ vault, toolsConfig: cfg, gates });
const sent = () => vault.events.count('email.sent');

/**
 * The owner's approval is a *raw* file edit. The dispatcher acts on the flag only when `vault.isOwnerChanged`
 * says the owner set it, and every write through the vault API records a sha — including one that names `owner` —
 * so approving through `updateNote` would be read as the daemon's own writing and ignored (Decision 18).
 */
const approve = (rel: string, flag = 'true') => {
  const p = path.join(dir, rel);
  writeFileSync(p, readFileSync(p, 'utf8').replace(/^approved: .*$/m, `approved: ${flag}`));
};
/**
 * A held proposal is retried every ten minutes — `refuseNote` keeps the `refusals` row and `retryDue` re-admits
 * the note once it is stale. Back-date the row rather than deleting it: deleting it would test a path production
 * never takes, and the row is exactly what carries the owner's standing approval across the hold.
 */
const retryNow = (rel: string) => vault.db.prepare('UPDATE refusals SET at = ? WHERE path = ?').run(new Date(Date.now() - 11 * 60_000).toISOString(), rel);

/** The author files one email and blocks on the owner's approval; the sweep files the two reviews. */
async function fileAnEmail(h: HarnessDeps) {
  const job = createJob(vault, { type: 'growth.outreach', title: 'Email nurseries', assigned: 'cmo', goal: 'send one' }, 'cto');
  expect((await runJob(h, job)).status).toBe('blocked');
  const prop = findInboxById(vault, readJob(vault, job)!.data.blocked_on!.id)!;
  const reviews = sweep().reviews;
  expect(reviews).toHaveLength(2);
  return { job, prop, key: prop.data.call!.idempotency_key, reviews };
}

describe('a refused review never runs the action (spec §1, the first guarantee)', () => {
  it('the whole way through: filed, reviewed, returned, closed unsent, and the job told why', async () => {
    const { h, dispatch } = scene('return');
    const { job, prop, key, reviews } = await fileAnEmail(h);
    const org = loadOrg(vault);
    expect(reviews.map((r) => readJob(vault, r)!.data.assigned).sort()).toEqual([org.offices!.compliance, org.offices!.security].sort());
    expect(readJob(vault, reviews[0])!.body).toContain('nursery@example.com');

    // Both offices read the call. They return it.
    for (const r of reviews) expect((await runJob(h, r)).status).toBe('done');
    expect(trustState(vault.events, key).returned).toHaveLength(2);
    expect(sent()).toBe(0);

    // The sweep closes the call unsent, with the findings, whatever the owner has or has not done.
    expect(sweep().closed).toEqual([prop.data.id]);
    const closed = findInboxById(vault, prop.data.id)!;
    expect(closed.data.resolved_at).toBeTruthy();
    expect(closed.body).toContain('returned unsent by');
    expect(closed.body).toContain('**Nothing was sent.**');

    // The dispatcher has nothing left to resolve, and its own `requeueUnblocked` pass wakes the author: the
    // proposal is resolved even though the owner never approved it, and that clause is the difference between
    // telling the author why and leaving the job blocked for ever (Decision 19).
    expect(await dispatch()).toBeGreaterThan(0);
    expect(sent()).toBe(0);
    expect(readJob(vault, job)!.data.status).toBe('queued');
    expect(requeueUnblocked(vault)).toBe(0);   // woken once, not once per tick
    // It never sends: a returned call is finished as blocked, with the verdict in the job's log (Ruling Q1).
    expect((await runJob(h, job)).status).toBe('blocked');
    expect(sent()).toBe(0);
    expect(readJob(vault, job)!.data.side_effects_done).toEqual([]);
    expect(String(vault.events.query({ types: ['guardrail.blocked'] }).at(-1)!.payload.reason)).toContain('returned by');
  });

  it('the owner approving first changes nothing: a return still closes it unsent (Decision 5)', async () => {
    const { h, dispatch } = scene('return');
    const { prop, key, reviews } = await fileAnEmail(h);
    approve(prop.path);
    for (const r of reviews) await runJob(h, r);
    expect(sweep().closed).toEqual([prop.data.id]);
    expect(findInboxById(vault, prop.data.id)!.data.approved).toBe(true);   // the owner's decision is kept
    await dispatch();
    expect(sent()).toBe(0);
    expect(trustState(vault.events, key).passed).toEqual([]);
  });
});

describe('nothing is spent while the reviews are out (spec §3)', () => {
  it('an approved outbound call is held, once, with its key unspent — then sends on its own when both gates pass', async () => {
    const { h, dispatch } = scene('pass');
    const { job, prop, key } = await fileAnEmail(h);
    approve(prop.path);

    // The reviews are still out: the dispatcher holds the note and does not unblock the job.
    await dispatch();
    const held = findInboxById(vault, prop.data.id)!;
    expect(held.data.resolved_at).toBeNull();
    expect((held.data as { refused?: string }).refused).toBe(TRUST_PENDING_HOLD);
    expect(held.body).toContain('still reviewing this');
    expect(readJob(vault, job)!.data.status).toBe('blocked');
    expect(sent()).toBe(0);

    // Said once per episode, not once per tick — both while the ten-minute retry is not yet due, and on the
    // tick after it is, where the note is re-admitted and held again in silence.
    const before = vault.events.count('guardrail.blocked');
    await dispatch();
    retryNow(prop.path);
    await dispatch();
    expect(vault.events.count('guardrail.blocked')).toBe(before);
    expect(findInboxById(vault, prop.data.id)!.data.resolved_at).toBeNull();

    // Both gates pass, and it goes without a second approval.
    for (const gate of TRUST_GATES) recordTrustVerdict(vault, { key, proposal: prop.data.id, gate, verdict: 'pass', by: 'daemon' });
    expect(sweep().closed).toEqual([]);
    retryNow(prop.path);
    await dispatch();
    const released = findInboxById(vault, prop.data.id)!;
    expect(released.data.resolved_at).toBeTruthy();
    // The footer says which decision released it: the owner's approval was only half of it.
    expect(released.body).toContain('cleared by the compliance and security offices');
    expect((await runJob(h, job)).status).toBe('done');
    expect(sent()).toBe(1);
    expect(readJob(vault, job)!.data.side_effects_done).toEqual([key]);
  });

  it('a return that lands between the sweep and the dispatch is never footed as approved', async () => {
    const { h, dispatch } = scene('pass');
    const { job, prop, key } = await fileAnEmail(h);
    approve(prop.path);
    await dispatch();                       // held: the reviews are out

    // The race the sweep normally wins: a verdict lands after this tick's sweep has already run. The dispatcher
    // must not resolve the note — "approved; the waiting job resumes" is the one sentence that is not true of a
    // call an office refused, and on a `spend` resolving it would burn the key for a refusal too.
    recordTrustVerdict(vault, { key, proposal: prop.data.id, gate: TRUST_GATES[0], verdict: 'return', findings: ['the body has no unsubscribe line'], by: 'clo' });
    retryNow(prop.path);
    await dispatch();
    const raced = findInboxById(vault, prop.data.id)!;
    expect(raced.data.resolved_at).toBeNull();
    expect(raced.body).not.toContain('the waiting job resumes');
    expect(sent()).toBe(0);

    // The next sweep — seconds away, and always ahead of the dispatcher — writes the footer that says so.
    expect(sweep().closed).toEqual([prop.data.id]);
    const closed = findInboxById(vault, prop.data.id)!;
    expect(closed.body).toContain(`returned unsent by ${TRUST_GATES[0]}`);
    expect(closed.body).toContain('**Nothing was sent.**');
    // The author resumes and is told. Its proposal *was* approved, so the harness lets it carry on and file a
    // fresh call rather than finishing it blocked — the asymmetry Ruling Q1 draws: only a call the owner never
    // answered ends the job, because that job has nothing else to wait for.
    await dispatch();
    expect((await runJob(h, job)).status).toBe('done');
    expect(sent()).toBe(0);
    expect(readJob(vault, job)!.data.side_effects_done).toEqual([]);
    expect(String(vault.events.query({ types: ['guardrail.blocked'] }).at(-1)!.payload.reason)).toContain('returned by');
  });

  it("the offices' own verdicts release the call: two passes through the review jobs and it sends", async () => {
    const { h, dispatch } = scene('pass');
    const { job, prop, key, reviews } = await fileAnEmail(h);
    approve(prop.path);
    await dispatch();
    expect((findInboxById(vault, prop.data.id)!.data as { refused?: string }).refused).toBe(TRUST_PENDING_HOLD);
    for (const r of reviews) expect((await runJob(h, r)).status).toBe('done');
    expect(trustState(vault.events, key).passed).toHaveLength(2);
    expect(sweep().closed).toEqual([]);
    retryNow(prop.path);
    await dispatch();
    expect(findInboxById(vault, prop.data.id)!.data.resolved_at).toBeTruthy();
    expect((await runJob(h, job)).status).toBe('done');
    expect(sent()).toBe(1);
  });

  it('an approved `spend` whose reviews are out is held, and executes when they pass', async () => {
    const { dispatch } = scene('pass');
    const job = createJob(vault, { type: 'engineer.ship', title: 'Go live', assigned: 'platform_engineer', goal: 'deploy', stream: 'site' }, 'cto');
    const key = `${job}:1:4`;
    const p = createProposal(vault, {
      kind: 'spend', from: 'platform_engineer', job, title: 'deploy live', body: 'x',
      call: { tool: 'deploy.site', args: { stage: 'live', metrics: ['error rate'] }, idempotency_key: key, job, role: 'platform_engineer' },
    }, 'platform_engineer');
    expect(sweep().reviews).toHaveLength(2);
    const rel = findInboxById(vault, p.id)!.path;
    approve(rel);
    await dispatch();
    expect((findInboxById(vault, p.id)!.data as { refused?: string }).refused).toBe(TRUST_PENDING_HOLD);
    expect(vault.events.count('deploy.done')).toBe(0);
    expect(readJob(vault, job)!.data.side_effects_done).toEqual([]);   // held before the key was marked
    for (const gate of TRUST_GATES) recordTrustVerdict(vault, { key, proposal: p.id, gate, verdict: 'pass', by: 'daemon' });
    retryNow(rel);
    await dispatch();
    expect(findInboxById(vault, p.id)!.data.resolved_at).toBeTruthy();
  });

  it('a proposal with no leaving call is dispatched exactly as it always was', async () => {
    const { dispatch } = scene('pass');
    vault.updateNote('Roles/cmo.md', (n) => ({ data: { ...n.data, tools: [...(n.data.tools as string[]), 'mock.outbound'] }, body: n.body }), 'owner');
    const job = createJob(vault, { type: 'growth.outreach', title: 'outreach', assigned: 'cmo', goal: 'send' }, 'cto');
    const p = createProposal(vault, { kind: 'outbound_batch', from: 'cmo', job, title: 'send one', body: 'x', call: { tool: 'mock.outbound', args: { to: 'a@x', body: 'hi' }, idempotency_key: `${job}:1:1`, job, role: 'cmo' } }, 'cmo');
    expect(sweep().reviews).toEqual([]);
    approve(findInboxById(vault, p.id)!.path);
    await dispatch();
    expect(findInboxById(vault, p.id)!.data.resolved_at).toBeTruthy();
    expect((findInboxById(vault, p.id)!.data as { refused?: string }).refused).toBeUndefined();
  });

  it('a call the owner has already turned down owes no reviews (Ruling Q14)', async () => {
    const { h } = scene('pass');
    const { prop } = await fileAnEmail(h);
    // A second proposal, refused by the owner before either office got to it: nothing leaves the company either
    // way, so filing two review jobs would only spend two model calls on a call that can never run.
    const job = createJob(vault, { type: 'growth.outreach', title: 'outreach again', assigned: 'cmo', goal: 'send' }, 'cto');
    const p = createProposal(vault, { kind: 'outbound_batch', from: 'cmo', job, title: 'send', body: 'x', call: { tool: 'email.send', args: EMAIL, idempotency_key: `${job}:1:1`, job, role: 'cmo' } }, 'cmo');
    approve(findInboxById(vault, p.id)!.path, 'false');
    expect(sweep()).toEqual({ reviews: [], closed: [] });
    expect(listJobs(vault).filter((j) => j.type.endsWith('.review'))).toHaveLength(2);   // the first call's two, and no more
    expect(listInbox(vault).find((n) => n.data.id === prop.data.id)!.data.resolved_at).toBeNull();
  });

  // C1: the reviews are still out when the owner says no. Before this, `trustHeld` answered `hold` for the closed
  // note too — the sweep skips a resolved note, so its gates can never move again — and the author sat blocked on
  // a proposal nobody would ever touch, in no "What needs you" row and with no warning anywhere.
  it('the owner rejecting a call whose reviews are still out never strands its author (C1)', async () => {
    const { h, dispatch } = scene('pass');
    const { job, prop, key, reviews } = await fileAnEmail(h);
    approve(prop.path, 'false');

    // One pass: the note is closed rejected, and the same pass wakes the author.
    expect(await dispatch()).toBeGreaterThan(0);
    const closed = findInboxById(vault, prop.data.id)!;
    expect(closed.data.resolved_at).toBeTruthy();
    expect(closed.body).toContain('rejected');
    expect(trustState(vault.events, key).pending).toHaveLength(2);   // neither office ever answered, and never will
    expect(readJob(vault, job)!.data.status).toBe('queued');
    expect(requeueUnblocked(vault)).toBe(0);                          // woken once, not once per tick

    // The two reviews are dropped rather than run: a rejected send cannot leave the company whatever they say.
    for (const r of reviews) expect(readJob(vault, r)!.data.status).toBe('cancelled');

    // The author resumes, is told the owner refused, and sends nothing.
    expect((await runJob(h, job)).status).toBe('done');
    expect(sent()).toBe(0);
    expect(readJob(vault, job)!.data.side_effects_done).toEqual([]);
    expect(readJob(vault, job)!.data.approval).toBe('rejected');
    expect(readJob(vault, job)!.body).toContain('rejected by owner');
    expect(readJob(vault, job)!.data.blocked_on).toBeUndefined();
  });

  it('a review ending without a verdict after the rejection cannot re-strand it (C1)', async () => {
    const { h, dispatch } = scene('pass');
    const { job, prop, key, reviews } = await fileAnEmail(h);
    // This one was already with its office when the owner answered, so it is not dropped with the other.
    updateJob(vault, reviews[1], { status: 'running' }, 'daemon');
    approve(prop.path, 'false');
    expect(await dispatch()).toBeGreaterThan(0);
    expect(readJob(vault, reviews[0])!.data.status).toBe('cancelled');
    expect(readJob(vault, reviews[1])!.data.status).toBe('running');

    // It then ends without ever recording a verdict. The sweep cannot help — it skips a resolved note, so that
    // gate is pending for ever — and before C1 this is where the author's job stayed blocked for the life of the
    // vault: `status: blocked`, both gates pending, and not one `daemon.warning` about it.
    updateJob(vault, reviews[1], { status: 'blocked', blocked_on: { kind: 'owner', id: reviews[1], since: nowIso() } }, 'daemon');
    for (let i = 0; i < 10; i++) { sweep(); await dispatch(); }
    expect(trustState(vault.events, key).pending).toHaveLength(2);
    expect(readJob(vault, job)!.data.status).toBe('queued');
    expect(listJobs(vault, { status: ['blocked'] }).filter((j) => j.blocked_on?.kind === 'proposal')).toEqual([]);

    // And the author finishes, told what the owner decided, with nothing sent.
    expect((await runJob(h, job)).status).toBe('done');
    expect(sent()).toBe(0);
    expect(readJob(vault, job)!.data.side_effects_done).toEqual([]);
  });
});

describe('the sweep files each review once, and fails closed loudly (spec §5)', () => {
  it('a second sweep files nothing, and a deterministic id survives a replay', async () => {
    const { h } = scene('pass');
    const { key } = await fileAnEmail(h);
    expect(sweep().reviews).toEqual([]);
    for (const gate of TRUST_GATES) expect(readJob(vault, trustJobId(key, gate))).not.toBeNull();
    expect(listJobs(vault).filter((j) => j.type.endsWith('.review'))).toHaveLength(2);
  });

  it("the reviewer is shown the exact call, and the model is shown the reviewer's goal", async () => {
    const { h } = scene('pass');
    const { reviews } = await fileAnEmail(h);
    // The scripted reviewer recognises a trust review by a phrase only `trustGateGoal` writes, and it reads that
    // phrase out of the assembled context rather than the note. Prove the context carries it: without this, a
    // summarised or truncated goal would turn every "return" case in this file into a silent pass.
    const seen: string[] = [];
    const spy: HarnessDeps = { ...h, llm: { ...h.llm, chat: async (req, chat) => { seen.push(String(chat.messages[1]?.content ?? '')); return h.llm.chat(req, chat); } } };
    expect((await runJob(spy, reviews[0])).status).toBe('done');
    expect(seen.join('\n')).toContain('before it leaves the company');
    expect(seen.join('\n')).toContain('nursery@example.com');
  });

  // `blocked` is a reviewer that finished by asking the owner something; `cancelled` is the owner closing the
  // review job. Neither ever records a verdict, and nothing requeues either.
  it.each(['blocked', 'cancelled'])('a review that ends %s without a verdict is a return, said out loud', async (status) => {
    const { h, dispatch } = scene('pass');
    const { job, prop, key, reviews } = await fileAnEmail(h);
    approve(prop.path);
    await dispatch();
    expect((findInboxById(vault, prop.data.id)!.data as { refused?: string }).refused).toBe(TRUST_PENDING_HOLD);

    // One office answers; the other's review ends without ever recording one. Before this, that gate stayed
    // pending for ever — the sweep will not re-file a review whose deterministic id already exists, so the
    // dispatcher held the call, `trustHeld` held the author's job, and nothing said why.
    expect((await runJob(h, reviews[0])).status).toBe('done');
    if (status === 'cancelled') cancelJob(vault, reviews[1], 'owner', 'the owner closed it');
    else updateJob(vault, reviews[1], { status: 'blocked', blocked_on: { kind: 'owner', id: reviews[1], since: nowIso() } }, 'daemon');

    expect(sweep().closed).toEqual([prop.data.id]);
    const st = trustState(vault.events, key);
    expect(st.passed).toHaveLength(1);
    expect(st.returned).toHaveLength(1);
    const closed = findInboxById(vault, prop.data.id)!;
    expect(closed.data.resolved_at).toBeTruthy();
    expect(closed.body).toContain(`ended ${status} without a verdict`);
    expect(closed.body).toContain('**Nothing was sent.**');

    const warns = () => vault.events.query({ types: ['daemon.warning'] }).filter((e) => e.payload.where === 'trust.review');
    expect(warns()).toHaveLength(1);
    expect(String(warns()[0].payload.message)).toContain('returned unsent rather than held for ever');
    expect(String(warns()[0].payload.job)).toBe(reviews[1]);
    sweep();
    expect(warns()).toHaveLength(1);      // once per office per proposal, not once per tick

    // The author is woken, told what the office never got round to saying, and sends nothing.
    expect(await dispatch()).toBeGreaterThan(0);
    await runJob(h, job);
    expect(sent()).toBe(0);
    expect(readJob(vault, job)!.data.side_effects_done).toEqual([]);
    expect(String(vault.events.query({ types: ['guardrail.blocked'] }).at(-1)!.payload.reason)).toContain('without a verdict');
  });

  it('a review still on its way is not mistaken for one that ended', async () => {
    const { h } = scene('pass');
    const { prop, key, reviews } = await fileAnEmail(h);
    // Blocked on something that will answer: a quota retry, a colleague's answer, the owner's approval of one of
    // the reviewer's own calls. `requeueUnblocked` and the harness resume wake all three, so the gate is still
    // pending, not returned — the hold is correct here and the call must not be closed.
    updateJob(vault, reviews[0], { status: 'blocked', blocked_on: { kind: 'quota', id: 'all-providers', since: nowIso() } }, 'daemon');
    updateJob(vault, reviews[1], { status: 'blocked', approval: 'pending', blocked_on: { kind: 'proposal', id: 'prop_x', since: nowIso() } }, 'daemon');
    expect(sweep()).toEqual({ reviews: [], closed: [] });
    expect(trustState(vault.events, key).returned).toEqual([]);
    expect(findInboxById(vault, prop.data.id)!.data.resolved_at).toBeNull();
    expect(vault.events.query({ types: ['daemon.warning'] }).filter((e) => e.payload.where === 'trust.review')).toEqual([]);
  });

  it('an office with nobody to run its review warns once and leaves the call refused for ever', async () => {
    const job = createJob(vault, { type: 'growth.outreach', title: 'outreach', assigned: 'cmo', goal: 'send' }, 'cto');
    const p = createProposal(vault, { kind: 'outbound_batch', from: 'cmo', job, title: 'send', body: 'x', call: { tool: 'email.send', args: EMAIL, idempotency_key: `${job}:1:1`, job, role: 'cmo' } }, 'cmo');
    for (const rel of vault.list('Roles', { ext: '.md' })) if (!rel.endsWith('/cmo.md')) vault.remove(rel, 'owner');
    vault.writeText('Memory/constitution.md', '```yaml\noffices:\n  compliance: cmo\n  security: cmo\n  chief_executive: cmo\n```\n', 'owner');
    expect(sweep()).toEqual({ reviews: [], closed: [] });
    const warns = () => vault.events.query({ types: ['daemon.warning'] }).filter((e) => e.payload.where === 'trust');
    expect(warns()).toHaveLength(2);
    expect(String(warns()[0].payload.message)).toContain('stays refused and nothing is sent');
    expect(String(warns()[0].payload.proposal)).toBe(p.id);
    sweep();
    expect(warns()).toHaveLength(2);      // once per office per proposal, not once per tick
    expect(sent()).toBe(0);
  });
});
