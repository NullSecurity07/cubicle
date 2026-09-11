/**
 * Child process for test-kill9 scenario 2 (planning fan-out): `init <vault>` scaffolds the default org; `run <vault>`
 * runs the real Daemon with the org-shaped scripted model (org-llm.ts). When CUBICLE_HANG_DIVISION_PLAN is set, the
 * very first `division.plan` chat call hangs after the job note is already `running` (status flips to running before
 * the first chat call), printing "DIVISION_PLAN RUNNING" so the parent can kill -9 while it is genuinely running.
 *
 * The fan-out itself happens on the heartbeat AFTER the one that wrote the plan: the plan waits for a verdict, and
 * this run has no owner, so `init` hands the board that ruling and `run` keeps asking for heartbeats.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scaffoldVault, createStream, writeCiRecord, listJobs } from '@cubicle/core';
import type { RoutedChatResult, RouteRequest, ChatMessage, ToolSchema } from '@cubicle/router';
import type { Llm } from '@cubicle/harness';
import { Daemon, defaultConfig } from '@cubicle/daemon';
import { orgLlm } from './org-llm.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const [cmd, vaultPath] = process.argv.slice(2);

async function main() {
  if (cmd === 'init') {
    const { vault } = await scaffoldVault(vaultPath);
    // The startup heartbeat only fires once the company has an idea (spec §12); naming the brand is the inert way.
    vault.updateNote('Brand/name.md', (n) => ({ data: { ...n.data, name: 'PlateReady' }, body: n.body }), 'owner');
    // ≈ 1.1 s: board_decides_after_hours is off in a shipped vault, so a headless run would wait here for ever.
    vault.writeText('Memory/constitution.md', vault.readText('Memory/constitution.md').replace(/^board_decides_after_hours:.*$/m, 'board_decides_after_hours: 0.0003'), 'owner');
    // The scripted dev plan queues an engineer.ship, which cannot finish without a green CI record (§17).
    createStream(vault, { slug: 'site', name: 'Site', problem: 'The company has no site.', customers: 'Everyone who hears about us', outcome_metric: 'a first cut exists', owner_team: 'dev' }, 'ceo');
    writeCiRecord(vault, 'site', { stream: 'site', started: '2026-09-11T09:59:00.000Z', finished: '2026-09-11T10:00:00.000Z', green: true, commit: null, steps: [{ name: 'test', code: 0, ok: true, duration_ms: 5, output: 'ok' }] }, 'backend_engineer');
    vault.close();
    return;
  }
  const inner = orgLlm({ vetoes: 0 });
  let hung = false;
  const llm: Llm & { calls: Record<string, number> } = {
    calls: inner.calls,
    async chat(req: RouteRequest, chat: { messages: ChatMessage[]; tools?: ToolSchema[] }): Promise<RoutedChatResult> {
      const jobMsg = String(chat.messages[1]?.content ?? '');
      const jobType = jobMsg.match(/type: ([\w.]+)/)?.[1] ?? '';
      if (chat.tools && jobType === 'division.plan' && !hung && process.env.CUBICLE_HANG_DIVISION_PLAN) {
        hung = true;
        console.log('DIVISION_PLAN RUNNING');
        await new Promise<never>(() => undefined); // never resolves: the job note stays status=running, checkpoint_step=0
      }
      return inner.chat(req, chat);
    },
    promptBudget: () => 6000,
  };
  const d = new Daemon(defaultConfig(vaultPath, { ...process.env, CUBICLE_MOCK_TOOLS: '1' }, { tickMs: 300, maxConcurrentJobs: 3, providersPath: path.join(root, 'config/providers.yaml'), toolsPath: path.join(root, 'config/tools.yaml') }), { llm, disableWs: true, disableSleepWatch: true, memory: false, log: (m) => console.log(`[cubicle] ${m}`) });
  await d.start();
  const t0 = Date.now();
  // The first cycle only files the verdict note; keep asking until the board's verdict has stood and the
  // divisions have actually planned.
  while (Date.now() - t0 < 120_000) {
    const planned = listJobs(d.vault).some((j) => j.type === 'division.plan');
    if (planned && d.vault.events.count('heartbeat.completed') >= 1) { console.log('HEARTBEAT COMPLETED'); break; }
    await new Promise((r) => setTimeout(r, 500));
    if (d.vault.events.count('heartbeat.completed') >= 1) d.requestHeartbeat('the board decides');
  }
  await d.stop();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
