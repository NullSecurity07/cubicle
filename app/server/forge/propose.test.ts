import { describe, expect, it } from 'vitest';
import type { Proposal } from '../../shared/forge.ts';
import { todayBlock } from '../prompt.ts';
import type { NoteRead, NoteShape } from './notes.ts';
import { ACCENTS, checkProposal, frameworkOf, layoutOf, MOST_BRIEF_CHARS, nameFrom, proposeMessages } from './propose.ts';

const NOTE: NoteShape = { title: 'Evaluating a Startup Idea', headings: ['1. Core assumption', '2. Fatal flaws', '3. Is the pain real?'] };
const asked = { notes: [NOTE], intent: 'a team that pressure-tests an idea' };
const brief = (words = '') => `You are step one of "Evaluating a Startup Idea", section "1. Core assumption". ${words}`;

// A proposal exactly as a good model would write one, which each test then breaks in one place.
const good = () => ({
  name: 'Idea pressure test',
  rooms: [
    { key: 'assumption', name: 'Ananya', role: 'Assumption finder', brief: brief('Name the one belief.') },
    { key: 'verdict', name: 'Priya', role: 'Verdict judge', brief: brief('Give one of three verdicts.') },
  ],
  docs: [{ key: 'evaluation', title: 'Evaluation', text: '# Evaluation\n' }],
  cards: [{ key: 'graveyard', kind: 'browser' }],
  wires: [{ from: 'assumption', to: 'evaluation' }, { from: 'verdict', to: 'assumption' }],
  dataset: [{ id: 'Airbnb assumption!', keys: ['assumption'], input: 'Name the core assumption.', expected: 'Strangers will sleep in strangers\' homes.', rubric: 'Falsifiable, not a hope.' }],
});

describe('what the forge is allowed to come back with', () => {
  it('takes a good proposal, and tidies it into the shape a framework is', () => {
    const proposal = checkProposal(good(), asked);
    expect(proposal.name).toBe('Idea pressure test');
    expect(proposal.rooms.map((person) => person.accent)).toEqual([ACCENTS[0], ACCENTS[1]]);
    expect(proposal.dataset[0]).toMatchObject({ id: 'airbnb-assumption', keys: ['assumption'], addedBy: 'forge' });
    expect(proposal.cards).toEqual([{ key: 'graveyard', kind: 'browser' }]);
  });

  it('insists on between two and seven people', () => {
    expect(() => checkProposal({ ...good(), rooms: good().rooms.slice(0, 1) }, asked)).toThrow('between 2 and 7 people');
    const many = Array.from({ length: 8 }, (_one, index) => ({ key: `one-${index}`, name: 'Ana', role: 'Thinker', brief: brief() }));
    expect(() => checkProposal({ ...good(), rooms: many }, asked)).toThrow('and this has 8');
  });

  it('holds a brief to its length and makes it say which section of which note it works from', () => {
    const long = { ...good(), rooms: [{ ...good().rooms[0], brief: brief('x'.repeat(MOST_BRIEF_CHARS)) }, good().rooms[1]] };
    expect(() => checkProposal(long, asked)).toThrow(`the limit is ${MOST_BRIEF_CHARS}`);
    const vague = { ...good(), rooms: [{ ...good().rooms[0], brief: 'Work from the notes and find the assumption.' }, good().rooms[1]] };
    expect(() => checkProposal(vague, asked)).toThrow('never says which section of which note');
    // The heading alone is enough: it is the note's own words either way.
    const heading = { ...good(), rooms: [{ ...good().rooms[0], brief: 'You work from 3. Is the pain real? and nothing else.' }, good().rooms[1]] };
    expect(checkProposal(heading, asked).rooms[0].brief).toContain('3. Is the pain real?');
    // But the founder's own edit in the preview is theirs, and is never refused for it.
    expect(checkProposal(vague, { ...asked, lenient: true }).rooms[0].brief).toBe('Work from the notes and find the assumption.');
  });

  it('refuses a person with no role, and names anybody the model left unnamed', () => {
    expect(() => checkProposal({ ...good(), rooms: [{ ...good().rooms[0], role: '' }, good().rooms[1]] }, asked)).toThrow('has no role');
    const unnamed = { ...good(), rooms: [{ ...good().rooms[0], name: '' }, good().rooms[1]] };
    expect(checkProposal(unnamed, asked).rooms[0].name).toBeTruthy();
  });

  it('refuses two things that share a key', () => {
    expect(() => checkProposal({ ...good(), docs: [{ key: 'assumption', title: 'Evaluation', text: '' }] }, asked)).toThrow('share the key "assumption"');
  });

  it('refuses a card that is not a browser or a board', () => {
    expect(() => checkProposal({ ...good(), cards: [{ key: 'folder', kind: 'project' }], wires: [] }, asked)).toThrow('only "browser" and "board"');
  });

  it('refuses a wire whose end is not one of the keys', () => {
    expect(() => checkProposal({ ...good(), wires: [{ from: 'assumption', to: 'nobody' }] }, asked)).toThrow('which is not one of the keys');
    expect(() => checkProposal({ ...good(), wires: [{ from: 'verdict', to: 'verdict' }] }, asked)).toThrow('joins one thing to itself');
  });

  it('insists every case names somebody who exists and really asks something', () => {
    expect(() => checkProposal({ ...good(), dataset: [{ id: 'orphan', keys: ['nobody'], input: 'Judge this.' }] }, asked)).toThrow('names nobody who exists');
    expect(() => checkProposal({ ...good(), dataset: [{ id: 'empty', keys: ['verdict'], input: '  ' }] }, asked)).toThrow('has nothing asked in it');
    expect(() => checkProposal({ ...good(), dataset: [] }, asked)).toThrow('there are no test cases');
  });

  it('refuses a reply that is not an object at all', () => {
    expect(() => checkProposal('a team of five', asked)).toThrow('not one json object');
    expect(() => checkProposal([1, 2], asked)).toThrow('not one json object');
  });

  it('names a team the model did not name, out of the founder\'s own intent', () => {
    expect(checkProposal({ ...good(), name: '' }, asked).name).toBe('Team that pressure-tests an');
    expect(nameFrom('')).toBe('Forged team');
  });
});

describe('the prompt that asks for a team', () => {
  const notes: NoteRead[] = [{
    id: 'evaluating-a-startup-idea', title: NOTE.title, hash: 'abc', headings: NOTE.headings,
    sections: [{ heading: '1. Core assumption', chunks: ['The one belief that, if false, makes everything else irrelevant.'] }],
  }];

  it('ends with today, so nobody answers out of the year they were trained in', () => {
    const now = Date.UTC(2026, 8, 22, 9, 0, 0);
    const [system, user] = proposeMessages({ intent: 'pressure-test an idea', notes, now });
    expect(system.content.endsWith(todayBlock(now))).toBe(true);
    expect(user.content).toContain('The one belief that, if false');
  });

  it('tells the model to work from these notes and nothing it remembers', () => {
    const [system] = proposeMessages({ intent: 'pressure-test an idea', notes, now: Date.now() });
    expect(system.content).toContain('Work only from the passages of the founder\'s notes');
    expect(system.content).toContain('never fall back on what you remember');
    expect(system.content).toContain(`"${NOTE.title}"`);
  });
});

describe('the framework a proposal becomes', () => {
  const proposal = (): Proposal => checkProposal(good(), asked);

  it('wires the founder\'s notes to every person, and stands the team left to right', () => {
    const framework = frameworkOf(proposal(), { intent: asked.intent, notes: [{ id: 'evaluating-a-startup-idea', hash: 'abc' }], builtAt: 5 });
    expect(framework.id).toBe('idea-pressure-test');
    expect(framework.cards.map((card) => card.kind).sort()).toEqual(['browser', 'library']);
    // Two people, so two wires from the note, on top of the two the model proposed.
    expect(framework.wires.filter((wire) => wire.from === 'notes')).toHaveLength(2);
    expect(framework.wires).toHaveLength(4);
    expect(framework.layout.assumption.x).toBeLessThan(framework.layout.verdict.x);
    expect(framework.layout.notes.y).toBeLessThan(framework.layout.assumption.y);
    expect(framework.layout.evaluation.y).toBeGreaterThan(framework.layout.assumption.y);
    expect(framework.version).toBe(1);
    expect(framework.builtAt).toBe(5);
    expect(framework.notes).toEqual([{ id: 'evaluating-a-startup-idea', hash: 'abc' }]);
  });

  it('gives the note card a key nothing else has taken', () => {
    const mine = { ...proposal(), docs: [{ key: 'notes', title: 'Notes', text: '' }] };
    const framework = frameworkOf(mine, { intent: '', notes: [{ id: 'one', hash: 'a' }, { id: 'two', hash: 'b' }] });
    const keys = framework.cards.filter((card) => card.kind === 'library').map((card) => card.key);
    expect(keys).toEqual(['notes-2', 'notes-3']);
  });

  it('lays out a team with nothing below it without falling over', () => {
    expect(layoutOf({ rooms: [{ key: 'one' }], docs: [], cards: [], notes: [] })).toEqual({ one: { x: 0, y: 230 } });
  });
});
