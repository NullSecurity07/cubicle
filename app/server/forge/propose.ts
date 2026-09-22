import type { Case, CardSpec, DocSpec, Framework, RoomSpec, Spot, WireSpec } from '../../shared/frameworks.ts';
import { DOC_SIZE, frameworkId, slugOf } from '../../shared/frameworks.ts';
import type { Person, Proposal, ProposalCard, ProposalDoc } from '../../shared/forge.ts';
import { JSON_RULE } from '../json.ts';
import { todayBlock, type ModelMessage } from '../prompt.ts';
import { notesBlock, type NoteRead, type NoteShape } from './notes.ts';

// Proposing a team out of the founder's notes: what the model is asked, and what is then held to in code. The model
// writes the people and the test cases; everything that has to be true for a framework to work — the keys, the
// wires, the colours, where anything stands — is decided here, because a model that is asked for a drawing as well
// as a method does neither well.

// The first line of the forge's own prompt. It is what the stand-in model in `providers.ts` recognises, so a browser
// journey can watch a team be forged with no key to anything.
export const FORGE_MARK = 'You are the forge.';
// A brief longer than this is not a brief, it is the note again: the person would read their own instructions for
// longer than they read the founder's question.
export const MOST_BRIEF_CHARS = 1500;
export const FEWEST_ROOMS = 2;
export const MOST_ROOMS = 7;
// The same six the dock gives a new person, in the same order (`src/addCard.ts`). A team of seven comes back round
// to the first of them: the founder's stage has never had two colours for a reason, and a seventh person is rarer
// than a wrong-looking one.
export const ACCENTS = ['#ee8a72', '#4e8cff', '#f0b35a', '#6fcf97', '#b58cff', '#5fc9d6'];
// Names for a person the model left unnamed. Short, ordinary, and nothing like a product.
const SPARE_NAMES = ['Ana', 'Ben', 'Cleo', 'Dara', 'Esme', 'Finn', 'Gia'];
// What each thing on the stage is when it lands, in the sizes the dock uses for them.
const ROOM_SIZE = { w: 380, h: 440 };
const CARD_SIZE: Record<ProposalCard['kind'] | 'library', { w: number; h: number }> = {
  browser: { w: 560, h: 353 }, board: { w: 980, h: 440 }, library: { w: 260, h: 180 },
};
// How far apart a team stands. A person is 380 wide, so 460 leaves a gap to read the wires in; the notes hang above
// the row and the documents below it, which is the shape the built-in team is drawn in.
const STEP = { person: 460, doc: 400, card: 620, note: 300 };
const ROW = { notes: 0, people: 230, below: 740 };

const words = (value: unknown) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');
const lines = (value: unknown) => (typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim() : '');
const keyOf = (value: unknown) => slugOf(words(value)).slice(0, 40);

// What the model is asked for, written out as the thing it has to answer with. A shape shown is worth a page of
// prose describing one, and this is the shape of the built-in team's own file.
const SHAPE = `{
  "name": "Startup evaluation",
  "rooms": [
    { "key": "assumption", "name": "Ananya", "role": "Assumption finder",
      "brief": "You are step one of the founder's notes, \\"<the note's title>\\", section \\"<the section's heading>\\": ... what this person does, in the note's own words, and the shape their answer must take." }
  ],
  "docs": [{ "key": "evaluation", "title": "Evaluation", "text": "# Evaluation\\n\\n## 1. Core assumption\\n\\n## 2. Fatal flaws\\n" }],
  "cards": [{ "key": "graveyard", "kind": "browser" }],
  "wires": [{ "from": "assumption", "to": "evaluation" }, { "from": "verdict", "to": "assumption" }],
  "dataset": [
    { "id": "airbnb-assumption", "keys": ["assumption"],
      "input": "Idea: people rent out a spare room in their own home to travellers. Name the core assumption.",
      "expected": "Strangers will sleep in strangers' homes for money.",
      "rubric": "The one belief that, if false, makes everything else irrelevant. Falsifiable, not a hope." }
  ]
}`;

// The one call that proposes a team. Everything the model is allowed to work from is in this prompt, and it is told
// so twice: once at the top, where it reads hardest for what it is, and once at the end, where a small model reads
// hardest for what to do.
export function proposeMessages(asked: { intent: string; notes: NoteRead[]; now?: number }): ModelMessage[] {
  const now = asked.now ?? Date.now();
  const titles = asked.notes.map((note) => `"${note.title}"`).join(' and ');
  const system = [
    `${FORGE_MARK} The founder writes down how they work, and you turn those notes into a small team of people for their canvas:`
      + ' who each person is, what they are told to do, the document they share and the test cases that will prove they do it.',
    `Work only from the passages of the founder's notes in the next message (${titles}). Every person, every step, every criterion and every test case has to come from those words.`
      + ' Never add a step, a threshold, a score or an example the notes do not state, and never fall back on what you remember about this subject from anywhere else:'
      + " it is not this founder's method, it is usually older than they are, and they will know at a glance that it is not theirs.",
    `${JSON_RULE}\n${SHAPE}`,
    [
      `- "name": what this team is called, two to four plain words. Not a product name.`,
      `- "rooms": between ${FEWEST_ROOMS} and ${MOST_ROOMS} people, one for each step or judgement the notes really separate. Fewer people doing whole steps beats more people doing halves of one.`,
      `- "key": a short lowercase word, unique across rooms, docs and cards, and the name the wires and the test cases use. "name": one plausible short first name. "role": two or three words, what they do.`,
      `- "brief": at most ${MOST_BRIEF_CHARS} characters, written to that person as "you". It must name the note and the section of it they work from, in the note's own words ("section \\"<heading>\\" of \\"<title>\\"").`
        + ' Then: what they look for, the distinctions the notes draw and the words the notes draw them in, what a bad answer looks like, and the exact shape their answer must take.',
      `- "docs": the working document the team writes into, with "text" as its empty headings — the form the notes say the work is written down in. One is usually right; none is allowed.`,
      `- "cards": only "browser" (a live browser, for a person the notes send to look something up) or "board". Nothing else exists here. Leave the list empty when the notes need neither.`,
      `- "wires": who is connected to what, by key, both ends. A wire is permission: a person can read and write a document they are wired to, and ask a colleague they are wired to. Wire each person to the shared document, and wire whoever judges to the people they must ask first.`,
      `- "dataset": two or three test cases per person, taken from the notes' own worked examples and rubrics. "keys" says whose case it is. "input" is what that person is asked, whole, so it can be asked of them with nothing else in front of them.`
        + ' "expected" only when the notes state the answer — leave it out otherwise, never invent one. "rubric" is the note\'s own criteria, in the note\'s words. "id" is a short slug of what the case is about.',
      '- Say nothing about the canvas: no sizes, no places, no colours. Where a team stands is worked out here.',
    ].join('\n'),
    todayBlock(now),
  ].join('\n\n');
  const user = [
    `What the founder wants this team for:\n${asked.intent.trim() || '(they did not say; work it out from the notes)'}`,
    `The founder's notes:\n\n${notesBlock(asked.notes)}`,
    `Now propose the team. ${JSON_RULE}`,
  ].join('\n\n');
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

// A brief has to say which part of the founder's notes its person works from, and it has to say it in the notes'
// own words: a person told "work from the notes" reads the whole of them and does the first thing they see.
const namesSection = (brief: string, notes: NoteShape[]) => {
  const said = brief.toLowerCase();
  return notes.some((note) => said.includes(note.title.toLowerCase().slice(0, 40))
    || note.headings.some((heading) => heading.length >= 4 && said.includes(heading.toLowerCase())));
};

// Everything the model wrote, held to what a framework needs to be true. Each failure says what is wrong in the
// words the model will be shown on its one retry, so the second attempt is a correction rather than a second guess.
// `lenient` is the founder's own preview coming back: their edits are theirs, and a brief they wrote themselves is
// never refused for not quoting a heading. Everything a framework needs to hold together is still checked.
export function checkProposal(value: unknown, asked: { notes: NoteShape[]; intent: string; lenient?: boolean }): Proposal {
  const held = value as Record<string, unknown>;
  if (!held || typeof held !== 'object' || Array.isArray(held)) throw new Error('the reply was not one json object');
  const rooms = Array.isArray(held.rooms) ? held.rooms as Record<string, unknown>[] : [];
  if (rooms.length < FEWEST_ROOMS || rooms.length > MOST_ROOMS) {
    throw new Error(`there must be between ${FEWEST_ROOMS} and ${MOST_ROOMS} people in "rooms", and this has ${rooms.length}`);
  }

  const taken = new Set<string>();
  const claim = (key: string, what: string) => {
    if (!key) throw new Error(`${what} has no "key"`);
    if (taken.has(key)) throw new Error(`two things share the key "${key}", and every key has to be its own`);
    taken.add(key);
    return key;
  };

  const people: Person[] = rooms.map((room, index) => {
    const key = claim(keyOf(room.key), `the person at position ${index + 1}`);
    const brief = lines(room.brief);
    if (!brief) throw new Error(`the person "${key}" has no brief`);
    if (brief.length > MOST_BRIEF_CHARS) throw new Error(`the brief for "${key}" is ${brief.length} characters, and the limit is ${MOST_BRIEF_CHARS}`);
    if (!asked.lenient && !namesSection(brief, asked.notes)) {
      const note = asked.notes[0];
      throw new Error(`the brief for "${key}" never says which section of which note it works from: name the note ("${note?.title ?? ''}") and one of its sections${note?.headings[0] ? ` (for example "${note.headings[0]}")` : ''}, in the note's own words`);
    }
    const role = words(room.role);
    if (!role) throw new Error(`the person "${key}" has no role: two or three words for what they do`);
    return {
      key,
      // A person with no name is given one rather than refused: the founder can rename anybody in the preview, and a
      // nameless person is the one thing they cannot.
      name: words(room.name).split(' ').slice(0, 2).join(' ').slice(0, 24) || SPARE_NAMES[index % SPARE_NAMES.length],
      role: role.slice(0, 40),
      // The colour is not the model's to choose: a team the founder can tell apart at a glance is six colours in the
      // order the dock hands them out.
      accent: ACCENTS[index % ACCENTS.length],
      brief,
    };
  });

  const docs: ProposalDoc[] = (Array.isArray(held.docs) ? held.docs as Record<string, unknown>[] : []).map((doc, index) => ({
    key: claim(keyOf(doc.key) || `doc-${index + 1}`, `the document at position ${index + 1}`),
    title: words(doc.title).slice(0, 60) || 'Working document',
    text: lines(doc.text),
  }));

  const cards: ProposalCard[] = (Array.isArray(held.cards) ? held.cards as Record<string, unknown>[] : []).map((card, index) => {
    const kind = words(card.kind).toLowerCase();
    if (kind !== 'browser' && kind !== 'board') throw new Error(`"${kind || 'nothing'}" is not a card the forge can put on the stage: only "browser" and "board"`);
    return { key: claim(keyOf(card.key) || kind, `the card at position ${index + 1}`), kind };
  });

  const wires: WireSpec[] = (Array.isArray(held.wires) ? held.wires as Record<string, unknown>[] : []).map((wire) => {
    const [from, to] = [keyOf(wire.from), keyOf(wire.to)];
    for (const end of [from, to]) if (!taken.has(end)) throw new Error(`the wire "${from || '?'}" → "${to || '?'}" names "${end || '?'}", which is not one of the keys you wrote`);
    if (from === to) throw new Error(`the wire "${from}" → "${to}" joins one thing to itself`);
    return { from, to };
  });

  const keys = new Set(people.map((person) => person.key));
  const dataset: Case[] = (Array.isArray(held.dataset) ? held.dataset as Record<string, unknown>[] : []).map((held, index) => {
    const id = slugOf(words(held.id)).slice(0, 60) || `case-${index + 1}`;
    const mine = [...new Set((Array.isArray(held.keys) ? held.keys : []).map((key) => keyOf(key)))].filter((key) => keys.has(key));
    if (!mine.length) throw new Error(`the case "${id}" names nobody who exists: its "keys" have to be keys of the people you wrote`);
    const input = lines(held.input);
    if (!input) throw new Error(`the case "${id}" has nothing asked in it: "input" is the whole question that person is given`);
    const [expected, rubric] = [lines(held.expected), lines(held.rubric)];
    return { id, keys: mine, input, ...(expected ? { expected } : {}), ...(rubric ? { rubric } : {}), addedBy: 'forge' as const };
  });
  // Without a case there is nothing to test, and a framework nobody tested is the hand-typed brief the forge exists
  // to replace.
  if (!dataset.length) throw new Error("there are no test cases: every person needs at least one, drawn from the notes' own worked examples or rubrics");

  return { name: words(held.name).slice(0, 60) || nameFrom(asked.intent), rooms: people, docs, cards, wires, dataset };
}

// A name for a team the model did not name: the founder's own intent, said short.
export function nameFrom(intent: string): string {
  const said = words(intent).replace(/^(a|an|the)\s+/i, '').split(' ').slice(0, 4).join(' ');
  return said ? said[0].toUpperCase() + said.slice(1) : 'Forged team';
}

// A key nothing has taken yet, for the cards the forge adds itself.
export function freeKey(stem: string, taken: Set<string>): string {
  let key = stem;
  for (let tries = 2; taken.has(key); tries += 1) key = `${stem}-${tries}`;
  taken.add(key);
  return key;
}

// Where the team stands: the notes above, the people in one row left to right in the order they were proposed, the
// document and any card below them. A framework's layout is relative to its own corner, so this is a drawing, not a
// place on anybody's canvas.
export function layoutOf(parts: { rooms: { key: string }[]; docs: { key: string }[]; cards: { key: string; kind: string }[]; notes: { key: string }[] }): Record<string, Spot> {
  const layout: Record<string, Spot> = {};
  const width = Math.max(parts.rooms.length * STEP.person, 1);
  parts.rooms.forEach((room, index) => { layout[room.key] = { x: index * STEP.person, y: ROW.people }; });
  // Centred over the row of people, so the notes read as the thing the whole team works from.
  const notesWidth = parts.notes.length * STEP.note;
  parts.notes.forEach((note, index) => { layout[note.key] = { x: Math.max(0, Math.round((width - notesWidth) / 2)) + index * STEP.note, y: ROW.notes }; });
  const below = [...parts.docs.map((doc) => ({ key: doc.key, step: STEP.doc })), ...parts.cards.map((card) => ({ key: card.key, step: card.kind === 'board' ? 1040 : STEP.card }))];
  const belowWidth = below.reduce((sum, one) => sum + one.step, 0);
  let at = Math.max(0, Math.round((width - belowWidth) / 2));
  for (const one of below) { layout[one.key] = { x: at, y: ROW.below }; at += one.step; }
  return layout;
}

// The proposal as a framework: the people, the founder's notes as cards wired to every one of them, the shared
// document with the words it starts with, and the drawing. This is what is saved and what is placed; nothing about
// it is the model's guess except the words.
export function frameworkOf(proposal: Proposal, asked: {
  id?: string; intent: string; notes: { id: string; hash: string }[]; version?: number; builtAt?: number; scorecard?: Framework['scorecard'];
}): Framework {
  const taken = new Set([...proposal.rooms, ...proposal.docs, ...proposal.cards].map((one) => one.key));
  const notes = asked.notes.map((note) => ({ ...note, key: freeKey('notes', taken) }));
  const rooms: RoomSpec[] = proposal.rooms.map((person) => ({ ...person, ...ROOM_SIZE }));
  const docs: DocSpec[] = proposal.docs.map((doc) => ({ key: doc.key, title: doc.title, text: doc.text, ...DOC_SIZE }));
  const cards: CardSpec[] = [
    ...proposal.cards.map((card) => ({ key: card.key, kind: card.kind, ...CARD_SIZE[card.kind] }) as CardSpec),
    ...notes.map((note) => ({ key: note.key, kind: 'library' as const, noteId: note.id, ...CARD_SIZE.library })),
  ];
  // Every person reads the founder's notes: that is what the whole team is built out of, and a person wired to the
  // note is given the passages of it that answer the question in front of them.
  const wires: WireSpec[] = [
    ...proposal.wires,
    ...notes.flatMap((note) => proposal.rooms.map((person) => ({ from: note.key, to: person.key }))),
  ];
  return {
    id: asked.id ?? frameworkId(proposal.name),
    name: proposal.name,
    intent: asked.intent.trim(),
    version: asked.version ?? 1,
    builtAt: asked.builtAt ?? Date.now(),
    notes: asked.notes,
    rooms, docs, cards, wires,
    layout: layoutOf({ rooms, docs, cards: proposal.cards, notes }),
    dataset: proposal.dataset,
    ...(asked.scorecard ? { scorecard: asked.scorecard } : {}),
  };
}
