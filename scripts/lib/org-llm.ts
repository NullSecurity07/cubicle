/**
 * Scripted model for the org-shaped planning cycle (spec §3): the CEO writes the plan; the Skeptic returns once
 * then passes; managers enqueue one job each; everyone else finishes. Shared by `packages/daemon/test/planning.test.ts`
 * and `scripts/test-kill9.ts` (planning fan-out scenario) so both exercise the exact same scripted behaviour.
 */
import type { RoutedChatResult, RouteRequest, ChatMessage, ToolSchema } from '@cubicle/router';
import type { Llm } from '@cubicle/harness';

export const PLAN = '---\ncycle: 1\n---\n# Plan\n\n## Objectives\n\n### dev\n- Scaffold the site from Brand/\n\n### revenue\n- Find the first organic channel\n';

export function orgLlm(opts: { vetoes?: number; plan?: string } = {}): Llm & { calls: Record<string, number> } {
  let vetoes = opts.vetoes ?? 1;
  const plan = opts.plan ?? PLAN;
  const per = new Map<string, number>();
  const llm = {
    calls: {} as Record<string, number>,
    async chat(req: RouteRequest, chat: { messages: ChatMessage[]; tools?: ToolSchema[] }): Promise<RoutedChatResult> {
      const role = req.roleId ?? '?'; llm.calls[role] = (llm.calls[role] ?? 0) + 1;
      const base = { content: '', toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 5, completion_tokens: 1 }, provider: 'f', model: 'f', tier: 'medium' as const, downgraded: false, parsedToolCalls: [] as { name: string; args: Record<string, unknown> }[] };
      if (!chat.tools) return { ...base, content: /NAME:/.test(String(chat.messages.at(-1)?.content)) ? 'NAME: X\nTAGLINE: y' : 'ok' };
      const jobMsg = String(chat.messages[1]?.content ?? '');
      const jobId = jobMsg.match(/Jobs\/(job_\w+)\.md/)?.[1] ?? 'x';
      const n = per.get(jobId) ?? 0; per.set(jobId, n + 1);
      const jobType = jobMsg.match(/type: ([\w.]+)/)?.[1] ?? '';
      const jobTitle = jobMsg.match(/title: ([^·\n]+)/)?.[1]?.trim() ?? '';
      // The "launch" process's step titles ("Build: ...", "Announce: ...", "Outreach: ...", "Measure launch") —
      // never finish these so they are provably still open (queued/running) when the heartbeat completes, proving
      // team_plans does not wait on process-expanded jobs (Task 9 review round 2). No other test's jobs use these
      // titles, so this is a no-op everywhere else.
      if (/^(Build|Announce|Outreach|Measure launch):? /.test(jobTitle) || jobTitle === 'Measure launch') return { ...base, parsedToolCalls: [{ name: 'vault.read', args: { path: 'Plans/plan.md' } }] };
      if (jobType === 'company.plan') return { ...base, parsedToolCalls: [n === 0 ? { name: 'vault.write', args: { path: 'Plans/plan.md', content: plan } } : { name: 'finish', args: { status: 'done', summary: 'objectives written' } }] };
      if (jobType === 'critic.premortem') { const v = vetoes-- > 0; return { ...base, parsedToolCalls: [{ name: 'finish', args: { status: 'done', summary: v ? 'too vague' : 'fine', verdict: v ? 'return' : 'pass', findings: v ? ['growth objective has no metric'] : [] } }] }; }
      if (jobType === 'team.plan') { const member = role === 'dev_manager' ? 'backend_engineer' : role === 'cfo' ? 'research_manager' : null; return { ...base, parsedToolCalls: [n === 0 && member ? { name: 'scheduler.request', args: { type: member === 'backend_engineer' ? 'engineer.ship' : 'research', title: `Do ${role}`, assigned: member, goal: 'g', done_when: 'd', for: member === 'research_manager' ? role : undefined, risk: member === 'backend_engineer' ? 'low' : undefined, stream: member === 'backend_engineer' ? 'site' : undefined } } : { name: 'finish', args: { status: 'done', summary: 'planned' } }] }; }
      return { ...base, parsedToolCalls: [{ name: 'finish', args: { status: 'done', summary: `${role} done`, verdict: 'pass' } }] };
    },
    promptBudget: () => 6000,
  };
  return llm;
}
