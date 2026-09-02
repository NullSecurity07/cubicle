/** Child process for test-kill9: `init <vault>` scaffolds; `run <vault>` runs one scripted 4-step job through the daemon's worker path. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scaffoldVault, Vault, createJob, readJob, listJobs } from '@cubicle/core';
import type { RoutedChatResult, RouteRequest, ChatMessage, ToolSchema } from '@cubicle/router';
import { parseToolsConfig, ToolRegistry, phase3Tools } from '@cubicle/tools';
import { runJob, vaultScheduler, type Llm } from '@cubicle/harness';
import { readFileSync } from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const [cmd, vaultPath] = process.argv.slice(2);

const steps = [
  { name: 'vault.read', args: { path: 'Plans/plan.md' } },
  { name: 'mock.outbound', args: { to: 'a@x.com', body: 'hello a' } },
  { name: 'mock.outbound', args: { to: 'b@x.com', body: 'hello b' } },
  { name: 'finish', args: { status: 'done', summary: 'sent two' } },
];

function llm(): Llm {
  return {
    async chat(_req: RouteRequest, chat: { messages: ChatMessage[]; tools?: ToolSchema[] }): Promise<RoutedChatResult> {
      const base = { content: '', toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 }, provider: 'fake', model: 'fake', tier: 'medium' as const, downgraded: false, parsedToolCalls: [] as { name: string; args: Record<string, unknown> }[] };
      const jobMsg = String(chat.messages[1]?.content ?? '');
      const m = jobMsg.match(/Jobs\/(job_\w+)\.md/);
      const job = m ? readJob(Vault.open(vaultPath), m[1]) : null;
      const step = job?.data.checkpoint_step ?? 0;
      const hang = Number(process.env.CUBICLE_HANG_AFTER_STEP ?? 0);
      if (hang && step >= hang) { console.log(`STEP ${step} DONE`); await new Promise(() => undefined); }
      return { ...base, parsedToolCalls: [steps[Math.min(step, steps.length - 1)]] };
    },
    promptBudget: () => 6000,
  };
}

async function main() {
  if (cmd === 'init') {
    const { vault } = await scaffoldVault(vaultPath);
    vault.updateNote('Roles/growth.md', (n) => ({ data: { ...n.data, tools: [...(n.data.tools as string[]), 'mock.outbound'] }, body: n.body }), 'owner');
    createJob(vault, { type: 'growth.outreach', title: 'kill9 outreach', assigned: 'growth', goal: 'send two' }, 'cto');
    vault.close();
    return;
  }
  const vault = Vault.open(vaultPath);
  const job = listJobs(vault).find((j) => j.type === 'growth.outreach')!;
  if (job.status === 'running') console.log(`RESUMED FROM STEP ${job.checkpoint_step}`);
  const cfg = parseToolsConfig(readFileSync(path.join(root, 'config/tools.yaml'), 'utf8'));
  const out = await runJob({ vault, llm: llm(), toolsConfig: cfg, registry: new ToolRegistry().registerAll(phase3Tools({ includeMock: true })), scheduler: vaultScheduler(vault), env: {} }, job.id);
  const j = readJob(vault, job.id)!;
  console.log(`JOB ${out.status.toUpperCase()} step=${j.data.checkpoint_step} side_effects=${JSON.stringify(j.data.side_effects_done)}`);
  vault.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
