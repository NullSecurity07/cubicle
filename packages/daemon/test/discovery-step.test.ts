import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, loadOrg, createJob, createProposal, listJobs, listInbox, readJob, writeIdeaCard, updateIdea, missingRequestFields, INTERVIEW_PATH, interviewPhase, DISCOVERY_INBOX } from '@cubicle/core';
import { discoveryStatus, ideasNeedingEstimate, ideasNeedingResearch, MAX_ESTIMATES_PER_CYCLE, discoveryGoal, estimateGoal, askInterview, captureInterviewAnswer, ownerPrompt, enqueueDiscovery, enqueueEstimates, enqueueResearchHalf, researchJobId, briefProposalOpen, currentDiscoveryStatus, interviewMessageId, estimateJobId, lastDiscoveryAt, openDiscoveryJob } from '../src/discovery.js';

/** Nothing dropped in, nothing typed, nobody asked, discovery has never run. */
const nothing = { newInput: false, newInterview: false, longPrompt: false, anyPrompt: false };
const base = { hasBrief: false, briefProposalOpen: false, inputs: 0, interview: 'none' as const, unread: nothing, everRun: false, alreadyRun: false, ranToday: false };
/** The vault after a discovery job has run: `everRun`, and (unless a test says otherwise) it ran today. */
const after = { ...base, everRun: true, ranToday: true };
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
    for (const material of [{ inputs: 2, unread: { ...nothing, newInput: true } }, { unread: { ...nothing, longPrompt: true, anyPrompt: true } }, { interview: 'answered' as const, unread: { ...nothing, newInterview: true } }]) {
      expect(discoveryStatus({ ...base, ...material })).toMatchObject({ run: true, ask: false });
    }
  });

  // The headline requirement (spec §1.3, §1.8, §5.5): "the owner types one line, the CEO proposes a name, and
  // discovery still runs over that line". Asking costs no model call, so the two are not alternatives — and
  // read as alternatives, a one-line company waited for an interview answer for ever and never planned at all.
  it('asks AND reads when the owner has typed one short line', () => {
    const oneLine = { ...base, unread: { ...nothing, anyPrompt: true } };
    expect(discoveryStatus(oneLine)).toMatchObject({ run: true, ask: true });
    expect(discoveryStatus(oneLine).why).toContain('asking the interview as well');
    // A document is not interviewed about: the owner already wrote the answers down.
    expect(discoveryStatus({ ...base, unread: { ...nothing, anyPrompt: true, longPrompt: true } })).toMatchObject({ run: true, ask: false });
    // Nor is an owner who dropped a file.
    expect(discoveryStatus({ ...base, inputs: 1, unread: { ...nothing, newInput: true } })).toMatchObject({ run: true, ask: false });
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
    expect(discoveryStatus({ ...base, inputs: 5, unread: { ...nothing, newInput: true, longPrompt: true, anyPrompt: true }, briefProposalOpen: true })).toMatchObject({ run: false, ask: false });
  });

  // C2: every owner message used to move the digest, so chatting with the CEO five times in a day bought five
  // research lifecycles, five `requester.review` gates and five founder-brief edit proposals — each of which
  // the heartbeat blocked on. A reply is not material.
  it('does not buy a research job for a "thanks" typed after discovery has read the vault', () => {
    const chat = { ...after, unread: { ...nothing, anyPrompt: true } };
    expect(discoveryStatus(chat)).toMatchObject({ run: false });
    expect(discoveryStatus(chat).why).toContain('a reply to the CEO is not material');
    expect(discoveryStatus({ ...after, unread: nothing })).toMatchObject({ run: false });
  });

  it('re-runs only for a substantive increment: a new file, a newly answered interview, or a document', () => {
    for (const inc of [{ newInput: true }, { newInterview: true }, { longPrompt: true, anyPrompt: true }]) {
      expect(discoveryStatus({ ...after, ranToday: false, unread: { ...nothing, ...inc } })).toMatchObject({ run: true });
    }
  });

  // The floor guards against *typing*: a long message is the one increment an owner can produce over and over
  // in an afternoon, and each one costs a research lifecycle. A dropped file and an answered interview are not
  // that, and holding them to tomorrow would defer the best material the company ever gets (re-review 1).
  it('floors a second typed document a day, and nothing else', () => {
    const typed = { ...nothing, longPrompt: true, anyPrompt: true };
    expect(discoveryStatus({ ...after, ranToday: true, unread: typed })).toMatchObject({ run: false });
    expect(discoveryStatus({ ...after, ranToday: true, unread: typed }).why).toContain('already read a document you typed today');
    expect(discoveryStatus({ ...after, ranToday: false, unread: typed })).toMatchObject({ run: true });
    // A file dropped in, and the interview answered, run the same day whatever else has been read.
    expect(discoveryStatus({ ...after, ranToday: true, inputs: 1, unread: { ...nothing, newInput: true } })).toMatchObject({ run: true });
    expect(discoveryStatus({ ...after, ranToday: true, interview: 'answered', unread: { ...nothing, newInterview: true } })).toMatchObject({ run: true });
    // Even alongside a typed message that would have been floored on its own.
    expect(discoveryStatus({ ...after, ranToday: true, interview: 'answered', unread: { ...nothing, newInterview: true, longPrompt: true, anyPrompt: true } })).toMatchObject({ run: true });
    // The first run is not floored either: a company that started this morning reads this morning.
    expect(discoveryStatus({ ...base, ranToday: true, unread: typed })).toMatchObject({ run: true });
  });

  it('with a brief adopted, only new material runs discovery again', () => {
    expect(discoveryStatus({ ...after, hasBrief: true })).toMatchObject({ run: false, ask: false });
    expect(discoveryStatus({ ...after, hasBrief: true }).why).toContain('the founder brief covers everything');
    expect(discoveryStatus({ ...after, hasBrief: true, interview: 'skipped' })).toMatchObject({ run: false, ask: false });
    const more = { ...after, hasBrief: true, ranToday: false, inputs: 1, unread: { ...nothing, newInput: true } };
    expect(discoveryStatus(more)).toMatchObject({ run: true, ask: false });
    expect(discoveryStatus(more).why).toContain('new material');
  });
});

describe('who gets priced this cycle (spec §5.3)', () => {
  const idea = (id: string, over: Partial<{ decision: string; estimate: string; score_inputs: Record<string, number> }> = {}) =>
    ({ id, decision: 'undecided', estimate: '', score_inputs: {}, ...over }) as { id: string; decision: string; estimate: string; score_inputs: { value?: number; effort?: number; evidence?: number; fit?: number } };

  it('prices a card whose estimate prose is filled in but whose numbers are not', () => {
    expect(ideasNeedingEstimate([idea('a', { estimate: 'a few weeks and a laptop' })]).map((i) => i.id)).toEqual(['a']);
  });

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

  it('picks the cards missing the research half the same way, best-priced first', () => {
    const ideas = [
      idea('a', { score_inputs: { value: 2 } }),
      idea('b', { score_inputs: { value: 5 } }),
      idea('c', { score_inputs: { value: 4, evidence: 4 } }),                    // half-researched still counts
      idea('d', { score_inputs: { value: 5, evidence: 4, fit: 3 } }),            // already researched
      idea('e', { decision: 'park', score_inputs: { value: 5 } }),               // already decided
    ];
    expect(ideasNeedingResearch(ideas).map((i) => i.id)).toEqual(['b', 'c', 'a']);
    expect(ideasNeedingResearch(ideas, 1).map((i) => i.id)).toEqual(['b']);
    expect(ideasNeedingResearch([])).toEqual([]);
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
    expect(msg!.body).toMatch(/[Ss]ix questions/);
    expect(askInterview(vault, 'ceo', NOW)).toBeNull();       // never twice
  });

  it('closes the interview with the owner\'s next message, whatever it says', () => {
    askInterview(vault, 'ceo', NOW);
    expect(captureInterviewAnswer(vault, 'We sell meal kits to nurseries.', NOW)).toBe(true);
    expect(interviewPhase(vault.readTextOrNull(INTERVIEW_PATH))).toBe('answered');
    expect(vault.readText(INTERVIEW_PATH)).toContain('meal kits to nurseries');
    expect(captureInterviewAnswer(vault, 'and another thing', NOW)).toBe(false);   // already closed
  });

  it('resumes a kill between the message and the transcript without asking twice', () => {
    // The message is written first, so this is exactly the vault a crash in between leaves behind.
    createProposal(vault, {
      id: interviewMessageId('ceo'), kind: 'message', from: 'ceo', to: 'owner',
      title: 'Six questions, while I get started', body: 'Six questions, to make sure I start from the right thing.',
    }, 'ceo');
    expect(vault.readTextOrNull(INTERVIEW_PATH)).toBeNull();

    expect(askInterview(vault, 'ceo', NOW)).toBeNull();                         // no second message
    expect(interviewPhase(vault.readTextOrNull(INTERVIEW_PATH))).toBe('asked'); // the transcript is finished
    expect(listInbox(vault).filter((n) => n.data.id === interviewMessageId('ceo')).length).toBe(1);
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

  it('reads the owner\'s half of a message, never the CEO\'s reply', () => {
    vault.writeText('00 Inbox/2026-09-11-msg-aa.md', `---\nid: msg_aa\nkind: message\nfrom: owner\nto: ceo\ncreated: 2026-09-11T08:00:00.000Z\n---\n# x\n\nMeal kits.\n\n## CEO\n\nGot it, I proposed PlateReady.\n`, 'owner');
    expect(ownerPrompt(vault)).toBe('Meal kits.');
  });

  it('strips only the title line, so an owner\'s own heading survives', () => {
    vault.writeText('00 Inbox/2026-09-11-msg-bb.md', `---\nid: msg_bb\nkind: message\nfrom: owner\nto: ceo\ncreated: 2026-09-11T08:00:00.000Z\n---\n# x\n\nMeal kits.\n\n# The plan\n\nSchools next.\n`, 'owner');
    expect(ownerPrompt(vault)).toContain('# The plan');
    expect(ownerPrompt(vault).startsWith('Meal kits.')).toBe(true);
  });

  it('stops while a founder brief is waiting for the owner', () => {
    vault.writeText(`${DISCOVERY_INBOX}/pitch.md`, 'We sell meal kits.', 'owner');
    expect(briefProposalOpen(vault)).toBe(false);
    expect(currentDiscoveryStatus(vault).run).toBe(true);

    createProposal(vault, { kind: 'founder_brief', from: 'research_manager', title: 'The brief', body: 'x' }, 'research_manager');
    expect(briefProposalOpen(vault)).toBe(true);
    expect(currentDiscoveryStatus(vault).run).toBe(false);
    expect(currentDiscoveryStatus(vault).why).toContain('waiting for your verdict');
    expect(enqueueDiscovery(vault, loadOrg(vault))).toBeNull();
  });

  /** Back-date a job note so "discovery ran today" is false — the day floor's only input. */
  const ranYesterday = (id: string) => {
    const at = new Date(Date.now() - 86_400_000).toISOString();
    vault.updateNote(`Jobs/${id}.md`, (n) => ({ data: { ...n.data, created: at }, body: n.body }), 'daemon');
  };

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
    // It orders `research.start`, so it has to carry the request that tool scaffolds the project from.
    expect(missingRequestFields(job.data.research)).toEqual([]);
    expect(job.data.research!.decision_owner).toBe('ceo');
    expect(enqueueDiscovery(vault, org)).toBeNull();          // same digest, same id, already there
    vault.writeText(`${DISCOVERY_INBOX}/more.md`, 'And to schools.', 'owner');
    expect(enqueueDiscovery(vault, org)).not.toBeNull();      // a file is material: one more job, today
    expect(listJobs(vault).filter((j) => j.type === 'discovery').length).toBe(2);
    expect(enqueueDiscovery(vault, org)).toBeNull();          // and still only one per set of material
  });

  // C2, against a real vault: what the digest is fed, and what a re-run costs.
  it('reads one short line on the first cycle, and a "thanks" after that costs nothing', () => {
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
    ownerSays('Meal kits for nurseries.', ago(60_000));
    const org = loadOrg(vault);
    const first = currentDiscoveryStatus(vault);
    // One line: read it *and* ask the six questions (spec §5.5).
    expect(first).toMatchObject({ run: true, ask: true });
    const id = enqueueDiscovery(vault, org, first)!;
    expect(id).toBeTruthy();

    ownerSays('thanks!', new Date(Date.now() + 60_000).toISOString());
    expect(currentDiscoveryStatus(vault).run).toBe(false);
    expect(enqueueDiscovery(vault, org)).toBeNull();
    // The line discovery has read is out of the digest; only the unread reply is in it, and a reply is not
    // material — so nothing can re-queue a research lifecycle on it.
    const since = lastDiscoveryAt(vault);
    expect(ownerPrompt(vault, since)).not.toContain('Meal kits');
    expect(ownerPrompt(vault, since)).toContain('thanks');
    expect(listJobs(vault).filter((j) => j.type === 'discovery')).toHaveLength(1);
    ranYesterday(id);   // so nothing below is refused merely by the day floor

    // A file is material: it queues exactly one more.
    vault.writeText(`${DISCOVERY_INBOX}/pitch.md`, 'We sell meal kits to nurseries. Two already pay us.', 'owner');
    expect(currentDiscoveryStatus(vault).run).toBe(true);
    expect(enqueueDiscovery(vault, org)).not.toBeNull();
    expect(listJobs(vault).filter((j) => j.type === 'discovery')).toHaveLength(2);
    // A second *typed* document the same day is what the floor is for: the one increment an owner can produce
    // over and over in an afternoon, at a research lifecycle each.
    ownerSays(['We are opening in schools too.', 'The buyer there is the catering manager.', 'Two counties have asked.', 'We have no price for it.', 'Nobody knows whether the kitchens will cook it.'].join('\n'), new Date(Date.now() + 120_000).toISOString());
    expect(currentDiscoveryStatus(vault).run).toBe(false);
    expect(currentDiscoveryStatus(vault).why).toContain('already read a document you typed today');
    expect(enqueueDiscovery(vault, org)).toBeNull();
    expect(listJobs(vault).filter((j) => j.type === 'discovery')).toHaveLength(2);
  });

  // Ruling 1, against a real vault: the day the company starts is the day it is given the most, and none of it
  // waits for tomorrow. One line at 09:00, the interview answered at 09:30, "thanks" at 10:00, a file at 10:30.
  it('reads the interview answer and a dropped file on the same day it read the first line', () => {
    const org = loadOrg(vault);
    const at = (h: number, m: number) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.toISOString(); };

    ownerSays('Meal kits for nurseries.', at(9, 0));
    expect(enqueueDiscovery(vault, org, currentDiscoveryStatus(vault))).toBeTruthy();
    expect(listJobs(vault).filter((j) => j.type === 'discovery')).toHaveLength(1);

    // 09:30 — the owner answers the six questions. The richest material there is, and it is read today.
    askInterview(vault, 'ceo', NOW);
    captureInterviewAnswer(vault, 'Nurseries, not parents. Two already pay us. Ten in three months.', new Date());
    const answered = currentDiscoveryStatus(vault);
    expect(answered.run).toBe(true);
    expect(enqueueDiscovery(vault, org, answered)).toBeTruthy();
    expect(listJobs(vault).filter((j) => j.type === 'discovery')).toHaveLength(2);

    // 10:00 — "thanks" is still not material, floor or no floor.
    ownerSays('thanks!', at(10, 0));
    expect(currentDiscoveryStatus(vault).run).toBe(false);
    expect(enqueueDiscovery(vault, org)).toBeNull();
    expect(listJobs(vault).filter((j) => j.type === 'discovery')).toHaveLength(2);

    // 10:30 — a file dropped in is a deliberate act, and it is read today too.
    vault.writeText(`${DISCOVERY_INBOX}/pitch.md`, 'The whole pitch deck, as text.', 'owner');
    expect(currentDiscoveryStatus(vault).run).toBe(true);
    expect(enqueueDiscovery(vault, org)).toBeTruthy();
    expect(listJobs(vault).filter((j) => j.type === 'discovery')).toHaveLength(3);
  });

  it('a long prompt typed after the brief is material; a short one is not', () => {
    const org = loadOrg(vault);
    vault.writeText(`${DISCOVERY_INBOX}/pitch.md`, 'We sell meal kits.', 'owner');
    ranYesterday(enqueueDiscovery(vault, org)!);
    // An hour ago, not a fixed timestamp: `ranYesterday` back-dates the job by exactly 24 h from *now*, so a
    // literal "2026-09-11T13:00Z" stopped being "after the last run" the moment the clock passed 13:00 UTC —
    // and this case then failed for the rest of every day, on nothing but the time it was run.
    ownerSays(['We are also opening in schools.', 'The buyer there is the catering manager.', 'Two counties have asked.', 'We have no price for it yet.', 'What we do not know is whether the kitchens will cook it.'].join('\n'), new Date(Date.now() - 3_600_000).toISOString());
    expect(currentDiscoveryStatus(vault)).toMatchObject({ run: true });
    expect(currentDiscoveryStatus(vault).why).toContain('new material');
  });

  it('queues at most three estimates, to the finance office, once each', () => {
    const slugs = ['Alpha', 'Beta', 'Gamma', 'Delta'].map((t) => {
      const slug = writeIdeaCard(vault, { title: t, source: 'discovery' }, 'research_manager');
      updateIdea(vault, slug, { score_inputs: { evidence: 4, fit: 3 } }, 'research_manager');
      return slug;
    });
    const org = loadOrg(vault);
    const ids = enqueueEstimates(vault, org);
    expect(ids.length).toBe(MAX_ESTIMATES_PER_CYCLE);
    expect(readJob(vault, ids[0])!.data.assigned).toBe('cfo');
    expect(readJob(vault, ids[0])!.data.type).toBe('finance.estimate');
    // The cap holds back new work for one cycle, it does not retire a card: the fourth is queued next cycle,
    // and no card is ever asked for twice.
    const rest = slugs.map(estimateJobId).filter((id) => !ids.includes(id));
    expect(enqueueEstimates(vault, org)).toEqual(rest);
    expect(enqueueEstimates(vault, org)).toEqual([]);
    expect(listJobs(vault).filter((j) => j.type === 'finance.estimate').length).toBe(slugs.length);
  });

  it('never lets three stalled estimate jobs starve the fourth card', () => {
    const slugs = ['Alpha', 'Beta', 'Gamma', 'Delta'].map((t) => {
      const slug = writeIdeaCard(vault, { title: t, source: 'discovery' }, 'research_manager');
      updateIdea(vault, slug, { score_inputs: { evidence: 4, fit: 3 } }, 'research_manager');
      return slug;
    });
    // Three cards already have an estimate job that will never finish. Capping before this check would
    // hand them all three slots every cycle, for ever, and the fourth would never be priced.
    for (const slug of slugs.slice(0, 3)) {
      createJob(vault, { id: estimateJobId(slug), type: 'finance.estimate', title: 'stalled', assigned: 'cfo', goal: 'x' }, 'daemon');
    }
    const ids = enqueueEstimates(vault, loadOrg(vault));
    expect(ids).toEqual([estimateJobId(slugs[3])]);
  });

  // I2: `nextIdeaForBoard` needs all four inputs, and until now only the finance half had a producer — every
  // card an intelligence sweep filed was unscorable for ever, sat in `Ideas/` unreported, and still cost the
  // cycle an estimate job and up to an hour of `ideas_board` waiting.
  it('asks the research office for the other half, capped and assigned the same way', () => {
    const priced = writeIdeaCard(vault, { title: 'Priced but unresearched', source: 'intelligence:competitive' }, 'intelligence_analyst');
    updateIdea(vault, priced, { score_inputs: { value: 4, effort: 4 } }, 'cfo');
    const bare = writeIdeaCard(vault, { title: 'A bare hunch', source: 'owner' }, 'ceo');
    const whole = writeIdeaCard(vault, { title: 'Fully answered', source: 'discovery' }, 'research_manager');
    updateIdea(vault, whole, { score_inputs: { value: 4, effort: 4, evidence: 4, fit: 4 } }, 'research_manager');

    const org = loadOrg(vault);
    const ids = enqueueResearchHalf(vault, org);
    // The scored card is left alone; the two half-answered ones are asked about, best-priced first.
    expect(ids).toEqual([researchJobId(priced), researchJobId(bare)]);
    const job = readJob(vault, ids[0])!;
    expect(job.data.type).toBe('research');
    expect(job.data.assigned).toBe('research_manager');   // the research office, by office lookup
    expect(job.data.for).toBe('ceo');
    // It orders `research.start`, so the scheduler's own rule has to accept the request it carries.
    expect(missingRequestFields(job.data.research)).toEqual([]);
    expect(job.body).toContain('evidence');
    expect(job.body).toContain('fit');
    expect(job.body).toContain('confidence');
    expect(job.body).toContain(`slug: "${priced}"`);
    expect(job.body).toContain('Do not price it');
    // One per card, ever: a replayed cycle re-finds the job it already asked for.
    expect(enqueueResearchHalf(vault, org)).toEqual([]);
  });

  it('never lets three stalled research jobs starve the fourth card', () => {
    const slugs = ['Alpha', 'Beta', 'Gamma', 'Delta'].map((t) => writeIdeaCard(vault, { title: t, source: 'discovery' }, 'research_manager'));
    for (const slug of slugs.slice(0, 3)) {
      createJob(vault, { id: researchJobId(slug), type: 'research', title: 'stalled', assigned: 'research_manager', goal: 'x' }, 'daemon');
    }
    expect(enqueueResearchHalf(vault, loadOrg(vault))).toEqual([researchJobId(slugs[3])]);
  });
});
