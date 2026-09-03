import {
  parseNote, RoleFrontmatter as RoleSchema, type Vault, type RoleFrontmatter, type JobFrontmatter, type CubicleEvent,
  loadOrg, teamOf, leadOf, isLead, reportsOf, can, listJobs, loadGates, gatesFor, criteriaFor, type Org, type GateTable,
} from '@cubicle/core';
import { estimateTokens, type ChatMessage } from '@cubicle/router';
import type { MemoryIndex } from './memory.js';

export interface Observation {
  step: number;
  kind: 'assistant' | 'tool' | 'system';
  tool?: string;
  args?: Record<string, unknown>;
  result?: string;
  text?: string;
  ok?: boolean;
  ts: string;
}

export interface ContextInput {
  vault: Vault;
  role: RoleFrontmatter;
  roleBody: string;
  job: JobFrontmatter;
  jobBody: string;
  observations: Observation[];
  memory?: MemoryIndex;
  maxPromptTokens: number;
  /** Events since the last heartbeat (owner.edited) to surface owner changes. */
  ownerEdits?: CubicleEvent[];
  summarize?: (text: string) => Promise<string>;
  extraSystem?: string;
  maxSteps?: number;
  org?: Org;
  gates?: GateTable;
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + `\n…[clipped ${s.length - max} chars]` : s;
}

/**
 * Context assembly in the spec §6 order: constitution → charter → owner_preferences → plan (summary if long)
 * → owner edits since last cycle → job note → unread colleague messages → relevant memory → observations.
 * Trimmed to `maxPromptTokens` by shrinking the least important blocks first.
 */
export async function assembleContext(inp: ContextInput): Promise<ChatMessage[]> {
  const v = inp.vault;
  const constitution = v.readTextOrNull('Memory/constitution.md') ?? '';
  const prefs = v.readTextOrNull('Memory/owner_preferences.md') ?? '';
  const planRaw = v.readTextOrNull('Plans/plan.md') ?? '';
  let plan = planRaw;
  if (planRaw.length > 6000) plan = inp.summarize ? await inp.summarize(planRaw) : clip(planRaw, 6000);

  const ownerEdits = (inp.ownerEdits ?? []).map((e) => `- ${String(e.payload.path)}${e.payload.deleted ? ' (deleted)' : ''}`);
  const ownerBlock = ownerEdits.length ? `The owner edited these files since the last cycle; treat them as instructions:\n${[...new Set(ownerEdits)].join('\n')}` : '';

  const role = inp.role;
  const toolList = role.tools.join(', ');

  const org = inp.org ?? loadOrg(v);
  const gates = inp.gates ?? loadGates();
  const team = teamOf(org, role.role);

  let memoryBlock = '';
  if (inp.memory && inp.memory.count() > 0) {
    const q = `${inp.job.title}\n${inp.jobBody.slice(0, 600)}`;
    const hits = (await inp.memory.search(q, 5).catch(() => []))
      .filter((h) => !/#team:(\w+)/.test(h.text) || h.text.includes(`#team:${team?.id}`));
    if (hits.length) memoryBlock = hits.map((h) => `### ${h.path} (relevance ${h.score.toFixed(2)})\n${clip(h.text, 900)}`).join('\n\n');
  }

  const lead = leadOf(org, role.role);
  const isLeadRole = isLead(org, role.role) || role.role === 'ceo';
  const teammates = team ? [team.lead, ...team.members].filter((r) => r !== role.role) : [];
  const disp = (r: string) => org.roles[r]?.display ?? r;
  const teamBlock = team ? `# Your team\n${team.name} — ${team.mission}\nLead: ${lead === 'owner' ? 'the owner' : disp(lead ?? '')}. Teammates: ${teammates.map(disp).join(', ') || 'none'}.\n${isLeadRole ? `Your reports: ${reportsOf(org, role.role).map(disp).join(', ') || 'none'} — schedule work for them with scheduler.request (done_when required).` : `Ask ${disp(lead ?? 'ceo')} for anything outside the team; hand off only to a teammate.`}\nResearch: ${can(org, role.role, 'research_request') ? 'request it with scheduler.request(type: research, assigned: research_analyst, for: your role)' : 'ask your lead to request it'}.` : '';
  const openWork = listJobs(v, { assigned: role.role, status: ['queued', 'blocked', 'in_review'] }).filter((j) => j.id !== inp.job.id).slice(0, 8);
  const openBlock = openWork.length ? `# Your open work\n${openWork.map((j) => `- ${j.status} ${j.id}: ${j.title}`).join('\n')}\nDo not re-plan these; finish the current job.` : '';
  const criteria = criteriaFor(gates, inp.job.type);
  const criteriaBlock = criteria || inp.job.done_when ? `# What good looks like\n${criteria}${inp.job.done_when ? `\nDone when: ${inp.job.done_when}` : ''}${gatesFor(gates, inp.job.type).length ? `\nThis job is reviewed by: ${gatesFor(gates, inp.job.type).join(' then ')}.` : ''}` : '';
  const findings = inp.jobBody.split('## Review findings')[1]?.split(/\n## /)[0]?.trim();
  const findingsBlock = findings ? `The reviewer returned this job; address every finding before finishing again:\n${findings}` : '';
  const personaBlock = role.persona ? `# Who you are\n${role.persona}` : '';

  const rules = [
    `You are ${role.display} (role id "${role.role}") at a small company run from the owner's laptop. Work only through tools. When the goal is met, blocked, or impossible, call \`finish\`.`,
    `Job ${inp.job.id} is at checkpoint step ${inp.job.checkpoint_step} of at most ${inp.maxSteps ?? 40}; be economical — one clear tool call per turn.`,
    `Never fabricate results; read before you write. Owner-owned files (Brand/, Roles/, constitution, preferences) can only be proposed, not written.`,
    `Tools you may use: ${toolList}.`,
    !isLeadRole && inp.job.checkpoint_step === 0 ? 'Before your first tool call, plan your next three steps in one line, then act.' : '',
  ].filter(Boolean).join('\n');

  const blocks: { key: string; priority: number; text: string }[] = [
    { key: 'constitution', priority: 100, text: `# Constitution (hard rules, verbatim)\n${constitution}` },
    { key: 'charter', priority: 95, text: `# Your charter\n${inp.roleBody}` },
    { key: 'persona', priority: 94, text: personaBlock },
    { key: 'rules', priority: 99, text: rules },
    { key: 'findings', priority: 89, text: findingsBlock },
    { key: 'criteria', priority: 86, text: criteriaBlock },
    { key: 'team', priority: 85, text: teamBlock },
    { key: 'prefs', priority: 70, text: prefs ? `# Owner preferences\n${prefs}` : '' },
    { key: 'plan', priority: 60, text: plan ? `# Current plan (Plans/plan.md)\n${plan}` : '' },
    { key: 'openwork', priority: 55, text: openBlock },
    { key: 'owner', priority: 90, text: ownerBlock },
    { key: 'memory', priority: 40, text: memoryBlock ? `# Relevant memory (skills, lessons, decisions)\n${memoryBlock}` : '' },
    { key: 'extra', priority: 80, text: inp.extraSystem ?? '' },
  ].filter((b) => b.text.trim());

  const jobHeader = `# Job note (Jobs/${inp.job.id}.md)\n` +
    `type: ${inp.job.type} · title: ${inp.job.title} · priority: ${inp.job.priority} · attempt: ${inp.job.attempt}/${inp.job.max_attempts} · privacy: ${inp.job.privacy}\n\n${clip(inp.jobBody, 8000)}`;

  const obsMsgs = renderObservations(inp.observations);

  // Budget: trim lowest-priority blocks first, then older observations.
  const budget = inp.maxPromptTokens;
  const size = () => estimateTokens(blocks.map((b) => b.text).join('\n\n') + jobHeader + obsMsgs.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n'));
  const trimOrder = [...blocks].sort((a, b) => a.priority - b.priority);
  for (const b of trimOrder) {
    if (size() <= budget) break;
    if (b.priority >= 95) continue;
    b.text = clip(b.text, Math.max(400, Math.floor(b.text.length / 3)));
  }
  let obs = obsMsgs;
  let dropped = 0;
  while (size() > budget && obs.length > 4) { obs = [obs[0], ...obs.slice(3)]; dropped++; }
  if (dropped && inp.summarize) {
    const droppedText = inp.observations.slice(0, dropped + 1).map((o) => o.kind === 'tool' ? `${o.tool}(${JSON.stringify(o.args ?? {}).slice(0, 100)}) → ${(o.result ?? '').slice(0, 300)}` : (o.text ?? '').slice(0, 300)).join('\n');
    const summary = await inp.summarize(droppedText).catch(() => '');
    if (summary) obs = [{ role: 'user', content: `Summary of earlier steps:\n${clip(summary, 1500)}` }, ...obs.slice(1)];
  }
  if (size() > budget) for (const b of trimOrder) { if (b.priority >= 99) continue; b.text = clip(b.text, 400); if (size() <= budget) break; }
  // Last resort: shrink tool results in the retained observations.
  if (size() > budget) obs = obs.map((m) => (typeof m.content === 'string' && m.content.startsWith('[') ? { ...m, content: clip(m.content, 800) } as ChatMessage : m));

  return [
    { role: 'system', content: blocks.map((b) => b.text).join('\n\n') },
    { role: 'user', content: `${jobHeader}\n\n${inp.observations.length ? `You are resuming at step ${inp.job.checkpoint_step}. Continue from your last observation.` : 'Begin. Read what you need, then act.'}` },
    ...obs,
  ];
}

function renderObservations(obs: Observation[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  const recent = obs.slice(-12);
  const older = obs.slice(0, -12);
  if (older.length) {
    out.push({ role: 'user', content: `Earlier steps (summarised):\n${older.map((o) => o.kind === 'tool' ? `- step ${o.step}: ${o.tool}(${JSON.stringify(o.args ?? {}).slice(0, 80)}) → ${o.ok === false ? 'FAILED: ' : ''}${(o.result ?? '').slice(0, 100).replace(/\n/g, ' ')}` : `- step ${o.step}: ${(o.text ?? '').slice(0, 100).replace(/\n/g, ' ')}`).join('\n')}` });
  }
  for (const o of recent) {
    if (o.kind === 'assistant') out.push({ role: 'assistant', content: o.text ?? '' });
    else if (o.kind === 'tool') {
      out.push({ role: 'assistant', content: `[called ${o.tool} with ${JSON.stringify(o.args ?? {})}]` });
      out.push({ role: 'user', content: `[${o.tool} result${o.ok === false ? ' (error)' : ''}]\n${clip(o.result ?? '', 6000)}` });
    } else out.push({ role: 'user', content: o.text ?? '' });
  }
  return out;
}

export function readRole(vault: Vault, roleId: string): { data: RoleFrontmatter; body: string } | null {
  const text = vault.readTextOrNull(`Roles/${roleId}.md`);
  if (!text) return null;
  const note = parseNote(text);
  const parsed = RoleSchema.safeParse(note.data);
  return parsed.success ? { data: parsed.data, body: note.body } : null;
}
