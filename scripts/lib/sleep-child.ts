/** Child for test-sleep: `init`, `daemon` (real Daemon with a scripted slow LLM), `fake-login1` (private-bus login1 that emits PrepareForSleep on stdin "sleep"). */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scaffoldVault, Vault, createJob, readJob, listJobs } from '@cubicle/core';
import type { RoutedChatResult, RouteRequest, ChatMessage, ToolSchema } from '@cubicle/router';
import type { Llm } from '@cubicle/harness';
import { Daemon, defaultConfig } from '@cubicle/daemon';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const [cmd, vaultPath] = process.argv.slice(2);

async function main() {
  if (cmd === 'init') {
    const { vault } = await scaffoldVault(vaultPath);
    createJob(vault, { type: 'research', title: 'sleep test', assigned: 'cmo', goal: 'read the plan twice' }, 'cto');
    vault.close();
    return;
  }
  if (cmd === 'fake-login1') {
    const dbus = await import('dbus-next');
    const bus = dbus.sessionBus({ busAddress: process.env.CUBICLE_DBUS_ADDRESS });
    const { Interface } = dbus.interface;
    class Manager extends Interface {
      Inhibit(): number { return 0; }
      PrepareForSleep(start: boolean): boolean { return start; }
    }
    Manager.configureMembers({ methods: { Inhibit: { inSignature: 'ssss', outSignature: 'u' } }, signals: { PrepareForSleep: { signature: 'b' } } });
    const iface = new Manager('org.freedesktop.login1.Manager');
    bus.export('/org/freedesktop/login1', iface);
    await bus.requestName('org.freedesktop.login1', 0);
    console.log('FAKE LOGIN1 READY');
    process.stdin.on('data', (d) => { if (String(d).includes('sleep')) iface.PrepareForSleep(true); });
    return;
  }
  // daemon
  const vault0 = Vault.open(vaultPath);
  const job = listJobs(vault0).find((j) => j.type === 'research')!;
  if (job.status === 'running') console.log(`RESUMED FROM STEP ${job.checkpoint_step}`);
  vault0.close();
  const finish = process.env.CUBICLE_FINISH === '1';
  const llm: Llm = {
    async chat(_req: RouteRequest, chat: { messages: ChatMessage[]; tools?: ToolSchema[] }): Promise<RoutedChatResult> {
      const base = { content: 'ok', toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 }, provider: 'fake', model: 'fake', tier: 'medium' as const, downgraded: false, parsedToolCalls: [] as { name: string; args: Record<string, unknown> }[] };
      if (!chat.tools) return base;
      const m = String(chat.messages[1]?.content ?? '').match(/Jobs\/(job_\w+)\.md/);
      const v = Vault.open(vaultPath); const j = m ? readJob(v, m[1]) : null; v.close();
      const step = j?.data.checkpoint_step ?? 0;
      if (j?.data.type !== 'research') return { ...base, parsedToolCalls: [{ name: 'finish', args: { status: 'done', summary: 'x' } }] };
      if (step >= 1 && !finish) { console.log('STEP 1 DONE'); await new Promise((r) => setTimeout(r, 60_000)); }
      if (step >= 2) { console.log('JOB DONE'); return { ...base, parsedToolCalls: [{ name: 'finish', args: { status: 'done', summary: 'done' } }] }; }
      return { ...base, parsedToolCalls: [{ name: 'vault.read', args: { path: 'Plans/plan.md' } }] };
    },
    promptBudget: () => 6000,
  };
  // `disablePantry`: this script checkpoints one named job across a suspend and counts what resumed, and a coffee
  // break the tick scheduled beside it is neither checkpointed nor counted (SP5 Decision 20).
  const d = new Daemon(defaultConfig(vaultPath, process.env, { port: 0, tickMs: 1000, providersPath: path.join(root, 'config/providers.yaml'), toolsPath: path.join(root, 'config/tools.yaml') }), { llm, disableWs: true, disablePantry: true, memory: false, heartbeatHooks: {}, log: (m) => console.log(`[cubicle] ${m}`) });
  // No heartbeat in this test: mark one as completed "now" so the startup trigger stays quiet
  await d.start();
  d.vault.events.emit({ type: 'heartbeat.completed', payload: { id: 'seed', synthetic: true } });
}
main().catch((e) => { console.error(e); process.exit(1); });
