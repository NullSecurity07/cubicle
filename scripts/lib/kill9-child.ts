/** Child process for test-kill9: `init <vault>` scaffolds; `run <vault>` runs the real Daemon with a scripted 4-step job. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { scaffoldVault, Vault, createJob, readJob, listJobs } from '@cubicle/core';
import type { RoutedChatResult, RouteRequest, ChatMessage, ToolSchema } from '@cubicle/router';
import type { Llm } from '@cubicle/harness';
import { Daemon, defaultConfig } from '@cubicle/daemon';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const [cmd, vaultPath] = process.argv.slice(2);

const steps = [
  { name: 'vault.read', args: { path: 'Plans/plan.md' } },
  { name: 'mock.outbound', args: { to: 'a@x.com', body: 'hello a' } },
  { name: 'mock.outbound', args: { to: 'b@x.com', body: 'hello b' } },
  { name: 'finish', args: { status: 'done', summary: 'sent two' } },
];

async function main() {
  if (cmd === 'init') {
    const { vault } = await scaffoldVault(vaultPath);
    // The fake `Llm` below replaces the *harness's* model, not the daemon's `Router` — and the constitution
    // guardrail holds that Router. Its `banned_tactics` classifier reads the body of every `mock.outbound`
    // this script sends, so without this line `pnpm test:kill9` makes a real inference call to whatever model
    // server the machine is running, twice, in the middle of a race it times with a SIGKILL. Exactly the shape
    // B1 found in the daemon suite; the reasoning is written out in full in
    // `packages/daemon/test/helpers/no-local-model.ts`. Written as `owner`, the only writer the constitution
    // allows, and checked afterwards so a template change cannot quietly hand the script its model call back.
    const before = vault.readText('Memory/constitution.md');
    vault.writeText('Memory/constitution.md', before.replace(/^banned_tactics:[ \t]*\n(?:[ \t]+-[^\n]*\n)*/m, 'banned_tactics: []\n'), 'owner');
    const left = vault.constitution().banned_tactics;
    if (left.length) throw new Error(`kill9: banned_tactics is still ${JSON.stringify(left)}; the guardrail would call a real model server on every mock.outbound this script sends`);
    vault.updateNote('Roles/cmo.md', (n) => ({ data: { ...n.data, tools: [...(n.data.tools as string[]), 'mock.outbound'] }, body: n.body }), 'owner');
    createJob(vault, { type: 'growth.outreach', title: 'kill9 outreach', assigned: 'cmo', goal: 'send two' }, 'cto');
    vault.events.emit({ type: 'heartbeat.completed', payload: { id: 'seed', synthetic: true } }); // keep the startup heartbeat quiet
    vault.close();
    return;
  }
  const stale = path.join(vaultPath, '.cubicle', 'daemon.json');
  if (existsSync(stale)) console.log(`stale daemon.json from pid ${JSON.parse(readFileSync(stale, 'utf8')).pid} present`);
  const v0 = Vault.open(vaultPath);
  const job = listJobs(v0).find((j) => j.type === 'growth.outreach')!;
  if (job.status === 'running') console.log(`RESUMED FROM STEP ${job.checkpoint_step}`);
  v0.close();
  const llm: Llm = {
    async chat(req: RouteRequest, chat: { messages: ChatMessage[]; tools?: ToolSchema[] }): Promise<RoutedChatResult> {
      const base = { content: 'ok', toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 }, provider: 'fake', model: 'fake', tier: 'medium' as const, downgraded: false, parsedToolCalls: [] as { name: string; args: Record<string, unknown> }[] };
      if (!chat.tools) return base;
      if (req.roleId !== 'cmo') return { ...base, parsedToolCalls: [{ name: 'finish', args: { status: 'done', summary: 'x' } }] };
      const m = String(chat.messages[1]?.content ?? '').match(/Jobs\/(job_\w+)\.md/);
      const v = Vault.open(vaultPath); const j = m ? readJob(v, m[1]) : null; v.close();
      const step = j?.data.checkpoint_step ?? 0;
      const hang = Number(process.env.CUBICLE_HANG_AFTER_STEP ?? 0);
      if (hang && step >= hang) { console.log(`STEP ${step} DONE`); await new Promise(() => undefined); }
      return { ...base, parsedToolCalls: [steps[Math.min(step, steps.length - 1)]] };
    },
    promptBudget: () => 6000,
  };
  // `disablePantry`: this script counts the company's jobs and their steps, and a coffee break is neither (SP5 Decision 20).
  const d = new Daemon(defaultConfig(vaultPath, { ...process.env, CUBICLE_MOCK_TOOLS: '1' }, { tickMs: 1000, providersPath: path.join(root, 'config/providers.yaml'), toolsPath: path.join(root, 'config/tools.yaml') }), { llm, disableWs: true, disableSleepWatch: true, disablePantry: true, memory: false, log: (m) => console.log(`[cubicle] ${m}`) });
  await d.start();
  if (d.vault.events.count('job.interrupted') > 0) console.log('JOB.INTERRUPTED EMITTED');
  const t0 = Date.now();
  while (Date.now() - t0 < 60_000) {
    const j = readJob(d.vault, job.id)!.data;
    if (j.status === 'done' || j.status === 'failed') { console.log(`JOB ${j.status.toUpperCase()} step=${j.checkpoint_step} side_effects=${JSON.stringify(j.side_effects_done)}`); break; }
    await new Promise((r) => setTimeout(r, 300));
  }
  await d.stop();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
