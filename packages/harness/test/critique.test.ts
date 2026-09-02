import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, createJob, readJob, updateJob } from '@cubicle/core';
import type { RoutedChatResult, RouteRequest, ChatMessage, ToolSchema } from '@cubicle/router';
import { parseToolsConfig, ToolRegistry, phase3Tools, defineTool } from '@cubicle/tools';
import { z } from 'zod';
import { runJob, vaultScheduler, loadObservations, type Llm } from '../src/index.js';

const cfgText = readFileSync(path.resolve(__dirname, '../../../config/tools.yaml'), 'utf8');
const cfg = parseToolsConfig(cfgText.replace('mock.outbound:         { mode: auto, outbound: true, proposal_kind: outbound_batch }', 'mock.outbound:         { mode: auto, outbound: true, proposal_kind: outbound_batch }\n  mock.crash:            { mode: auto, outbound: true, proposal_kind: outbound_batch }'));
let dir: string; let vault: Vault;
beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-crit-')); vault = (await scaffoldVault(dir)).vault; });
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

type Step = { tool: string; args: Record<string, unknown> };
function scripted(steps: Step[]): Llm & { prompts: ChatMessage[][] } {
  let i = 0;
  const llm = {
    prompts: [] as ChatMessage[][],
    async chat(_r: RouteRequest, chat: { messages: ChatMessage[]; tools?: ToolSchema[] }): Promise<RoutedChatResult> {
      llm.prompts.push(chat.messages);
      const s = steps[Math.min(i++, steps.length - 1)];
      return { content: '', toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 }, provider: 'f', model: 'f', tier: 'medium', downgraded: false, parsedToolCalls: [{ name: s.tool, args: s.args }] };
    },
    promptBudget: () => 6000,
  };
  return llm;
}

/** Outbound tool that appends its key and then throws — simulates a crash after the external request went out. */
const mockCrash = defineTool({
  name: 'mock.crash', description: 'test', schema: { to: z.string() },
  async handler({ to }, ctx) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(ctx.vault.abs('.cubicle/mock-outbound.jsonl'), JSON.stringify({ key: ctx.idempotencyKey, to }) + '\n');
    throw new Error('crash after send');
  },
});

function deps(llm: Llm) {
  return { vault, llm, toolsConfig: cfg, registry: new ToolRegistry().registerAll([...phase3Tools({ includeMock: true }), mockCrash]), scheduler: vaultScheduler(vault), env: {} };
}
function growthWith(tools: string[]) {
  vault.updateNote('Roles/growth.md', (n) => ({ data: { ...n.data, tools: [...(n.data.tools as string[]), ...tools] }, body: n.body }), 'owner');
}

describe('critique fixes', () => {
  it('outbound keys are recorded before the call: a crash inside the tool never replays the send (at-most-once)', async () => {
    growthWith(['mock.crash', 'mock.outbound']);
    const id = createJob(vault, { type: 'growth.outreach', title: 'o', assigned: 'growth', goal: 'g' }, 'cto');
    const steps: Step[] = [{ tool: 'mock.crash', args: { to: 'a@x' } }, { tool: 'finish', args: { status: 'done', summary: 'ok' } }];
    const out = await runJob(deps(scripted(steps)), id);
    expect(out.status).toBe('done');
    const j = readJob(vault, id)!;
    expect(j.data.side_effects_done).toEqual([`${id}:1:1`]);
    expect(j.body).toContain(`mock.crash ATTEMPTING (${id}:1:1)`);
    // "resume" the same step index again: key already recorded → skipped, file still has one line
    updateJob(vault, id, { status: 'running', checkpoint_step: 0 }, 'daemon');
    const out2 = await runJob(deps(scripted(steps)), id);
    expect(out2.status).toBe('done');
    const lines = readFileSync(path.join(dir, '.cubicle/mock-outbound.jsonl'), 'utf8').trim().split('\n');
    expect(lines.length).toBe(1);
  });

  it('colleague messages delivered mid-job are persisted and survive a restart', async () => {
    const id = createJob(vault, { type: 'research', title: 'r', assigned: 'growth', goal: 'g' }, 'cto');
    const llm = scripted([{ tool: 'vault.read', args: { path: 'Plans/plan.md' } }, { tool: 'vault.read', args: { path: 'Plans/plan.md' } }, { tool: 'finish', args: { status: 'done', summary: 'ok' } }]);
    const orig = llm.chat.bind(llm);
    let injected = false;
    llm.chat = async (r, c) => {
      const res = await orig(r, c);
      if (!injected) { injected = true; vault.appendText('Messages/growth.md', `\n## ${new Date().toISOString()} from cto (fyi) <!-- id:msg_hello -->\n\nRemember the tone guide.\n`, 'cto'); }
      return res;
    };
    const out = await runJob(deps(llm), id);
    expect(out.status).toBe('done');
    const withMsg = llm.prompts.filter((p) => JSON.stringify(p).includes('Remember the tone guide'));
    expect(withMsg.length).toBeGreaterThanOrEqual(2); // present in every later step, not just one
    expect(loadObservations(vault, id).some((o) => o.kind === 'system' && (o.text ?? '').includes('Remember the tone guide'))).toBe(true);
    expect(vault.readText('Messages/growth.md')).toContain('<!-- read:');
  });

  it('final failed / owner-blocked jobs are not re-run; retries archive the transcript', async () => {
    const id = createJob(vault, { type: 'research', title: 'r', assigned: 'growth', goal: 'g', max_attempts: 2 }, 'cto');
    const bad = { ...scripted([]), async chat(): Promise<RoutedChatResult> { return { content: '', toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 }, provider: 'f', model: 'f', tier: 'medium', downgraded: false, parsedToolCalls: [], jsonParseError: 'nope' }; }, promptBudget: () => 6000 } as Llm;
    expect((await runJob(deps(bad), id)).status).toBe('requeued');
    expect(existsSync(path.join(dir, `.cubicle/jobs/${id}.attempt1.jsonl`))).toBe(true);
    expect(readJob(vault, id)!.data.attempt).toBe(2);
    expect((await runJob(deps(bad), id)).status).toBe('failed');
    expect((await runJob(deps(bad), id)).status).toBe('failed'); // terminal: no re-run, no extra events
    const blockedId = createJob(vault, { type: 'research', title: 'b', assigned: 'growth', goal: 'g' }, 'cto');
    expect((await runJob(deps(scripted([{ tool: 'finish', args: { status: 'blocked', summary: 'need owner', blockers: ['x'] } }])), blockedId)).status).toBe('blocked');
    expect(readJob(vault, blockedId)!.data.blocked_on?.kind).toBe('owner');
    const before = vault.events.count('job.started');
    expect((await runJob(deps(scripted([])), blockedId)).status).toBe('blocked');
    expect(vault.events.count('job.started')).toBe(before);
  });

  it('observations are synthesised from the checkpoint log when the cache is wiped', async () => {
    const id = createJob(vault, { type: 'research', title: 'r', assigned: 'growth', goal: 'g' }, 'cto');
    const llm = scripted([{ tool: 'vault.read', args: { path: 'Plans/plan.md' } }, { tool: 'vault.read', args: { path: 'Brand/name.md' } }, { tool: 'finish', args: { status: 'done', summary: 'ok' } }]);
    const orig = llm.chat.bind(llm);
    let n = 0;
    llm.chat = async (r, c) => { if (++n === 3) throw new Error('boom'); return orig(r, c); };
    await expect(runJob(deps(llm), id)).rejects.toThrow('boom');
    rmSync(path.join(dir, '.cubicle/jobs'), { recursive: true, force: true });
    const obs = loadObservations(vault, id);
    expect(obs.length).toBe(2);
    expect(obs[1].tool).toBe('vault.read');
    expect((await runJob(deps(scripted([{ tool: 'finish', args: { status: 'done', summary: 'ok' } }])), id)).status).toBe('done');
  });
});
