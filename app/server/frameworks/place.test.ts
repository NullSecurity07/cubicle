import { describe, expect, it } from 'vitest';
import type { Framework } from '../../shared/frameworks.ts';
import { seedStage, type Card, type Stage } from '../../shared/model.ts';
import { spanOf } from '../../shared/frameworks.ts';
import { frameworkFrom, mintIds, place } from './place.ts';

// A small framework with one of everything the placing has to get right: two people, a shared doc, a card that holds
// a note, and wires that run both across and down.
const team: Framework = {
  id: 'pressure-test', name: 'Pressure test', intent: 'Pressure-test an idea.', version: 1, builtAt: 1,
  notes: [{ id: 'evaluation-notes', hash: 'abc123' }],
  rooms: [
    { key: 'assumption', name: 'Ananya', role: 'Assumption finder', accent: '#ee8a72', brief: 'Find the one belief.', w: 380, h: 440 },
    { key: 'verdict', name: 'Priya', role: 'Verdict judge', accent: '#b58cff', brief: 'Say the word.', w: 380, h: 440 },
  ],
  docs: [{ key: 'evaluation', title: 'Evaluation', text: '# Evaluation\n\nCore assumption:\n', w: 520, h: 380 }],
  cards: [{ key: 'notes', kind: 'library', noteId: 'evaluation-notes', w: 260, h: 180 }],
  wires: [
    { from: 'assumption', to: 'evaluation' }, { from: 'verdict', to: 'evaluation' },
    { from: 'notes', to: 'assumption' }, { from: 'verdict', to: 'assumption' },
  ],
  layout: { notes: { x: 0, y: 0 }, assumption: { x: 0, y: 230 }, verdict: { x: 460, y: 230 }, evaluation: { x: 100, y: 740 } },
  dataset: [{ id: 'one', keys: ['verdict'], input: 'Judge this.', expected: 'WEAK', addedBy: 'founder' }],
};

// A stage that already holds everything this framework would like to be called, so the minting has to work for it.
const crowded: Stage = {
  rooms: [{ id: 'assumption', name: 'Someone', role: 'Else', accent: '#fff', brief: '', x: 0, y: 0, w: 380, h: 440 }],
  docs: [{ id: 'evaluation', title: 'Taken', x: 0, y: 0, w: 340, h: 300 }],
  cards: [{ id: 'notes', kind: 'note', text: 'taken', x: 0, y: 0, w: 220, h: 180 }],
  wires: [],
};

describe('minting ids for a framework being placed', () => {
  it('uses the key itself when the stage has nothing by that name', () => {
    expect([...mintIds(['assumption', 'verdict'], [])]).toEqual([['assumption', 'assumption'], ['verdict', 'verdict']]);
  });

  it('never gives back an id the stage already holds, or the same id twice', () => {
    const ids = mintIds(['assumption', 'assumption', 'verdict'], ['assumption', 'verdict'], () => 'aaaa');
    expect([...ids.values()].every((id) => !['assumption', 'verdict'].includes(id))).toBe(true);
    // The second 'assumption' asked for the same free id, so it had to be told apart from the first.
    expect(new Set(ids.values()).size).toBe(2);
    // A rand that says the same thing every time still ends, and every id is one the store will accept.
    for (const id of ids.values()) expect(id).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/);
  });

  it('makes an id out of a key that is not one', () => {
    expect(mintIds(['Death hunter', '  ', '#####'], []).get('Death hunter')).toBe('death-hunter');
    expect([...mintIds(['  ', '#####'], []).values()].every((id) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(id))).toBe(true);
  });
});

describe('placing a framework', () => {
  it('lands the whole group at the place it was asked for, laid out as the framework says', () => {
    const { placed } = place(team, seedStage, { x: 1000, y: 200 });
    const spot = (id: string) => { const one = [...placed.rooms, ...placed.docs, ...placed.cards].find((held) => held.id === id); return { x: one?.x, y: one?.y }; };
    expect(spot(placed.cards[0].id)).toEqual({ x: 1000, y: 200 });
    expect(spot(placed.rooms[0].id)).toEqual({ x: 1000, y: 430 });
    expect(spot(placed.rooms[1].id)).toEqual({ x: 1460, y: 430 });
    expect(spot(placed.docs[0].id)).toEqual({ x: 1100, y: 940 });
    // Sizes come from the framework, and a doc that does not say falls back to the usual one.
    expect({ w: placed.docs[0].w, h: placed.docs[0].h }).toEqual({ w: 520, h: 380 });
    expect({ w: placed.rooms[0].w, h: placed.rooms[0].h }).toEqual({ w: 380, h: 440 });
  });

  it('gives everything an id of its own, and the docs their seed words', () => {
    const { placed, texts } = place(team, crowded, { x: 0, y: 0 });
    const ids = [...placed.rooms, ...placed.docs, ...placed.cards].map((one) => one.id);
    expect(new Set(ids).size).toBe(4);
    for (const id of ids) expect(['assumption', 'evaluation', 'notes']).not.toContain(id);
    expect(texts[placed.docs[0].id]).toBe('# Evaluation\n\nCore assumption:\n');
    // What the people and the cards are stays exactly as the framework wrote it.
    expect(placed.rooms[0]).toMatchObject({ name: 'Ananya', role: 'Assumption finder', brief: 'Find the one belief.' });
    expect(placed.cards[0]).toMatchObject({ kind: 'library', noteId: 'evaluation-notes' });
    expect(placed.docs[0]).toMatchObject({ title: 'Evaluation' });
  });

  it('wires the group up by the ids it just minted, and picks the handles the group is shaped for', () => {
    const { placed } = place(team, seedStage, { x: 0, y: 0 });
    const ids = new Set([...placed.rooms, ...placed.docs, ...placed.cards].map((one) => one.id));
    expect(placed.wires).toHaveLength(4);
    for (const wire of placed.wires) { expect(ids.has(wire.from)).toBe(true); expect(ids.has(wire.to)).toBe(true); }
    expect(new Set(placed.wires.map((wire) => wire.id)).size).toBe(4);
    // The note sits above the assumption finder, so the wire leaves the bottom of one and arrives at the top of the other.
    const down = placed.wires.find((wire) => wire.from === placed.cards[0].id);
    expect({ fromHandle: down?.fromHandle, toHandle: down?.toHandle }).toEqual({ fromHandle: 'b', toHandle: 't' });
    // The judge sits to the right of the assumption finder, so that one runs left.
    const across = placed.wires.find((wire) => wire.from === placed.rooms[1].id && wire.to === placed.rooms[0].id);
    expect({ fromHandle: across?.fromHandle, toHandle: across?.toHandle }).toEqual({ fromHandle: 'l', toHandle: 'r' });
  });

  it('knows how much of the canvas it will take up before anything is placed', () => {
    // What the window asks before it places: the corner furthest from the group's own, so it can find a space that
    // size and move the view to the whole team once it has landed.
    const span = spanOf(team);
    const { placed } = place(team, seedStage, { x: 700, y: -40 });
    const all = [...placed.rooms, ...placed.docs, ...placed.cards];
    expect(span).toEqual({ w: Math.max(...all.map((one) => one.x + one.w)) - 700, h: Math.max(...all.map((one) => one.y + one.h)) + 40 });
  });

  it('leaves out a wire whose end the framework does not hold', () => {
    const broken = { ...team, wires: [...team.wires, { from: 'assumption', to: 'nobody' }] };
    expect(place(broken, seedStage, { x: 0, y: 0 }).placed.wires).toHaveLength(4);
  });
});

describe('saving a framework from what is selected on the stage', () => {
  // Place it, select every piece of it, save it again: what comes back has to be the same team, whatever the ids and
  // the keys ended up being called.
  const shape = (framework: Framework) => ({
    rooms: framework.rooms.map((room) => ({ name: room.name, role: room.role, brief: room.brief, accent: room.accent, w: room.w, h: room.h })).sort((one, two) => one.role.localeCompare(two.role)),
    docs: framework.docs.map((doc) => ({ title: doc.title, text: doc.text })),
    cards: framework.cards.map((card) => ({ kind: card.kind, ...('noteId' in card ? { noteId: card.noteId } : {}) })),
    // The wires as "who to whom", said in words that survive being given new keys.
    wires: framework.wires.map((wire) => {
      const label = (key: string) => framework.rooms.find((room) => room.key === key)?.role ?? framework.docs.find((doc) => doc.key === key)?.title ?? framework.cards.find((card) => card.key === key)?.kind ?? key;
      return `${label(wire.from)}>${label(wire.to)}`;
    }).sort(),
    // Where everything stands, relative to the group's own corner.
    layout: Object.fromEntries(Object.entries(framework.layout).map(([key, spot]) => {
      const label = framework.rooms.find((room) => room.key === key)?.role ?? framework.docs.find((doc) => doc.key === key)?.title ?? framework.cards.find((card) => card.key === key)?.kind ?? key;
      return [label, spot];
    })),
  });

  it('comes back as the same team it was placed from', () => {
    const { placed, texts } = place(team, seedStage, { x: 1234, y: -56 });
    const stage: Stage = {
      rooms: [...seedStage.rooms, ...placed.rooms], docs: [...seedStage.docs, ...placed.docs],
      cards: [...(seedStage.cards ?? []), ...placed.cards], wires: [...seedStage.wires, ...placed.wires],
    };
    const again = frameworkFrom({
      stage, ids: [...placed.rooms, ...placed.docs, ...placed.cards].map((one) => one.id),
      name: 'Pressure test', intent: 'Pressure-test an idea.', texts, hashOf: () => 'abc123', now: () => 2,
    });
    expect(shape(again)).toEqual(shape(team));
    // And it remembers which of the founder's notes it was built from, because a note card was part of the selection.
    expect(again.notes).toEqual([{ id: 'evaluation-notes', hash: 'abc123' }]);
    expect(again.id).toBe('pressure-test');
    expect(again.builtAt).toBe(2);
    expect(again.dataset).toEqual([]);
  });

  it('takes only what was selected, and only the wires inside it', () => {
    const { placed, texts } = place(team, seedStage, { x: 0, y: 0 });
    const stage: Stage = {
      rooms: [...seedStage.rooms, ...placed.rooms], docs: [...seedStage.docs, ...placed.docs],
      cards: placed.cards, wires: [...seedStage.wires, ...placed.wires],
    };
    const part = frameworkFrom({ stage, ids: [placed.rooms[0].id, placed.rooms[1].id], name: 'Two of them', texts });
    expect(part.rooms).toHaveLength(2);
    expect(part.docs).toEqual([]);
    expect(part.cards).toEqual([]);
    // Only the wire between the two people survives: the ones to the doc and the note lead out of the selection.
    expect(part.wires).toHaveLength(1);
    expect(part.notes).toEqual([]);
    expect(part.layout[part.rooms[0].key]).toEqual({ x: 0, y: 0 });
  });

  it('keeps what the founder had already put into a framework it replaces', () => {
    const { placed, texts } = place(team, seedStage, { x: 0, y: 0 });
    const stage: Stage = { rooms: placed.rooms, docs: placed.docs, cards: placed.cards, wires: placed.wires };
    const again = frameworkFrom({
      stage, ids: placed.rooms.map((one) => one.id), name: 'Pressure test', texts, was: team,
    });
    expect(again.dataset).toEqual(team.dataset);
    expect(again.intent).toBe('Pressure-test an idea.');
    expect(again.version).toBe(2);
  });

  it('refuses a selection with nothing in it', () => {
    expect(() => frameworkFrom({ stage: seedStage, ids: [], name: 'Empty', texts: {} })).toThrow('nothing');
    expect(() => frameworkFrom({ stage: seedStage, ids: ['marketing'], name: '  ', texts: {} })).toThrow('name');
  });

  it('names its parts after what they are, and never twice the same', () => {
    const stage: Stage = {
      ...seedStage,
      cards: [
        { id: 'a', kind: 'browser', x: 0, y: 0, w: 560, h: 353 },
        { id: 'b', kind: 'browser', x: 600, y: 0, w: 560, h: 353 },
      ] as Card[],
    };
    const framework = frameworkFrom({ stage, ids: ['marketing', 'build', 'a', 'b'], name: 'Pair', texts: {} });
    expect(framework.rooms.map((room) => room.key)).toEqual(['maya', 'dev']);
    expect(framework.cards.map((card) => card.key)).toEqual(['browser', 'browser-2']);
  });
});
