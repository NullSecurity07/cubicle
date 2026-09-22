import { createHash } from 'node:crypto';
import type { ForgeMode, Person, Proposal } from '../../shared/forge.ts';
import type { Case, Scorecard } from '../../shared/frameworks.ts';
import type { Card, Doc, Room, Stage, Wire } from '../../shared/model.ts';
import { caseScore, meanOf, scoreCase, type Judge } from '../evals/score.ts';
import { todayBlock, type ModelMessage } from '../prompt.ts';
import { MOST_BRIEF_CHARS } from './propose.ts';

// Building the team: every person is given two briefs to be, each one answers the founder's own test cases, and the
// one that answers them better is who they become. None of it happens on the founder's stage — the people here live
// for the length of one run, in a stage held in memory, and the only thing that reaches disk is the framework and
// the record of how it scored.

const MOST_OUTPUT = 6000;
export const briefHash = (brief: string) => createHash('sha1').update(brief).digest('hex');

// One case, answered and scored.
export type CaseRun = { id: string; key: string; briefHash: string; output: string; scores: Record<string, number>; critique: string };
// One brief tried: where it came from, what it answered, and what that was worth.
export type Attempt = { from: 'proposal' | 'stricter' | 'rewrite'; brief: string; cases: CaseRun[]; mean: number };
export type PersonResult = { key: string; attempts: Attempt[]; winner: Attempt; critique: string };

// The stage the candidates work on: the proposed people, the documents they share with the words they start with,
// and the founder's notes as cards wired to everybody. It is never saved, never shown and never merged into the
// founder's own stage — the ids say so out loud.
export function scratchStage(proposal: Proposal, noteIds: string[]): Stage {
  const id = (key: string) => `forge-${key}`;
  const rooms: Room[] = proposal.rooms.map((person, index) => ({
    id: id(person.key), name: person.name, role: person.role, accent: person.accent, brief: person.brief,
    x: index * 460, y: 0, w: 380, h: 440,
  }));
  const docs: Doc[] = proposal.docs.map((doc, index) => ({ id: id(doc.key), title: doc.title, x: index * 400, y: 740, w: 340, h: 300 }));
  const cards: Card[] = noteIds.map((noteId, index) => ({ id: `forge-note-${index + 1}`, kind: 'library' as const, noteId, x: index * 300, y: -300, w: 260, h: 180 }));
  const wires: Wire[] = [
    ...proposal.wires.map((wire) => ({ id: `${id(wire.from)}-${id(wire.to)}`, from: id(wire.from), to: id(wire.to), fromHandle: 'r', toHandle: 'l' })),
    ...cards.flatMap((card) => rooms.map((room) => ({ id: `${card.id}-${room.id}`, from: card.id, to: room.id, fromHandle: 'b', toHandle: 't' }))),
  ];
  return { rooms, docs, cards, wires };
}

// Asking one person to be somebody stricter. The notes are in front of it and nothing else is: a brief rewritten out
// of what a model remembers about the subject is exactly the drift the forge exists to stop.
export function briefMessages(asked: {
  person: Person; brief: string; chunks: string[]; noteTitles: string[]; critiques?: string[]; now?: number;
}): ModelMessage[] {
  const now = asked.now ?? Date.now();
  const why = asked.critiques?.length
    ? 'A judge scored this person\'s answers against the founder\'s notes and said what was missing. Rewrite the brief so that stops being true.'
    : 'Rewrite it stricter and more specific to the founder\'s notes: name the steps in the notes\' own words, say what a bad answer looks like, and pin down the exact shape the answer must take.';
  const system = [
    'You rewrite one person\'s brief, and you write nothing else. No preface, no explanation, no quotation marks around it: the reply is the brief itself, word for word as that person will read it.',
    why,
    `Work only from the passages of the founder's notes below (${asked.noteTitles.map((title) => `"${title}"`).join(' and ')}).`
      + ' Everything you add has to be in those words already. Never add a step, a threshold or an example the notes do not state, and never put in what you remember about this subject from elsewhere.',
    `Keep it under ${MOST_BRIEF_CHARS} characters, written to them as "you", and keep naming the note and the section they work from.`,
    todayBlock(now),
  ].join('\n\n');
  const user = [
    `Who they are: ${asked.person.name}, ${asked.person.role}.`,
    `From the founder's notes:\n${asked.chunks.join('\n\n') || '(no passage was found for this person)'}`,
    ...(asked.critiques?.length ? [`What the judge said about their answers:\n${asked.critiques.map((one) => `- ${one}`).join('\n')}`] : []),
    `The brief as it stands:\n${asked.brief}`,
    'Now the rewritten brief, and nothing else.',
  ].join('\n\n');
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

// The best of what was tried: the highest mean, and on a tie the one that was tried first — which is the proposal's
// own brief, so a rewrite that only matched it never quietly replaces what the founder read in the preview.
export const best = (attempts: Attempt[]): Attempt => attempts.reduce((winner, one) => (one.mean > winner.mean ? one : winner));
// And a rewrite has to be better than the winner, not as good: same rule, said where it is decided.
export const beats = (rewrite: Attempt, winner: Attempt) => rewrite.mean > winner.mean;

// What a run is written down as, beside the framework it was a run of. The evals round reads these to decide whether
// a run may be promoted; this round only writes them honestly.
export function runOf(asked: { people: PersonResult[]; version: number; mode: ForgeMode; models: string[]; at: number }) {
  const cases = asked.people.flatMap((person) => person.winner.cases);
  return {
    at: asked.at, version: asked.version, mode: asked.mode, models: asked.models,
    cases, mean: meanOf(asked.people.map((person) => person.winner.mean)),
  };
}

export const scorecardOf = (asked: { people: PersonResult[]; models: string[]; at: number }): Scorecard => ({
  mean: meanOf(asked.people.map((person) => person.winner.mean)),
  byPerson: Object.fromEntries(asked.people.map((person) => [person.key, person.winner.mean])),
  cases: asked.people.reduce((sum, person) => sum + person.winner.cases.length, 0),
  at: asked.at, models: asked.models,
});

// Everything a build does, with the model calls handed in: `ask` is one call that comes back as words, `answer` is
// one whole turn of one person, and `judge` is one call that comes back as scores. Handing them in is what lets the
// rules below — who wins, what a tie means, what a rewrite has to beat — be checked without a key to anything.
export async function buildTeam(asked: {
  proposal: Proposal; mode: ForgeMode; noteTitles: string[];
  chunksFor(kase: Case): Promise<string[]>;
  ask(messages: ModelMessage[]): Promise<string>;
  answer(person: Person, brief: string, kase: Case): Promise<string>;
  judge: Judge;
  line(text: string): void;
  onTesting?: () => void;
  signal?: AbortSignal;
  now?: () => number;
}): Promise<PersonResult[]> {
  const quick = asked.mode === 'quick';
  const stop = () => { if (asked.signal?.aborted) throw new Error('The forge was stopped.'); };
  const people: PersonResult[] = [];
  let testing = false;

  // One brief, put through the cases that name this person. Everything costly is in here, so the caller counts it.
  const tryBrief = async (person: Person, brief: string, from: Attempt['from'], cases: Case[]): Promise<Attempt> => {
    const runs: CaseRun[] = [];
    for (const kase of cases) {
      stop();
      if (!testing) { testing = true; asked.onTesting?.(); }
      const output = (await asked.answer(person, brief, kase)).slice(0, MOST_OUTPUT);
      const chunks = await asked.chunksFor(kase);
      const judged = await scoreCase({ kase, output, brief, chunks, now: asked.now?.() }, asked.judge);
      runs.push({ id: kase.id, key: person.key, briefHash: briefHash(brief), output, scores: judged.scores, critique: judged.critique });
      asked.line(`${person.name} · ${kase.id} · ${caseScore(judged).toFixed(2)}${judged.critique ? ` — ${judged.critique}` : ''}`);
    }
    return { from, brief, cases: runs, mean: meanOf(runs.map(caseScore)) };
  };

  for (const person of asked.proposal.rooms) {
    stop();
    const mine = asked.proposal.dataset.filter((kase) => kase.keys.includes(person.key));
    const cases = quick ? mine.slice(0, 1) : mine;
    if (!cases.length) { asked.line(`${person.name} has no test case, so the proposed brief stands.`); continue; }

    const attempts: Attempt[] = [];
    asked.line(`${person.name}, ${person.role}: ${cases.length === 1 ? 'one case' : `${cases.length} cases`}, ${quick ? 'one brief' : 'two briefs'}.`);
    attempts.push(await tryBrief(person, person.brief, 'proposal', cases));
    if (!quick) {
      stop();
      const chunks = await asked.chunksFor(cases[0]);
      const stricter = (await asked.ask(briefMessages({ person, brief: person.brief, chunks, noteTitles: asked.noteTitles, now: asked.now?.() }))).trim().slice(0, MOST_BRIEF_CHARS);
      // A rewrite that came back empty is one model having a bad minute, not a candidate.
      if (stricter) attempts.push(await tryBrief(person, stricter, 'stricter', cases));
    }
    let winner = best(attempts);

    if (!quick) {
      stop();
      const critiques = [...new Set(winner.cases.map((one) => one.critique).filter(Boolean))];
      const chunks = await asked.chunksFor(cases[0]);
      const again = (await asked.ask(briefMessages({ person, brief: winner.brief, chunks, noteTitles: asked.noteTitles, critiques, now: asked.now?.() }))).trim().slice(0, MOST_BRIEF_CHARS);
      if (again && again !== winner.brief) {
        const rewritten = await tryBrief(person, again, 'rewrite', cases);
        attempts.push(rewritten);
        // Only if it is really better: the founder read the winning brief's answers, and a rewrite that merely ties
        // is a change they cannot see the point of.
        if (beats(rewritten, winner)) winner = rewritten;
      }
    }

    const critique = winner.cases.map((one) => one.critique).find(Boolean) ?? '';
    people.push({ key: person.key, attempts, winner, critique });
    asked.line(`${person.name}: ${winner.mean.toFixed(2)} (${winner.from === 'proposal' ? 'the proposed brief' : winner.from === 'stricter' ? 'the stricter brief' : 'the rewritten brief'}).`);
  }

  return people;
}

// The proposal with every winning brief written into it: what is saved as the framework, and what the founder places.
export const withWinners = (proposal: Proposal, people: PersonResult[]): Proposal => ({
  ...proposal,
  rooms: proposal.rooms.map((person) => ({ ...person, brief: people.find((one) => one.key === person.key)?.winner.brief ?? person.brief })),
});
