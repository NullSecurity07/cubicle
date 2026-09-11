/**
 * Scripted model for the org-shaped planning cycle (spec §3): the CEO writes the plan; the board returns it once
 * then passes; division leads enqueue one job each; everyone else finishes. Shared by `packages/daemon/test/planning.test.ts`
 * and `scripts/test-kill9.ts` (planning fan-out scenario) so both exercise the exact same scripted behaviour.
 */
import type { RoutedChatResult, RouteRequest, ChatMessage, ToolSchema } from '@cubicle/router';
import type { Llm } from '@cubicle/harness';

export const PLAN = '---\ncycle: 1\n---\n# Plan\n\n## Objectives\n\n### dev\n- Scaffold the site from Brand/\n\n### revenue\n- Find the first organic channel\n';

export function orgLlm(opts: { vetoes?: number; plan?: string; boardSilent?: boolean } = {}): Llm & { calls: Record<string, number> } {
  let vetoes = opts.vetoes ?? 1;
  const plan = opts.plan ?? PLAN;
  const per = new Map<string, number>();
  const llm = {
    calls: {} as Record<string, number>,
    async chat(req: RouteRequest, chat: { messages: ChatMessage[]; tools?: ToolSchema[] }): Promise<RoutedChatResult> {
      const role = req.roleId ?? '?'; llm.calls[role] = (llm.calls[role] ?? 0) + 1;
      const base = { content: '', toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 5, completion_tokens: 1 }, provider: 'f', model: 'f', tier: 'medium' as const, downgraded: false, parsedToolCalls: [] as { name: string; args: Record<string, unknown> }[] };
      if (!chat.tools) {
        const last = String(chat.messages.at(-1)?.content ?? '');
        // A board chair's merge prompt, for either subject, names the exact verdict line; an advisor's does not.
        // Since SP3 the board also sits on ideas, and both chair prompts ask for "VERDICT: pass" — so the plan's
        // chair is identified by the phrase only its prompt carries ("this plan"; the idea's says "this idea").
        // Without that, an idea session would spend the scripted plan veto below.
        const planChair = /VERDICT: pass/.test(last) && /this plan/.test(last);
        // `boardSilent` simulates "no model was available" for every board call (advisors and chair alike),
        // the same way askAs's catch does when deps.llm.chat throws — used to test the zero-advisors-answered path.
        if (opts.boardSilent && (planChair || /Imagine the cycle has already failed/.test(last))) throw new Error('no model available');
        if (planChair) { const v = vetoes-- > 0; return { ...base, content: v ? 'VERDICT: return\n- growth objective has no metric' : 'VERDICT: pass\n- watch the free tier' }; }
        if (/Imagine the cycle has already failed/.test(last)) return { ...base, content: '- the plan names no metric — add one\n- nobody owns the deploy — name them' };
        return { ...base, content: /NAME:/.test(last) ? 'NAME: X\nTAGLINE: y' : 'ok' };
      }
      const jobMsg = String(chat.messages[1]?.content ?? '');
      const jobId = jobMsg.match(/Jobs\/(job_\w+)\.md/)?.[1] ?? 'x';
      const n = per.get(jobId) ?? 0; per.set(jobId, n + 1);
      const jobType = jobMsg.match(/type: ([\w.]+)/)?.[1] ?? '';
      const jobTitle = jobMsg.match(/title: ([^·\n]+)/)?.[1]?.trim() ?? '';
      // The "launch" process's step titles ("Build: ...", "Announce: ...", "Outreach: ...", "Measure launch") —
      // never finish these so they are provably still open (queued/running) when the heartbeat completes, proving
      // division_plans does not wait on process-expanded jobs (Task 9 review round 2). No other test's jobs use these
      // titles, so this is a no-op everywhere else.
      if (/^(Build|Announce|Outreach|Measure launch):? /.test(jobTitle) || jobTitle === 'Measure launch') return { ...base, parsedToolCalls: [{ name: 'vault.read', args: { path: 'Plans/plan.md' } }] };
      if (jobType === 'company.plan') return { ...base, parsedToolCalls: [n === 0 ? { name: 'vault.write', args: { path: 'Plans/plan.md', content: plan } } : { name: 'finish', args: { status: 'done', summary: 'objectives written' } }] };
      if (jobType === 'division.plan') {
        // The division leads: the CTO schedules into the Dev room, the CFO asks Research for the revenue question.
        const member = role === 'cto' ? 'backend_engineer' : role === 'cfo' ? 'research_manager' : null;
        const isResearch = member === 'research_manager';
        const research = isResearch ? {
          decision: 'Ship the pricing page or keep the waitlist',
          decision_owner: role,
          question: 'Does a public price reduce signups?',
          hypothesis: 'A public price cuts signups by more than 20%',
          known_evidence: 'Two competitors publish prices',
          unknowns: 'Whether our visitors are price-sensitive',
          constraints: 'No paid tooling',
          deadline: '2026-09-25',
          required_confidence: 'medium',
          potential_decisions: ['Publish the price', 'Keep the waitlist'],
          portfolio: 'incremental',
          impact: 4, uncertainty: 4, cost_of_being_wrong: 4,
        } : undefined;
        return { ...base, parsedToolCalls: [n === 0 && member ? { name: 'scheduler.request', args: { type: isResearch ? 'research' : 'engineer.ship', title: `Do ${role}`, assigned: member, goal: 'g', done_when: 'd', for: isResearch ? role : undefined, risk: isResearch ? undefined : 'low', stream: member === 'backend_engineer' ? 'site' : undefined, research } } : { name: 'finish', args: { status: 'done', summary: 'planned' } }] };
      }
      return { ...base, parsedToolCalls: [{ name: 'finish', args: { status: 'done', summary: `${role} done`, verdict: 'pass' } }] };
    },
    promptBudget: () => 6000,
  };
  return llm;
}
