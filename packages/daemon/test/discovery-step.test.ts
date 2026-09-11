import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, loadOrg, listJobs, listInbox, readJob, writeIdeaCard, updateIdea, INTERVIEW_PATH, interviewPhase, DISCOVERY_INBOX } from '@cubicle/core';
import { discoveryStatus, ideasNeedingEstimate, MAX_ESTIMATES_PER_CYCLE, discoveryGoal, estimateGoal, askInterview, captureInterviewAnswer, ownerPrompt, enqueueDiscovery, enqueueEstimates } from '../src/discovery.js';

const base = { hasBrief: false, briefProposalOpen: false, inputs: 0, interview: 'none' as const, longPrompt: false, alreadyRun: false };
const NOW = new Date('2026-09-11T10:00:00.000Z');

describe('what the discovery step does this cycle (spec §1, §5)', () => {
  it('asks the interview when the vault holds nothing to read', () => {
    expect(discoveryStatus(base)).toMatchObject({ run: false, ask: true });
  });

  it('waits, silently, while the interview is out', () => {
    expect(discoveryStatus({ ...base, interview: 'asked' })).toMatchObject({ run: false, ask: false });
    expect(discoveryStatus({ ...base, interview: 'asked' }).why).toContain('waiting for an answer');
  });

  it('runs on any one of the three inputs, and never asks the interview as well', () => {
    for (const material of [{ inputs: 2 }, { longPrompt: true }, { interview: 'answered' as const }]) {
      expect(discoveryStatus({ ...base, ...material })).toMatchObject({ run: true, ask: false });
    }
  });

  it('runs from the vault when the owner skips the interview rather than stalling for ever', () => {
    expect(discoveryStatus({ ...base, interview: 'skipped' })).toMatchObject({ run: true, ask: false });
    expect(discoveryStatus({ ...base, interview: 'skipped', alreadyRun: true })).toMatchObject({ run: false, ask: false });
  });

  it('never queues twice for the same material', () => {
    expect(discoveryStatus({ ...base, inputs: 2, alreadyRun: true })).toMatchObject({ run: false, ask: false });
    expect(discoveryStatus({ ...base, inputs: 2, alreadyRun: true }).why).toContain('already read this material');
  });

  it('stops while a brief is waiting for the owner, whatever else arrived', () => {
    expect(discoveryStatus({ ...base, inputs: 5, longPrompt: true, briefProposalOpen: true })).toMatchObject({ run: false, ask: false });
  });

  it('with a brief adopted, only new material runs discovery again', () => {
    expect(discoveryStatus({ ...base, hasBrief: true })).toMatchObject({ run: false, ask: false });
    expect(discoveryStatus({ ...base, hasBrief: true, interview: 'skipped' })).toMatchObject({ run: false, ask: false });
    expect(discoveryStatus({ ...base, hasBrief: true, inputs: 1 })).toMatchObject({ run: true, ask: false });
    expect(discoveryStatus({ ...base, hasBrief: true, inputs: 1 }).why).toContain('new material');
  });
});

describe('who gets priced this cycle (spec §5.3)', () => {
  const idea = (id: string, over: Partial<{ decision: string; estimate: string; score_inputs: Record<string, number> }> = {}) =>
    ({ id, decision: 'undecided', estimate: '', score_inputs: {}, ...over }) as { id: string; decision: string; estimate: string; score_inputs: { value?: number; effort?: number; evidence?: number } };

  it('asks for at most three, best-evidenced first, and skips what is already priced or decided', () => {
    const ideas = [
      idea('a', { score_inputs: { evidence: 2 } }),
      idea('b', { score_inputs: { evidence: 5 } }),
      idea('c', { score_inputs: { evidence: 4 } }),
      idea('d', { score_inputs: { evidence: 5, value: 4, effort: 4 } }),   // already priced
      idea('e', { decision: 'scrap', score_inputs: { evidence: 5 } }),     // already decided
      idea('f', { score_inputs: { evidence: 3 } }),
    ];
    expect(ideasNeedingEstimate(ideas).map((i) => i.id)).toEqual(['b', 'c', 'f']);
    expect(MAX_ESTIMATES_PER_CYCLE).toBe(3);
    expect(ideasNeedingEstimate(ideas, 1).map((i) => i.id)).toEqual(['b']);
    expect(ideasNeedingEstimate([])).toEqual([]);
  });

  it('a half-priced card still counts as needing the finance office', () => {
    expect(ideasNeedingEstimate([idea('a', { score_inputs: { value: 4 } })]).map((i) => i.id)).toEqual(['a']);
  });
});

describe('the two job briefs', () => {
  it('tells discovery which tools, in which order, and what the brief must contain', () => {
    const g = discoveryGoal({ founderBrief: 'Memory/founder-brief.md', briefTemplate: '## What the company is\n\n…', hasBrief: false, research: 'ceo' });
    expect(g).toContain('discovery.inputs');
    expect(g.indexOf('discovery.inputs')).toBeLessThan(g.indexOf('research.start'));
    expect(g.indexOf('research.start')).toBeLessThan(g.indexOf('idea.card'));
    expect(g).toContain('kind: founder_brief');
    expect(g).toContain('Memory/founder-brief.md');
    expect(g).toContain('## What the company is');
    expect(g).toContain('cites the file it came from');
    expect(g).toContain('Do not price anything');
  });

  it('asks for an edit, not a second brief, once one is adopted', () => {
    const g = discoveryGoal({ founderBrief: 'Memory/founder-brief.md', briefTemplate: 'x', hasBrief: true, research: 'ceo' });
    expect(g).toContain('never a second brief');
    expect(g).toContain('new material');
  });

  it('asks the finance office for two numbers and an order of magnitude, and nothing about a ledger', () => {
    const g = estimateGoal({ id: 'meal-kits', title: 'Meal kits for nurseries' });
    expect(g).toContain('[[Ideas/meal-kits]]');
    expect(g).toContain('slug: "meal-kits"');
    expect(g).toContain('inverted');
    expect(g).toContain('rough order of magnitude');
    expect(g).toContain('do not touch the ledger');
  });
});

describe('the interview and the two fan-outs, against a real vault', () => {
  let dir: string;
  let vault: Vault;
  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'cubicle-sp3-disc-'));
    vault = (await scaffoldVault(dir)).vault;
  });
  afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

  const ownerSays = (text: string, at = '2026-09-11T09:00:00.000Z') =>
    vault.writeText(`00 Inbox/${at.slice(0, 10)}-msg-${Math.random().toString(16).slice(2, 8)}.md`, `---\nid: msg_${Math.random().toString(16).slice(2, 8)}\nkind: message\nfrom: owner\nto: ceo\ncreated: ${at}\n---\n# x\n\n${text}\n`, 'owner');

  it('asks once, writes the transcript, and sends the owner one message', () => {
    const id = askInterview(vault, 'ceo', NOW);
    expect(id).not.toBeNull();
    expect(interviewPhase(vault.readTextOrNull(INTERVIEW_PATH))).toBe('asked');
    const msg = listInbox(vault).find((n) => n.data.kind === 'message' && n.data.from === 'ceo');
    expect(msg!.body).toMatch(/six questions/);
    expect(askInterview(vault, 'ceo', NOW)).toBeNull();       // never twice
  });

  it('closes the interview with the owner\'s next message, whatever it says', () => {
    askInterview(vault, 'ceo', NOW);
    expect(captureInterviewAnswer(vault, 'We sell meal kits to nurseries.', NOW)).toBe(true);
    expect(interviewPhase(vault.readTextOrNull(INTERVIEW_PATH))).toBe('answered');
    expect(vault.readText(INTERVIEW_PATH)).toContain('meal kits to nurseries');
    expect(captureInterviewAnswer(vault, 'and another thing', NOW)).toBe(false);   // already closed
  });

  it('records a skip as a skip', () => {
    askInterview(vault, 'ceo', NOW);
    captureInterviewAnswer(vault, 'skip', NOW);
    expect(interviewPhase(vault.readTextOrNull(INTERVIEW_PATH))).toBe('skipped');
  });

  it('reads the owner prompt out of the cabin, newest last', () => {
    ownerSays('First thought.', '2026-09-11T08:00:00.000Z');
    ownerSays('Second thought.', '2026-09-11T09:00:00.000Z');
    expect(ownerPrompt(vault)).toContain('First thought.');
    expect(ownerPrompt(vault).indexOf('First')).toBeLessThan(ownerPrompt(vault).indexOf('Second'));
  });

  it('queues one discovery job per set of material, never two for the same', () => {
    vault.writeText(`${DISCOVERY_INBOX}/pitch.md`, 'We sell meal kits.', 'owner');
    const org = loadOrg(vault);
    const id = enqueueDiscovery(vault, org)!;
    expect(id).toBeTruthy();
    const job = readJob(vault, id)!;
    expect(job.data.type).toBe('discovery');
    expect(job.data.assigned).toBe('research_manager');   // the research office, by office lookup
    expect(job.data.for).toBe('ceo');
    expect(job.data.priority).toBe(1);
    expect(enqueueDiscovery(vault, org)).toBeNull();          // same digest, same id, already there
    vault.writeText(`${DISCOVERY_INBOX}/more.md`, 'And to schools.', 'owner');
    expect(enqueueDiscovery(vault, org)).not.toBeNull();      // new material, one more job
    expect(listJobs(vault).filter((j) => j.type === 'discovery').length).toBe(2);
  });

  it('queues at most three estimates, to the finance office, once each', () => {
    for (const t of ['Alpha', 'Beta', 'Gamma', 'Delta']) {
      const slug = writeIdeaCard(vault, { title: t, source: 'discovery' }, 'research_manager');
      updateIdea(vault, slug, { score_inputs: { evidence: 4, fit: 3 } }, 'research_manager');
    }
    const org = loadOrg(vault);
    const ids = enqueueEstimates(vault, org);
    expect(ids.length).toBe(3);
    expect(readJob(vault, ids[0])!.data.assigned).toBe('cfo');
    expect(readJob(vault, ids[0])!.data.type).toBe('finance.estimate');
    expect(enqueueEstimates(vault, org)).toEqual([]);         // the open jobs cover those cards
  });
});
