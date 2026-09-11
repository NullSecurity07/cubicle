export * from './registry.js';
export * from './mcp.js';
export * from './tools/vault.js';
export * from './tools/http.js';
export * from './tools/colleague.js';
export * from './tools/proposal.js';
export * from './tools/scheduler.js';
export * from './tools/skills.js';
export * from './tools/finish.js';
export * from './tools/mock.js';
export * from './tools/shell.js';
export * from './tools/ci.js';
export * from './tools/browser.js';
export * from './tools/git.js';
export * from './tools/meeting.js';
export * from './proxy.js';
export * from './guardrails.js';
export * from './prune.js';
export * from './tools/outbound.js';
export * from './adapters/common.js';
export * from './adapters/email.js';
export * from './adapters/inbox.js';
export * from './adapters/deploy.js';
export * from './adapters/stripe.js';
export * from './adapters/analytics.js';

import type { AnyTool } from './registry.js';
import { vaultTools } from './tools/vault.js';
import { httpFetch } from './tools/http.js';
import { colleagueMessage } from './tools/colleague.js';
import { proposalCreate } from './tools/proposal.js';
import { schedulerRequest } from './tools/scheduler.js';
import { skillsTools } from './tools/skills.js';
import { finish } from './tools/finish.js';
import { mockOutbound } from './tools/mock.js';
import { shellRun } from './tools/shell.js';
import { ciRun } from './tools/ci.js';
import { browserTools } from './tools/browser.js';
import { gitTools } from './tools/git.js';
import { meetingOpen } from './tools/meeting.js';
import { phase6Tools as _p6 } from './tools/outbound.js';

/** Phase 5 additions: sandbox shell, stream CI, browser with screencast, git, meetings. */
export function phase5Tools(): AnyTool[] {
  return [shellRun, ciRun, ...browserTools, ...gitTools, meetingOpen];
}

/** Phase 6 additions: outbound adapters (mock unless keys are present). */
export function phase6Tools(): AnyTool[] {
  return [..._p6];
}

/** Phase 3 tool set (org guards apply to scheduler/proposal/meeting/colleague; Phases 5–6 append shell/browser/git/email/deploy/stripe/analytics/social). */
export function phase3Tools(opts: { includeMock?: boolean } = {}): AnyTool[] {
  const t: AnyTool[] = [...vaultTools, httpFetch, colleagueMessage, proposalCreate, schedulerRequest, ...skillsTools, finish, meetingOpen];
  if (opts.includeMock) t.push(mockOutbound);
  return t;
}
