import {
  type Vault, type JobFrontmatter, readJob, updateJob, createJob, listJobs, listInbox, nowIso, stampForFilename,
  autoCommit, parseNote, stringifyNote, setSection, createProposal, idFromKey, type CubicleEvent,
} from '@cubicle/core';
import type { Llm } from '@cubicle/harness';
import { renderQuotaMarkdown, type Router } from '@cubicle/router';
import { writeQueueMd } from './queue-md.js';
import { collectOwnerFeedback } from './evolution.js';

function collectOwnerFeedbackSafe(vault: Vault, since?: string) {
  try { return collectOwnerFeedback(vault, since); } catch { return []; }
}

export interface HeartbeatDeps {
  vault: Vault;
  llm: Llm;
  router?: Router;
  now?: () => Date;
  /** Phase 6 hooks; stubs until then. */
  pollInbox?: () => Promise<string[]>;
  pullAnalytics?: () => Promise<string | null>;
  /** Phase 5 hook. */
  openMeeting?: (agenda: string) => Promise<string | null>;
}

export type HeartbeatOutcome = { status: 'done' } | { status: 'blocked'; on: { kind: 'job'; id: string } } | { status: 'cancelled' };

export const HEARTBEAT_STEPS = ['gather', 'reconcile_brand', 'answer_owner', 'meeting', 'plan', 'brief', 'commit'] as const;
/** How long a heartbeat waits for cto.plan before writing the brief with "planning pending" (R33). */
export const PLAN_WAIT_BUDGET_MS = 40 * 90_000;

/** Create the `ceo.heartbeat` job note (the heartbeat is a job so R9/R10/R12 apply). */
export function createHeartbeatJob(vault: Vault, trigger: string): string {
  return createJob(vault, {
    type: 'ceo.heartbeat', title: `Heartbeat (${trigger})`, assigned: 'ceo', priority: 1,
    goal: `Company heartbeat triggered by: ${trigger}. Steps: ${HEARTBEAT_STEPS.join(' → ')}.`,
  }, 'daemon');
}

interface Gathered {
  since: string | null;
  gathered_at?: string;
  elapsedHours: number;
  ownerEdits: string[];
  finished: { id: string; type: string; title: string; status: string; summary: string }[];
  mail: string[];
  analytics: string | null;
  unansweredOwnerMessages: { path: string; id: string; created: string; body: string }[];
}

/** The previous heartbeat's gather moment: from its completion event, else from the last done heartbeat note (kill between updateJob and emit). */
export function lastGatheredAt(vault: Vault): string | null {
  const last = vault.events.last('heartbeat.completed');
  if (last) return (last.payload.gathered_at as string | undefined) ?? last.ts;
  const notes = listJobs(vault, { status: 'done' }).filter((j) => j.type === 'ceo.heartbeat').sort((a, b) => a.updated.localeCompare(b.updated));
  return notes.length ? notes[notes.length - 1].created : null;
}

function gather(vault: Vault, now: Date, mail: string[], analytics: string | null): Gathered {
  const since = lastGatheredAt(vault);
  const elapsedHours = since ? (now.getTime() - Date.parse(since)) / 3600_000 : Infinity;
  const ownerEdits = [...new Set(vault.events.query({ types: ['owner.edited'], from: since ?? undefined }).map((e) => String(e.payload.path)))];
  const finished = vault.events.query({ types: ['job.done', 'job.failed'], from: since ?? undefined })
    .filter((e) => e.job)
    .map((e) => { const j = readJob(vault, e.job!); return { id: e.job!, type: j?.data.type ?? '?', title: j?.data.title ?? '?', status: e.type === 'job.done' ? 'done' : 'failed', summary: String(e.payload.summary ?? e.payload.reason ?? '') }; })
    .filter((f) => f.type !== 'ceo.heartbeat');
  const unansweredOwnerMessages = listInbox(vault).filter((n) => n.data.kind === 'message' && n.data.from === 'owner' && n.data.to === 'ceo' && !n.data.answered).map((n) => ({ path: n.path, id: n.data.id, created: n.data.created, body: n.body }));
  return { since, gathered_at: now.toISOString(), elapsedHours, ownerEdits, finished, mail, analytics, unansweredOwnerMessages };
}

async function ask(deps: HeartbeatDeps, system: string, user: string, maxTokens = 800): Promise<string | null> {
  try {
    const r = await deps.llm.chat({ tier: 'strong', needsTools: false, roleId: 'ceo' }, { messages: [{ role: 'system', content: system }, { role: 'user', content: user }], maxTokens });
    return r.content.trim() || null;
  } catch {
    return null;
  }
}

function ceoSystem(vault: Vault): string {
  const constitution = vault.readTextOrNull('Memory/constitution.md') ?? '';
  const charter = vault.readNoteOrNull('Roles/ceo.md')?.body ?? '';
  const prefs = vault.readTextOrNull('Memory/owner_preferences.md') ?? '';
  const lessons = vault.readTextOrNull('Memory/lessons.md') ?? '';
  return `# Constitution\n${constitution}\n\n# Your charter (CEO)\n${charter}\n\n# Owner preferences\n${prefs}\n\n# Lessons\n${lessons.slice(-3000)}\n\nAnswer in plain markdown, no preamble.`;
}

/**
 * Run or resume a heartbeat job. Each step is checkpointed to the job note (`checkpoint_step` = index of
 * the last completed step + 1). Waiting for `cto.plan` uses `blocked_on: {kind: job}` so a kill during
 * planning resumes at the wait (R33).
 */
export async function runHeartbeat(deps: HeartbeatDeps, jobId: string): Promise<HeartbeatOutcome> {
  const vault = deps.vault;
  const now = deps.now ?? (() => new Date());
  const read = () => readJob(vault, jobId)!;
  let job = read().data;
  if (job.status === 'cancelled') return { status: 'cancelled' };
  const stateRel = `.cubicle/jobs/${jobId}.heartbeat.json`;
  const loadState = (): Partial<Gathered & { planJob?: string; runPath?: string; heartbeatId: string; planPending?: boolean }> => { try { return JSON.parse(vault.readTextOrNull(stateRel) ?? '{}'); } catch { return {}; } };
  const saveState = (s: object) => { const { atomicWriteSync } = require_core(); atomicWriteSync(vault.abs(stateRel), JSON.stringify(s, null, 2)); };
  let state = loadState();
  const hbId = jobId;
  // The vault is the source of truth: recover what the cache may have lost.
  if (!state.planJob) {
    const fromNote = job.blocked_on?.kind === 'job' ? job.blocked_on.id : listJobs(vault).find((j) => j.parent === jobId && j.type === 'cto.plan')?.id;
    if (fromNote) state = { ...state, planJob: fromNote };
  }
  if (!state.runPath) {
    const fromLinks = job.links.find((l) => l.startsWith('[[Runs/'))?.replace(/^\[\[|\]\]$/g, '');
    if (fromLinks) state = { ...state, runPath: fromLinks.endsWith('.md') ? fromLinks : fromLinks + '.md' };
  }
  if (!state.heartbeatId) { state = { ...state, heartbeatId: hbId }; saveState(state); }

  if (job.status !== 'running') {
    updateJob(vault, jobId, { status: 'running' }, 'ceo', `- ${nowIso()}: heartbeat ${job.checkpoint_step > 0 ? 'resumed' : 'started'} at step ${job.checkpoint_step}`);
    if (job.checkpoint_step === 0) vault.events.emit({ type: 'heartbeat.started', agent: 'ceo', job: jobId, payload: { trigger: job.title } });
  }
  const done = (stepIdx: number, note: string) => { updateJob(vault, jobId, { checkpoint_step: stepIdx + 1 }, 'ceo', `- step ${stepIdx + 1} ${HEARTBEAT_STEPS[stepIdx]}: ${note}`); job = read().data; };
  const cancelled = () => read().data.status === 'cancelled';

  if (job.checkpoint_step > 0 && !state.finished) {
    const m = readJob(vault, jobId)?.body.match(/## Plan\s*\n+```json\n([\s\S]*?)\n```/);
    if (m) { try { const f = JSON.parse(m[1]); state = { ...state, since: f.since, gathered_at: f.gathered_at, elapsedHours: f.elapsedHours ?? Infinity, ownerEdits: f.ownerEdits ?? [], finished: f.finished ?? [], mail: [], analytics: f.analytics ?? null, unansweredOwnerMessages: [] }; } catch { /* fall through with defaults */ } }
  }
  for (let i = job.checkpoint_step; i < HEARTBEAT_STEPS.length; i++) {
    if (cancelled()) return { status: 'cancelled' };
    const step = HEARTBEAT_STEPS[i];
    switch (step) {
      case 'gather': {
        const mail = deps.pollInbox ? await deps.pollInbox().catch(() => []) : [];
        const analytics = deps.pullAnalytics ? await deps.pullAnalytics().catch(() => null) : null;
        const g = gather(vault, now(), mail, analytics);
        state = { ...state, ...g }; saveState(state);
        // Persist the gathered facts in the job note so a cache wipe cannot change what later steps see.
        vault.updateNote(`Jobs/${jobId}.md`, (n) => ({ data: n.data, body: setSection(n.body, '## Plan', '```json\n' + JSON.stringify({ since: g.since, gathered_at: g.gathered_at, elapsedHours: Number.isFinite(g.elapsedHours) ? g.elapsedHours : null, ownerEdits: g.ownerEdits, finished: g.finished, mail: g.mail.length, analytics: g.analytics, owner_messages: g.unansweredOwnerMessages.map((m) => m.id) }, null, 2) + '\n```') }), 'ceo', { job: jobId });
        done(i, `elapsed ${Number.isFinite(g.elapsedHours) ? g.elapsedHours.toFixed(1) + 'h' : 'first run'}; ${g.ownerEdits.length} owner edits; ${g.finished.length} jobs finished; ${g.mail.length} mails; ${g.unansweredOwnerMessages.length} owner messages`);
        break;
      }
      case 'reconcile_brand': {
        const touched = (state.ownerEdits ?? []).filter((p) => p.startsWith('Brand/'));
        if (touched.length) {
          const open = listJobs(vault, { status: ['queued', 'running', 'blocked'] }).some((j) => j.type === 'engineer.ship' && /reconcile site with brand/i.test(j.title));
          if (!open) {
            const id = createJob(vault, { type: 'engineer.ship', title: 'Reconcile site with brand', assigned: 'engineer', priority: 2, goal: `The owner edited ${touched.join(', ')}. Read every file in Brand/ and update Site/ so it matches the brand kit. Never revert owner edits under Site/. Finish with the list of files you changed.` }, 'ceo');
            done(i, `owner edited ${touched.join(', ')} → queued ${id}`);
          } else done(i, 'reconcile job already open');
        } else done(i, 'no brand edits');
        break;
      }
      case 'answer_owner': {
        const msgs = state.unansweredOwnerMessages ?? [];
        let answered = 0;
        for (const m of msgs) {
          const note = vault.readNoteOrNull(m.path);
          if (!note || note.data.answered) continue;
          const body = note.body;
          const isFirstIdea = !(parseNote(vault.readTextOrNull('Brand/name.md') ?? '').data.name as string) && !listInbox(vault).some((n) => n.data.kind === 'brand_change' && n.data.target === 'Brand/name.md');
          const surprise = /^\s*#?.*surprise me\s*$/im.test(body) || /\bsurprise me\b/i.test(body.split('\n').slice(-3).join('\n'));
          let reply: string | null = null;
          if (surprise) {
            reply = await ask(deps, ceoSystem(vault), `The owner wants you to surprise them. Propose exactly three one-line business ideas a two-person team can start this week with a static website and email, all free to run. Format: a numbered list "1. <name> — <one sentence>".`);
            const ideas = reply ?? '1. Untitled — (no model available; edit this proposal)\n2. —\n3. —';
            createProposal(vault, { id: idFromKey('prop', `${jobId}:${m.id}`), kind: 'brand_change', from: 'ceo', target: 'Brand/name.md', title: 'Three company ideas — pick one', body: `${ideas}\n\nSet \`chosen: 1|2|3\` and \`approved: true\`; the chosen line's name becomes the company name.`, job: jobId }, 'ceo');
            reply = `I filed three ideas as a proposal in 00 Inbox/. Pick one with \`chosen:\` and \`approved: true\`.\n\n${ideas}`;
          } else if (isFirstIdea) {
            const r = await ask(deps, ceoSystem(vault), `The owner's business idea:\n\n${body}\n\nReply with exactly two lines:\nNAME: <a short, brandable company name>\nTAGLINE: <one sentence>`);
            const name = r?.match(/NAME:\s*(.+)/i)?.[1]?.trim() ?? 'Untitled Co';
            const tagline = r?.match(/TAGLINE:\s*(.+)/i)?.[1]?.trim() ?? '';
            createProposal(vault, { id: idFromKey('prop', `${jobId}:${m.id}`), kind: 'brand_change', from: 'ceo', target: 'Brand/name.md', title: `Name the company: ${name}`, body: `## Proposed content\n\n\`\`\`\n---\nname: "${name.replace(/"/g, "'")}"\ntagline: "${tagline.replace(/"/g, "'")}"\nurl: ""\n---\n# ${name}\n\n${tagline}\n\`\`\`\n\nSet \`approved: true\` to adopt.`, job: jobId }, 'ceo');
            reply = `Got it. I proposed the name **${name}** (${tagline}) in 00 Inbox/ — approve or edit it. The CTO is planning the first jobs now.`;
          } else {
            reply = (await ask(deps, ceoSystem(vault), `The owner wrote:\n\n${body}\n\nReply briefly and concretely. If it is an instruction, say what you will do and enqueue nothing yourself (the CTO plans). If it is a question, answer it.`)) ?? 'Noted. (No model was available to draft a fuller reply; I will act on this next cycle.)';
          }
          // Persist the defaults listInbox derived for an owner-typed note (id/created/from/to) so later ticks see a stable, complete note.
          vault.updateNote(m.path, (n) => ({ data: { ...n.data, id: m.id, created: m.created, from: 'owner', to: 'ceo', answered: true }, body: setSection(n.body, '## CEO', reply!) }), 'ceo', { job: jobId });
          vault.events.emit({ type: 'agent.spoke', agent: 'ceo', job: jobId, payload: { to: 'owner', text: reply!.slice(0, 280), id: m.id } });
          answered++;
        }
        done(i, `${answered} owner message(s) answered`);
        break;
      }
      case 'meeting': {
        // Board meeting only when several jobs failed since last time (Phase 5 wires meeting.open).
        const failed = (state.finished ?? []).filter((f) => f.status === 'failed');
        if (failed.length >= 2 && deps.openMeeting) {
          const id = await deps.openMeeting(`Board meeting: ${failed.length} jobs failed since the last heartbeat (${failed.map((f) => f.title).join('; ')}). Decide what changes.`).catch(() => null);
          done(i, id ? `board meeting ${id}` : 'meeting skipped');
        } else done(i, 'no meeting needed');
        break;
      }
      case 'plan': {
        // Await cto.plan as a sub-job. First visit: create it and block. Second visit: it finished.
        if (!state.planJob) {
          const planCur = vault.readTextOrNull('Plans/plan.md') ?? '';
          const prevArchive = vault.list('Plans/archive', { ext: '.md' }).sort().pop();
          if (planCur.trim() && (!prevArchive || vault.readText(prevArchive) !== planCur)) vault.writeText(`Plans/archive/${stampForFilename(now())}-${hbId.slice(-4)}.md`, planCur, 'ceo', { job: jobId });
          const experiments = vault.list('Experiments', { ext: '.md' }).filter((r) => !r.endsWith('_template.md') && !r.startsWith('Experiments/posts/')).map((r) => ({ r, d: vault.readNoteOrNull(r)?.data as Record<string, unknown> | undefined })).filter((x) => x.d && ['won', 'lost', 'running'].includes(String(x.d.status)));
          const feedback = collectOwnerFeedbackSafe(vault, state.since ?? undefined);
          const summary = [
            `Elapsed since last heartbeat: ${Number.isFinite(state.elapsedHours) ? state.elapsedHours!.toFixed(1) + ' h' : 'first heartbeat'}.`,
            experiments.length ? `Experiments: ${experiments.map((x) => `${String(x.d!.title ?? x.r)} — ${String(x.d!.status)}${x.d!.result ? ` (${String(x.d!.result).slice(0, 80)})` : ''}`).join('; ')}. Adopt winners into the plan; propose Brand/ changes if a winner implies one.` : '',
            feedback.length ? `Owner feedback since last cycle: ${feedback.map((f) => `[${f.role}] ${f.text}`).join(' | ')}.` : '',
            state.ownerEdits?.length ? `Owner edited: ${state.ownerEdits.join(', ')}.` : 'No owner edits.',
            state.finished?.length ? `Jobs finished: ${state.finished.map((f) => `${f.id} (${f.type}, ${f.status}): ${f.summary.slice(0, 120)}`).join('; ')}.` : 'No jobs finished.',
            state.mail?.length ? `Inbound mail: ${state.mail.length}.` : '',
            state.analytics ? `Analytics: ${state.analytics}` : '',
          ].filter(Boolean).join('\n');
          const planJob = createJob(vault, {
            type: 'cto.plan', title: 'Plan this cycle', assigned: 'cto', priority: 1, parent: jobId,
            goal: `Plan the next cycle.\n\nSituation:\n${summary}\n\nDo, in order: (1) vault.read Plans/plan.md, Brand/name.md, Memory/lessons.md and the latest Runs/ note if any; (2) vault.list Jobs to see open work; (3) rewrite Plans/plan.md via vault.write with Objective / This cycle / Next / Risks — concrete, checklist style, under 60 lines; (4) enqueue at most 4 jobs with scheduler.request for engineer/head_of_growth/coo that are each finishable in one sitting (first cycle: an engineer.ship job to scaffold Site/ from Brand/, a research job for head_of_growth to find the first organic channel, nothing outbound); (5) finish with a one-paragraph summary.`,
          }, 'ceo');
          state = { ...state, planJob }; saveState(state);
          updateJob(vault, jobId, { status: 'blocked', blocked_on: { kind: 'job', id: planJob, since: nowIso() } }, 'ceo', `- step ${i + 1} plan: waiting for ${planJob}`);
          vault.events.emit({ type: 'job.blocked', agent: 'ceo', job: jobId, payload: { reason: 'job', id: planJob } });
          return { status: 'blocked', on: { kind: 'job', id: planJob } };
        }
        const sub = readJob(vault, state.planJob);
        const waitedMs = job.blocked_on?.since ? now().getTime() - Date.parse(job.blocked_on.since) : 0;
        if (!sub || !['done', 'failed', 'cancelled'].includes(sub.data.status)) {
          if (waitedMs < PLAN_WAIT_BUDGET_MS) {
            updateJob(vault, jobId, { status: 'blocked', blocked_on: { kind: 'job', id: state.planJob, since: job.blocked_on?.since ?? nowIso() } }, 'ceo');
            return { status: 'blocked', on: { kind: 'job', id: state.planJob } };
          }
          state = { ...state, planPending: true }; saveState(state);
          updateJob(vault, jobId, { status: 'running', blocked_on: undefined }, 'ceo');
          done(i, `cto.plan ${state.planJob} still ${sub?.data.status ?? 'missing'} after ${Math.round(waitedMs / 60000)} min — planning pending`);
          break;
        }
        if (job.status !== 'running') updateJob(vault, jobId, { status: 'running', blocked_on: undefined }, 'ceo');
        done(i, `cto.plan ${state.planJob} ${sub.data.status}`);
        break;
      }
      case 'brief': {
        const runRel = state.runPath ?? `Runs/${stampForFilename(now())}.md`;
        if (!state.runPath) updateJob(vault, jobId, { links: [...job.links, `[[${runRel.replace(/\.md$/, '')}]]`] }, 'ceo');
        const queued = listJobs(vault, { status: 'queued' });
        const blocked = listJobs(vault, { status: 'blocked' }).filter((j) => j.id !== jobId);
        const pending = listInbox(vault).filter((n) => n.data.kind !== 'message' && n.data.approved === null);
        const needsYou = [
          ...pending.map((p) => `- Approve or reject: ${p.body.split('\n')[0].replace(/^#\s*/, '')} (\`${p.path}\`)`),
          ...blocked.filter((j) => j.blocked_on?.kind === 'message').map((j) => `- Answer ${j.assigned}'s question on job ${j.id}`),
        ];
        const facts = [
          `Elapsed: ${Number.isFinite(state.elapsedHours) ? state.elapsedHours!.toFixed(1) + ' h' : 'first heartbeat'}`,
          ...(state.planPending ? ['Planning: PENDING — the CTO has not finished planning this cycle; the previous plan stands.'] : []),
          `Owner edits: ${state.ownerEdits?.length ? state.ownerEdits.join(', ') : 'none'}`,
          `Finished jobs: ${state.finished?.length ? state.finished.map((f) => `${f.title} (${f.status})`).join('; ') : 'none'}`,
          `Queued next: ${queued.map((j) => `${j.assigned}: ${j.title}`).join('; ') || 'nothing'}`,
          `Blocked: ${blocked.map((j) => `${j.id} on ${j.blocked_on?.kind ?? '?'}`).join('; ') || 'none'}`,
          `Needs owner: ${needsYou.length ? needsYou.join(' | ') : 'nothing'}`,
          `Plan: ${(vault.readTextOrNull('Plans/plan.md') ?? '').slice(0, 1500)}`,
        ].join('\n');
        let drafted = await ask(deps, ceoSystem(vault), `Write the owner's "since you were away" brief from these facts, under 200 words, three sections: ## What happened, ## What's next, ## What needs you. Bullet points only. Do not invent anything not in the facts.\n\n${facts}`, 1200);
        if (drafted && !(/## What happened/.test(drafted) && /## What'?s next/.test(drafted) && /## What needs you/.test(drafted) && drafted.trim().length > 80)) drafted = null; // truncated or malformed → template
        const fallback = `## What happened\n- ${state.finished?.length ? state.finished.map((f) => `${f.title}: ${f.status}`).join('\n- ') : 'Nothing finished since the last heartbeat.'}\n\n## What's next\n- ${queued.length ? queued.map((j) => `${j.assigned}: ${j.title}`).join('\n- ') : 'Waiting on the plan.'}\n\n## What needs you\n${needsYou.length ? needsYou.join('\n') : '- Nothing right now.'}`;
        const content = stringifyNote({ heartbeat: hbId, at: nowIso(), elapsed_hours: Number.isFinite(state.elapsedHours) ? Number(state.elapsedHours!.toFixed(1)) : null, trigger: job.title }, `# Since you were away\n\n${drafted ?? fallback}\n\n---\n_Facts used:_\n\n\`\`\`\n${facts}\n\`\`\`\n`);
        vault.writeText(runRel, content, 'ceo', { job: jobId });
        state = { ...state, runPath: runRel }; saveState(state);
        writeQueueMd(vault);
        if (deps.router) vault.writeText('Metrics/quota.md', renderQuotaMarkdown(deps.router.quotaSnapshot(), now()), 'daemon', { silent: true });
        done(i, `wrote ${runRel}`);
        break;
      }
      case 'commit': {
        let commitNote = 'nothing to commit';
        const hash = await autoCommit(vault.root, `cubicle: heartbeat ${hbId}`).catch((e) => { commitNote = `COMMIT FAILED: ${String((e as Error).message ?? e).slice(0, 160)}`; vault.events.emit({ type: 'daemon.warning', payload: { where: 'heartbeat.commit', message: String(e) } }); return null; });
        updateJob(vault, jobId, { status: 'done', checkpoint_step: HEARTBEAT_STEPS.length }, 'ceo', `- step ${i + 1} commit: ${hash ?? commitNote}`);
        vault.events.emit({ type: 'job.done', agent: 'ceo', job: jobId, payload: { type: 'ceo.heartbeat', summary: `heartbeat ${hbId}` } });
        vault.events.emit({ type: 'heartbeat.completed', agent: 'ceo', job: jobId, payload: { id: hbId, commit: hash, run: state.runPath, trigger: job.title, gathered_at: state.gathered_at ?? nowIso() } });
        return { status: 'done' };
      }
    }
  }
  return { status: 'done' };
}

import * as core from '@cubicle/core';
function require_core() { return core; }
export type { JobFrontmatter, CubicleEvent };
