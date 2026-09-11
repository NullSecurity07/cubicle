import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, createJob, readJob, listJobs, listInbox, findInboxById, updateJob } from '@cubicle/core';
import type { RoutedChatResult, RouteRequest, ChatMessage, ToolSchema } from '@cubicle/router';
import { parseToolsConfig, ToolRegistry, phase3Tools, constitutionGuardrail } from '@cubicle/tools';
import { runJob, vaultScheduler, MemoryIndex, hashEmbed, loadObservations, type Llm } from '../src/index.js';

const cfg = parseToolsConfig(readFileSync(path.resolve(__dirname, '../../../config/tools.yaml'), 'utf8'));
let dir: string; let vault: Vault;
beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-harness-')); vault = (await scaffoldVault(dir)).vault; });
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

type Step = { tool: string; args: Record<string, unknown> } | { text: string } | { badJson: true };

/** Scripted LLM: returns the next scripted step regardless of context; records prompts for assertions. */
function scripted(steps: Step[]): Llm & { calls: number; prompts: ChatMessage[][]; throwAtCall?: number } {
  let i = 0;
  const llm = {
    calls: 0, prompts: [] as ChatMessage[][], throwAtCall: undefined as number | undefined,
    async chat(_req: RouteRequest, chat: { messages: ChatMessage[]; tools?: ToolSchema[] }): Promise<RoutedChatResult> {
      llm.calls++;
      llm.prompts.push(chat.messages);
      if (llm.throwAtCall !== undefined && llm.calls === llm.throwAtCall) throw new Error('kill -9 simulated');
      const s = steps[Math.min(i++, steps.length - 1)];
      const base = { content: '', toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 10, completion_tokens: 2 }, provider: 'fake', model: 'fake', tier: 'medium' as const, downgraded: false, parsedToolCalls: [] as { name: string; args: Record<string, unknown> }[] };
      if ('badJson' in s) return { ...base, jsonParseError: 'not json' };
      if ('text' in s) return { ...base, content: s.text };
      return { ...base, parsedToolCalls: [{ name: s.tool, args: s.args }] };
    },
    promptBudget: () => 6000,
  };
  return llm;
}

function deps(llm: Llm, extra: Partial<Parameters<typeof runJob>[0]> = {}) {
  const registry = new ToolRegistry().registerAll(phase3Tools({ includeMock: true }));
  return { vault, llm, toolsConfig: cfg, registry, scheduler: vaultScheduler(vault), env: {}, ...extra };
}

function growthWithMock() {
  // give the head of growth the mock outbound tool for tests
  vault.updateNote('Roles/cmo.md', (n) => ({ data: { ...n.data, tools: [...(n.data.tools as string[]), 'mock.outbound'], approval_overrides: {} }, body: n.body }), 'owner');
}

const fourStep: Step[] = [
  { tool: 'vault.read', args: { path: 'Plans/plan.md' } },
  { tool: 'mock.outbound', args: { to: 'a@x.com', body: 'hello' } },
  { tool: 'mock.outbound', args: { to: 'b@x.com', body: 'hello' } },
  { tool: 'finish', args: { status: 'done', summary: 'sent two', artifacts: [], metrics: { sent: 2 } } },
];

describe('runJob checkpointing and resume', () => {
  it('runs a 4-step job, records idempotency keys, writes the Result, enqueues coo.verify (review gate)', async () => {
    growthWithMock();
    const id = createJob(vault, { type: 'growth.outreach', title: 'outreach', assigned: 'cmo', goal: 'send' }, 'cto');
    const out = await runJob(deps(scripted(fourStep)), id);
    expect(out.status).toBe('done');
    const j = readJob(vault, id)!;
    expect(j.data.status).toBe('in_review');
    expect(j.data.checkpoint_step).toBe(4);
    expect(j.data.side_effects_done).toEqual([`${id}:1:2`, `${id}:1:3`]);
    expect(j.body).toContain('"sent": 2');
    expect(j.body).toContain('- step 1: vault.read');
    const keys = readFileSync(path.join(dir, '.cubicle/mock-outbound.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).key);
    expect(keys).toEqual([`${id}:1:2`, `${id}:1:3`]);
    const coo = listJobs(vault, { assigned: 'coo' });
    expect(coo.map((x) => x.type)).toEqual(['coo.verify']);
    expect(vault.events.count('agent.tool_call')).toBe(4);
    await runJob(deps(scripted([{ tool: 'finish', args: { status: 'done', summary: 'verified', verdict: 'pass', lessons: ['ok'] } }])), coo[0].id);
    expect(readJob(vault, id)!.data.status).toBe('done');
    expect(vault.events.count('review.passed')).toBe(1);
  });

  it('kill after step 2 → resume at step 3 with no duplicate side effects (acceptance test 1, harness half)', async () => {
    growthWithMock();
    const id = createJob(vault, { type: 'growth.outreach', title: 'outreach', assigned: 'cmo', goal: 'send' }, 'cto');
    const llm = scripted(fourStep);
    llm.throwAtCall = 3; // dies while asking the model for step 3, after step 2 was checkpointed
    await expect(runJob(deps(llm), id)).rejects.toThrow(/kill -9/);
    let j = readJob(vault, id)!;
    expect(j.data.status).toBe('running');
    expect(j.data.checkpoint_step).toBe(2);
    expect(j.data.side_effects_done).toEqual([`${id}:1:2`]);
    // restart: a fresh scripted model that would re-issue steps 2..4 from where the transcript left off
    const llm2 = scripted(fourStep.slice(2));
    const out = await runJob(deps(llm2), id);
    expect(out.status).toBe('done');
    j = readJob(vault, id)!;
    expect(j.data.checkpoint_step).toBe(4);
    const keys = readFileSync(path.join(dir, '.cubicle/mock-outbound.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).key);
    expect(keys).toEqual([`${id}:1:2`, `${id}:1:3`]);
    expect(new Set(keys).size).toBe(2);
    // the resumed prompt carried the earlier observations
    expect(JSON.stringify(llm2.prompts[0])).toContain('resuming at step 2');
    expect(loadObservations(vault, id).length).toBeGreaterThanOrEqual(4);
  });

  it('a model that repeats an already-done outbound step is skipped by idempotency key', async () => {
    growthWithMock();
    const id = createJob(vault, { type: 'growth.outreach', title: 'outreach', assigned: 'cmo', goal: 'send' }, 'cto');
    const llm = scripted(fourStep);
    llm.throwAtCall = 3;
    await expect(runJob(deps(llm), id)).rejects.toThrow();
    // Simulate a model that, on resume, re-issues step 2's call first (same step index → same key)
    updateJob(vault, id, { checkpoint_step: 1 }, 'daemon'); // pretend the note lagged one step behind the side effect
    const out = await runJob(deps(scripted(fourStep.slice(1))), id);
    expect(out.status).toBe('done');
    const keys = readFileSync(path.join(dir, '.cubicle/mock-outbound.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).key);
    expect(keys).toEqual([`${id}:1:2`, `${id}:1:3`]);
  });

  it('owner cancels a running job → stops before the next tool call', async () => {
    const id = createJob(vault, { type: 'research', title: 'r', assigned: 'cmo', goal: 'g' }, 'cto');
    const steps: Step[] = [{ tool: 'vault.read', args: { path: 'Plans/plan.md' } }, { tool: 'vault.read', args: { path: 'Plans/plan.md' } }, { tool: 'finish', args: { status: 'done', summary: 'x' } }];
    const llm = scripted(steps);
    const origChat = llm.chat.bind(llm);
    llm.chat = async (r, c) => { if (llm.calls === 1) updateJob(vault, id, { status: 'cancelled' }, 'owner'); return origChat(r, c); };
    const out = await runJob(deps(llm), id);
    expect(out.status).toBe('cancelled');
    expect(readJob(vault, id)!.data.checkpoint_step).toBe(1);
    expect(vault.events.count('job.cancelled')).toBe(1);
  });
});

describe('approval modes in the loop', () => {
  it('ask → blocks with an outbound_batch proposal; approved:true → resumes and executes once', async () => {
    growthWithMock();
    const strict = parseToolsConfig(readFileSync(path.resolve(__dirname, '../../../config/tools.yaml'), 'utf8').replace('mock.outbound:         { mode: auto', 'mock.outbound:         { mode: ask'));
    const id = createJob(vault, { type: 'growth.outreach', title: 'outreach', assigned: 'cmo', goal: 'send' }, 'cto');
    const out = await runJob(deps(scripted(fourStep), { toolsConfig: strict }), id);
    expect(out.status).toBe('blocked');
    const j = readJob(vault, id)!;
    expect(j.data.status).toBe('blocked');
    expect(j.data.approval).toBe('pending');
    expect(j.data.blocked_on?.kind).toBe('proposal');
    const prop = findInboxById(vault, j.data.blocked_on!.id)!;
    expect(prop.data.kind).toBe('outbound_batch');
    expect(prop.data.call?.tool).toBe('mock.outbound');
    expect(prop.data.call?.idempotency_key).toBe(`${id}:1:2`);
    expect(existsSync(path.join(dir, '.cubicle/mock-outbound.jsonl'))).toBe(false);
    // still blocked while unanswered
    expect((await runJob(deps(scripted(fourStep.slice(2)), { toolsConfig: strict }), id)).status).toBe('blocked');
    // owner approves in Obsidian
    vault.updateNote(prop.path, (n) => ({ data: { ...n.data, approved: true }, body: n.body }), 'owner');
    // second outbound call is also ask-mode → blocks again; approve it too, then finish
    const out2 = await runJob(deps(scripted(fourStep.slice(2)), { toolsConfig: strict }), id);
    expect(out2.status).toBe('blocked');
    const j2 = readJob(vault, id)!;
    const prop2 = findInboxById(vault, j2.data.blocked_on!.id)!;
    vault.updateNote(prop2.path, (n) => ({ data: { ...n.data, approved: true }, body: n.body }), 'owner');
    const out3 = await runJob(deps(scripted(fourStep.slice(3)), { toolsConfig: strict }), id);
    expect(out3.status).toBe('done');
    const keys = readFileSync(path.join(dir, '.cubicle/mock-outbound.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).key);
    expect(keys).toEqual([`${id}:1:2`, `${id}:1:3`]);
    expect(readJob(vault, id)!.data.side_effects_done).toEqual([`${id}:1:2`, `${id}:1:3`]);
  });

  it('an approval the owner has since revoked in the config is refused before the key is spent (M1)', async () => {
    growthWithMock();
    const strict = parseToolsConfig(readFileSync(path.resolve(__dirname, '../../../config/tools.yaml'), 'utf8').replace('mock.outbound:         { mode: auto', 'mock.outbound:         { mode: ask'));
    const id = createJob(vault, { type: 'growth.outreach', title: 'outreach', assigned: 'cmo', goal: 'send' }, 'cto');
    expect((await runJob(deps(scripted(fourStep), { toolsConfig: strict }), id)).status).toBe('blocked');
    const prop = findInboxById(vault, readJob(vault, id)!.data.blocked_on!.id)!;
    vault.updateNote(prop.path, (n) => ({ data: { ...n.data, approved: true }, body: n.body }), 'owner');

    // The owner approves, then changes their mind in Memory/owner_preferences.md while the job is still blocked.
    // The run started before that edit, so the preferences must be re-read here, not taken from the run's snapshot.
    vault.updateNote('Memory/owner_preferences.md', (n) => ({ data: n.data, body: n.body.replace('approvals: {}', 'approvals: { mock.outbound: never }') }), 'owner');

    const out = await runJob(deps(scripted(fourStep.slice(3)), { toolsConfig: strict }), id);
    expect(out.status).toBe('done'); // the step is spent, so the job carries on rather than blocking forever

    // Nothing was sent, and the key is unspent, so re-approving works if the mode is ever relaxed again.
    expect(existsSync(path.join(dir, '.cubicle/mock-outbound.jsonl'))).toBe(false);
    expect(readJob(vault, id)!.data.side_effects_done).toEqual([]);
    expect(readJob(vault, id)!.body).toContain('BLOCKED even though approved');
    expect(readJob(vault, id)!.body).not.toContain('ATTEMPTING');
    const blocked = vault.events.query({ types: ['guardrail.blocked'] });
    expect(blocked).toHaveLength(1);
    expect(String(blocked[0].payload.reason)).toMatch(/mode never/);
    expect(blocked[0].payload.approved).toBe(true);
    expect(blocked[0].payload.tool).toBe('mock.outbound');
  });

  it('ask → approved:false feeds a rejection and the job adapts', async () => {
    growthWithMock();
    const strict = parseToolsConfig(readFileSync(path.resolve(__dirname, '../../../config/tools.yaml'), 'utf8').replace('mock.outbound:         { mode: auto', 'mock.outbound:         { mode: ask'));
    const id = createJob(vault, { type: 'growth.outreach', title: 'outreach', assigned: 'cmo', goal: 'send' }, 'cto');
    await runJob(deps(scripted(fourStep), { toolsConfig: strict }), id);
    const j = readJob(vault, id)!;
    const prop = findInboxById(vault, j.data.blocked_on!.id)!;
    vault.updateNote(prop.path, (n) => ({ data: { ...n.data, approved: false }, body: n.body }), 'owner');
    const llm = scripted([{ tool: 'finish', args: { status: 'failed', summary: 'owner refused', blockers: ['refused'] } }]);
    const out = await runJob(deps(llm, { toolsConfig: strict }), id);
    expect(out.status).toBe('failed');
    expect(JSON.stringify(llm.prompts[0])).toContain('rejected by owner');
    expect(existsSync(path.join(dir, '.cubicle/mock-outbound.jsonl'))).toBe(false);
  });

  it('propose on an outbound tool stores the call and the job continues', async () => {
    growthWithMock();
    const prop = parseToolsConfig(readFileSync(path.resolve(__dirname, '../../../config/tools.yaml'), 'utf8').replace('mock.outbound:         { mode: auto, outbound: true, proposal_kind: outbound_batch', 'mock.outbound:         { mode: propose, outbound: true, proposal_kind: spend'));
    const id = createJob(vault, { type: 'growth.outreach', title: 'outreach', assigned: 'cmo', goal: 'send' }, 'cto');
    const out = await runJob(deps(scripted(fourStep), { toolsConfig: prop }), id);
    expect(out.status).toBe('done');
    const spends = listInbox(vault).filter((n) => n.data.kind === 'spend');
    expect(spends.length).toBe(2);
    expect(spends[0].data.call?.idempotency_key).toBe(`${id}:1:2`);
    expect(existsSync(path.join(dir, '.cubicle/mock-outbound.jsonl'))).toBe(false);
  });

  /**
   * Acceptance test 6, joined: the real constitution, the real guardrail and the real event in one run.
   * `packages/tools/test/phase5.test.ts` checks the reason string the guardrail returns; only here does a job
   * actually run into the cap, so the tool layer's refusal becomes the `guardrail.blocked` event the spec asks
   * for and the send that was over the cap leaves no side effect behind. (It lives in the harness package
   * because that is where `runJob` lives: `@cubicle/tools` cannot import it without a dependency cycle.)
   */
  it('an outbound call past max_emails_per_day is refused by the constitution and emits guardrail.blocked (acceptance test 6, joined)', async () => {
    growthWithMock();
    vault.updateNote('Memory/constitution.md', (n) => ({ data: n.data, body: n.body.replace('max_emails_per_day: 20', 'max_emails_per_day: 1') }), 'owner');
    expect(vault.constitution().max_emails_per_day).toBe(1);
    const id = createJob(vault, { type: 'growth.outreach', title: 'outreach', assigned: 'cmo', goal: 'send' }, 'cto');
    const out = await runJob(deps(scripted(fourStep), { guardrails: [constitutionGuardrail()] }), id);
    expect(out.status).toBe('done');
    // Step 2 is under the cap and sends; step 3 is over it, is blocked, and the job carries on to `finish`.
    const blocked = vault.events.query({ types: ['guardrail.blocked'] });
    expect(blocked).toHaveLength(1);
    expect(blocked[0].payload.tool).toBe('mock.outbound');
    expect(String(blocked[0].payload.reason)).toMatch(/max_emails_per_day/);
    expect(blocked[0].job).toBe(id);
    expect(blocked[0].agent).toBe('cmo');
    const sent = readFileSync(path.join(dir, '.cubicle/mock-outbound.jsonl'), 'utf8').trim().split('\n');
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]).key).toBe(`${id}:1:2`);
    expect(readJob(vault, id)!.body).toMatch(/step 3: mock\.outbound BLOCKED/);
  });

  it('question to a colleague blocks; an answer resumes', async () => {
    const id = createJob(vault, { type: 'custom', title: 'site', assigned: 'backend_engineer', goal: 'build' }, 'cto');
    const out = await runJob(deps(scripted([{ tool: 'colleague.message', args: { to: 'cto', body: 'framework?', kind: 'question' } }])), id);
    expect(out.status).toBe('blocked');
    const j = readJob(vault, id)!;
    expect(j.data.blocked_on?.kind).toBe('message');
    expect((await runJob(deps(scripted([])), id)).status).toBe('blocked');
    vault.appendText('Messages/backend_engineer.md', `\n## ${new Date().toISOString()} from cto (fyi) <!-- id:msg_x -->\n\nre:${j.data.blocked_on!.id} Use Astro.\n`, 'cto');
    const llm = scripted([{ tool: 'finish', args: { status: 'done', summary: 'ok' } }]);
    expect((await runJob(deps(llm), id)).status).toBe('done');
    expect(JSON.stringify(llm.prompts[0])).toContain('Use Astro');
  });

  it('invalid JSON three times → requeued, then failed on the last attempt; step limit → requeued with attempt+1', async () => {
    const id = createJob(vault, { type: 'research', title: 'r', assigned: 'cmo', goal: 'g', max_attempts: 2 }, 'cto');
    expect((await runJob(deps(scripted([{ badJson: true }])), id)).status).toBe('requeued');
    const out = await runJob(deps(scripted([{ badJson: true }])), id);
    expect(out.status).toBe('failed');
    const id2 = createJob(vault, { type: 'research', title: 'r2', assigned: 'cmo', goal: 'g' }, 'cto');
    const out2 = await runJob(deps(scripted([{ tool: 'vault.read', args: { path: 'Plans/plan.md' } }]), { maxSteps: 3 }), id2);
    expect(out2).toEqual({ status: 'requeued', attempt: 2 });
    expect(readJob(vault, id2)!.data.status).toBe('queued');
  });
});

describe('MemoryIndex', () => {
  it('indexes Skills/ and finds the deploy skill by meaning (hash embeddings)', async () => {
    vault.writeText('Skills/deploy-site.md', '---\nname: Deploy site\n---\n# Deploy site\n\nRun the build, then `wrangler pages deploy Site/dist` to publish to Cloudflare Pages.\n', 'backend_engineer');
    vault.writeText('Skills/write-cold-email.md', '---\nname: Cold email\n---\n# Cold email\n\nShort subject, one ask, unsubscribe footer.\n', 'cmo');
    const mem = new MemoryIndex(vault, hashEmbed());
    expect(await mem.indexAll()).toBeGreaterThanOrEqual(2);
    expect(await mem.indexAll()).toBe(0); // unchanged → skipped
    const hits = await mem.search('deploy wrangler pages', 2, ['Skills']);
    expect(hits[0].path).toBe('Skills/deploy-site.md');
    expect(mem.count()).toBeGreaterThan(0);
  });
});

describe('finish(blocked) means "waiting on the owner", not "a tool refused me" (live-run 2026-09-10)', () => {
  // Two live jobs sat in the brief's "needs you" list because the model answered a refused scheduler.request with
  // finish(status: blocked). Nothing the owner can decide unblocks "cto may not schedule cto"; the model just gave up.
  it('the first finish(blocked) with nothing pending is refused with guidance; a second one is accepted', async () => {
    const id = createJob(vault, { type: 'engineer.ship', title: 'ship', assigned: 'backend_engineer', goal: 'g' }, 'cto');
    const llm = scripted([
      { tool: 'finish', args: { status: 'blocked', summary: 'Cannot schedule self.', blockers: ['cto may not schedule cto'] } },
      { tool: 'finish', args: { status: 'blocked', summary: 'Still blocked: I need the owner to pick a palette.', blockers: ['no palette chosen'] } },
    ]);
    const out = await runJob(deps(llm), id);
    expect(llm.calls).toBe(2);
    expect(out.status).toBe('blocked');
    const j = readJob(vault, id)!;
    expect(j.data.status).toBe('blocked');
    expect(j.data.blocked_on?.kind).toBe('owner');
    const refusal = loadObservations(vault, id).find((o) => o.kind === 'tool' && o.tool === 'finish' && o.ok === false);
    expect(refusal).toBeTruthy();
    expect(refusal!.result).toMatch(/owner/);
    expect(refusal!.result).toMatch(/failed|another way/i);
    // The second call's prompt showed the refusal.
    expect(JSON.stringify(llm.prompts[1])).toContain('another way');
  });
});
