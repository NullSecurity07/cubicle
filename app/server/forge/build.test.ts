import { describe, expect, it } from 'vitest';
import type { ForgeMode, Proposal } from '../../shared/forge.ts';
import type { Case } from '../../shared/frameworks.ts';
import { todayBlock } from '../prompt.ts';
import type { Judge } from '../evals/score.ts';
import { beats, best, briefHash, briefMessages, buildTeam, runOf, scorecardOf, scratchStage, withWinners, type Attempt } from './build.ts';

const kase = (id: string): Case => ({ id, keys: ['one'], input: `What about ${id}?`, rubric: 'The notes\' own criteria.', addedBy: 'forge' });
const proposal = (): Proposal => ({
  name: 'Forged team',
  rooms: [{ key: 'one', name: 'Ana', role: 'Assumption finder', accent: '#ee8a72', brief: 'the first brief' }],
  docs: [{ key: 'working', title: 'Working notes', text: '# Working notes\n' }],
  cards: [], wires: [{ from: 'one', to: 'working' }],
  dataset: [kase('first'), kase('second')],
});

// A build with the three costly things stubbed: a person answers with the brief it was given, so a judge can tell
// which candidate it is scoring, and the judge scores from a table this test writes.
function harness(marks: Record<string, number>, mode: ForgeMode, rewrites: string[] = []) {
  const spent = { asks: 0, answers: 0, judgements: 0 };
  const lines: string[] = [];
  const judge: Judge = async ({ messages }) => {
    spent.judgements += 1;
    const said = messages[1].content;
    const brief = Object.keys(marks).find((one) => said.includes(`The answer given:\n${one}`)) ?? '';
    return JSON.stringify({ faithful: marks[brief] ?? 0, rubric: marks[brief] ?? 0, critique: `about ${brief}` });
  };
  const run = (mine = proposal()) => buildTeam({
    proposal: mine, mode, noteTitles: ['Founder notes'],
    chunksFor: async () => ['a passage of the notes'],
    ask: async () => { spent.asks += 1; return rewrites[spent.asks - 1] ?? ''; },
    answer: async (_person, brief) => { spent.answers += 1; return brief; },
    judge, line: (text) => lines.push(text),
  });
  return { run, spent, lines };
}

describe('building a team out of a proposal', () => {
  it('quick asks one brief the first case, and never rewrites anything', async () => {
    const { run, spent } = harness({ 'the first brief': 1 }, 'quick');
    const [person] = await run();
    expect(person.attempts).toHaveLength(1);
    expect(person.winner.cases.map((one) => one.id)).toEqual(['first']);
    expect(spent).toEqual({ asks: 0, answers: 1, judgements: 1 });
    // format, faithful and rubric all full marks.
    expect(person.winner.mean).toBe(1);
  });

  it('full writes a second brief, runs every case, and keeps the better one', async () => {
    const { run, spent } = harness({ 'the first brief': 0.5, 'a stricter brief': 1, 'a rewritten brief': 0.5 }, 'full', ['a stricter brief', 'a rewritten brief']);
    const [person] = await run();
    expect(person.attempts.map((one) => one.from)).toEqual(['proposal', 'stricter', 'rewrite']);
    expect(person.winner.from).toBe('stricter');
    expect(person.winner.cases).toHaveLength(2);
    // Two briefs over two cases each, plus the rewrite over two more; two asks, one for each rewrite.
    expect(spent).toEqual({ asks: 2, answers: 6, judgements: 6 });
  });

  it('keeps the brief the founder read when a rewrite only matches it', async () => {
    const { run } = harness({ 'the first brief': 1, 'a stricter brief': 1, 'a rewritten brief': 1 }, 'full', ['a stricter brief', 'a rewritten brief']);
    const [person] = await run();
    // Every candidate scored the same, so the one the founder saw in the preview is the one they get.
    expect(person.winner.from).toBe('proposal');
    expect(person.winner.brief).toBe('the first brief');
  });

  it('takes a rewrite that really is better', async () => {
    const { run } = harness({ 'the first brief': 0.5, 'a stricter brief': 0.5, 'a rewritten brief': 1 }, 'full', ['a stricter brief', 'a rewritten brief']);
    const [person] = await run();
    expect(person.winner.from).toBe('rewrite');
  });

  it('leaves a person nobody wrote a case for with the brief that was proposed', async () => {
    const { run, lines, spent } = harness({ 'the first brief': 1 }, 'quick');
    const people = await run({ ...proposal(), dataset: [{ ...kase('lonely'), keys: ['nobody'] }] });
    expect(people).toEqual([]);
    expect(spent.answers).toBe(0);
    expect(lines.some((line) => line.includes('no test case'))).toBe(true);
  });

  it('stops where it is when the founder says stop', async () => {
    const stop = new AbortController();
    stop.abort();
    await expect(buildTeam({
      proposal: proposal(), mode: 'quick', noteTitles: [], chunksFor: async () => [],
      ask: async () => '', answer: async () => 'x', judge: async () => '{}', line: () => {}, signal: stop.signal,
    })).rejects.toThrow('stopped');
  });

  it('says when it has started testing, once', async () => {
    let started = 0;
    await buildTeam({
      proposal: proposal(), mode: 'quick', noteTitles: [], chunksFor: async () => [],
      ask: async () => '', answer: async () => 'said', judge: async () => JSON.stringify({ faithful: 1, critique: '' }),
      line: () => {}, onTesting: () => { started += 1; },
    });
    expect(started).toBe(1);
  });
});

describe('the rules a candidate is chosen by', () => {
  const attempt = (from: Attempt['from'], mean: number): Attempt => ({ from, brief: from, cases: [], mean });

  it('keeps the first of equals', () => {
    expect(best([attempt('proposal', 0.8), attempt('stricter', 0.8)]).from).toBe('proposal');
    expect(best([attempt('proposal', 0.8), attempt('stricter', 0.81)]).from).toBe('stricter');
  });

  it('makes a rewrite beat the winner, not match it', () => {
    expect(beats(attempt('rewrite', 0.8), attempt('proposal', 0.8))).toBe(false);
    expect(beats(attempt('rewrite', 0.81), attempt('proposal', 0.8))).toBe(true);
  });
});

describe('what a run is written down as', () => {
  it('is the winning cases, the models that answered and the mean over the people', async () => {
    const { run } = harness({ 'the first brief': 1 }, 'quick');
    const people = await run();
    const written = runOf({ people, version: 1, mode: 'quick', models: ['groq'], at: 1_700_000 });
    expect(Object.keys(written).sort()).toEqual(['at', 'cases', 'mean', 'mode', 'models', 'version']);
    expect(written.cases).toHaveLength(1);
    expect(Object.keys(written.cases[0]).sort()).toEqual(['briefHash', 'critique', 'id', 'key', 'output', 'scores']);
    expect(written.cases[0]).toMatchObject({ id: 'first', key: 'one', briefHash: briefHash('the first brief'), output: 'the first brief' });
    expect(written.cases[0].scores).toEqual({ format: 1, faithful: 1, rubric: 1 });
    expect(written.mean).toBe(1);
    const card = scorecardOf({ people, models: ['groq'], at: 1_700_000 });
    expect(card).toEqual({ mean: 1, byPerson: { one: 1 }, cases: 1, at: 1_700_000, models: ['groq'] });
  });

  it('writes the winning briefs back into the proposal', async () => {
    const { run } = harness({ 'the first brief': 0.5, 'a stricter brief': 1 }, 'full', ['a stricter brief', '']);
    const people = await run();
    expect(withWinners(proposal(), people).rooms[0].brief).toBe('a stricter brief');
  });
});

describe('the stage a candidate is tested on', () => {
  it('is the proposed team with the founder\'s notes wired to everybody, and nothing of the founder\'s own stage', () => {
    const stage = scratchStage(proposal(), ['founder-notes']);
    expect(stage.rooms.map((room) => room.id)).toEqual(['forge-one']);
    expect(stage.docs.map((doc) => doc.id)).toEqual(['forge-working']);
    expect(stage.cards).toEqual([expect.objectContaining({ kind: 'library', noteId: 'founder-notes' })]);
    expect(stage.wires.map((wire) => `${wire.from}→${wire.to}`)).toEqual(['forge-one→forge-working', 'forge-note-1→forge-one']);
  });
});

describe('the prompt that rewrites a brief', () => {
  it('ends with today, and says where the words may come from', () => {
    const now = Date.UTC(2026, 8, 22, 9);
    const [system, user] = briefMessages({
      person: proposal().rooms[0], brief: 'the first brief', chunks: ['a passage'], noteTitles: ['Founder notes'], critiques: ['it skipped a step'], now,
    });
    expect(system.content.endsWith(todayBlock(now))).toBe(true);
    expect(system.content).toContain('never put in what you remember');
    expect(user.content).toContain('it skipped a step');
  });
});
