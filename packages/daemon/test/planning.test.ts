import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, listJobs, readJob } from '@cubicle/core';
import type { RoutedChatResult, RouteRequest, ChatMessage, ToolSchema } from '@cubicle/router';
import type { Llm } from '@cubicle/harness';
import { Daemon, defaultConfig, HEARTBEAT_STEPS } from '../src/index.js';

const root = path.resolve(__dirname, '../../..');
let dir: string;
beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-plan-')); const { vault } = await scaffoldVault(dir); vault.close(); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const PLAN = '---\ncycle: 1\n---\n# Plan\n\n## Objectives\n\n### engineering\n- Scaffold the site from Brand/\n\n### growth\n- Find the first organic channel\n';
/** CEO writes the plan; the Critic returns once then passes; leads enqueue one job each; everyone else finishes. */
function orgLlm(opts: { vetoes?: number } = {}): Llm & { calls: Record<string, number> } {
  let vetoes = opts.vetoes ?? 1;
  const per = new Map<string, number>();
  const llm = {
    calls: {} as Record<string, number>,
    async chat(req: RouteRequest, chat: { messages: ChatMessage[]; tools?: ToolSchema[] }): Promise<RoutedChatResult> {
      const role = req.roleId ?? '?'; llm.calls[role] = (llm.calls[role] ?? 0) + 1;
      const base = { content: '', toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 5, completion_tokens: 1 }, provider: 'f', model: 'f', tier: 'medium' as const, downgraded: false, parsedToolCalls: [] as { name: string; args: Record<string, unknown> }[] };
      if (!chat.tools) return { ...base, content: /NAME:/.test(String(chat.messages.at(-1)?.content)) ? 'NAME: X\nTAGLINE: y' : 'ok' };
      const jobId = String(chat.messages[1]?.content ?? '').match(/Jobs\/(job_\w+)\.md/)?.[1] ?? 'x';
      const n = per.get(jobId) ?? 0; per.set(jobId, n + 1);
      const jobType = String(chat.messages[1]?.content ?? '').match(/type: ([\w.]+)/)?.[1] ?? '';
      if (jobType === 'company.plan') return { ...base, parsedToolCalls: [n === 0 ? { name: 'vault.write', args: { path: 'Plans/plan.md', content: PLAN } } : { name: 'finish', args: { status: 'done', summary: 'objectives written' } }] };
      if (jobType === 'critic.premortem') { const v = vetoes-- > 0; return { ...base, parsedToolCalls: [{ name: 'finish', args: { status: 'done', summary: v ? 'too vague' : 'fine', verdict: v ? 'return' : 'pass', findings: v ? ['growth objective has no metric'] : [] } }] }; }
      if (jobType === 'team.plan') { const member = role === 'cto' ? 'engineer' : role === 'head_of_growth' ? 'research_analyst' : null; return { ...base, parsedToolCalls: [n === 0 && member ? { name: 'scheduler.request', args: { type: member === 'engineer' ? 'engineer.ship' : 'research', title: `Do ${role}`, assigned: member, goal: 'g', done_when: 'd', for: member === 'research_analyst' ? role : undefined } } : { name: 'finish', args: { status: 'done', summary: 'planned' } }] }; }
      return { ...base, parsedToolCalls: [{ name: 'finish', args: { status: 'done', summary: `${role} done`, verdict: 'pass' } }] };
    },
    promptBudget: () => 6000,
  };
  return llm;
}
const daemonFor = (llm: Llm) => new Daemon(defaultConfig(dir, { CUBICLE_MOCK_TOOLS: '1' } as NodeJS.ProcessEnv, { port: 0, tickMs: 300, maxConcurrentJobs: 3, providersPath: path.join(root, 'config/providers.yaml'), toolsPath: path.join(root, 'config/tools.yaml') }), { llm, disableWs: true, disableSleepWatch: true, memory: false, log: () => undefined });
async function waitFor(pred: () => boolean, ms = 30000): Promise<void> { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 100)); } }

describe('two-level planning (spec §3)', () => {
  it('steps are company_plan → critic → team_plans; a veto reruns the CEO once; leads fan out; brief has next actions per team', async () => {
    expect(HEARTBEAT_STEPS).toEqual(['gather', 'reconcile_brand', 'answer_owner', 'meeting', 'company_plan', 'critic', 'team_plans', 'brief', 'commit']);
    const llm = orgLlm({ vetoes: 1 });
    const d = daemonFor(llm);
    await d.start();
    const v = Vault.open(dir);
    try {
      await waitFor(() => v.events.count('heartbeat.completed') >= 1, 60000);
      const jobs = listJobs(v);
      expect(jobs.filter((j) => j.type === 'company.plan')).toHaveLength(2); // veto → one rewrite
      expect(jobs.filter((j) => j.type === 'critic.premortem')).toHaveLength(2);
      expect(v.events.count('plan.vetoed')).toBe(1);
      const teamPlans = jobs.filter((j) => j.type === 'team.plan');
      expect(teamPlans.map((j) => j.assigned).sort()).toEqual(['cto', 'head_of_growth']);
      expect(teamPlans.every((j) => j.status === 'done')).toBe(true);
      expect(jobs.some((j) => j.type === 'engineer.ship' && j.owner_role === 'cto' && j.team === 'engineering')).toBe(true);
      expect(jobs.some((j) => j.type === 'research' && j.for === 'head_of_growth')).toBe(true);
      expect(v.events.count('team.planned')).toBe(2);
      const brief = readFileSync(path.join(dir, 'Runs', readFileSync(path.join(dir, 'Jobs/queue.md'), 'utf8') && require('node:fs').readdirSync(path.join(dir, 'Runs')).filter((f: string) => f.endsWith('.md')).sort().at(-1)!), 'utf8');
      expect(brief).toContain('## Next action per team');
      expect(existsSync(path.join(dir, 'Decisions'))).toBe(true);
      console.log('calls per cycle:', llm.calls, '=', Object.values(llm.calls).reduce((a, b) => a + b, 0));
      expect(Object.values(llm.calls).reduce((a, b) => a + b, 0)).toBeLessThan(60);
    } finally { v.close(); await d.stop(); }
  });
  it('a second veto escalates to the owner as a message and the cycle continues', async () => {
    const d = daemonFor(orgLlm({ vetoes: 2 }));
    await d.start();
    const v = Vault.open(dir);
    try {
      await waitFor(() => v.events.count('heartbeat.completed') >= 1, 60000);
      expect(v.events.count('plan.vetoed')).toBe(2);
      expect(listJobs(v).filter((j) => j.type === 'company.plan')).toHaveLength(2);
      expect(v.events.query({ types: ['proposal.created'] }).some((e) => e.payload.kind === 'message' && String(e.payload.title).toLowerCase().includes('veto'))).toBe(true);
    } finally { v.close(); await d.stop(); }
  });
});
