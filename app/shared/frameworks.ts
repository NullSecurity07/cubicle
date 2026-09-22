import type { Card, Doc, Room, Wire } from './model.ts';

// A framework is a team the founder does not have to build twice: people with their briefs, the docs they share, the
// cards they need and the wires between them, kept as one file and placed on the stage in one press. Nothing in here
// says where anything is on the canvas except `layout`, and those places are relative to the group's own top-left
// corner, so the same framework can land anywhere, twice, without two of anything colliding.

// Everything a thing on the stage is except which one it is and where it stands. Written as a distributive
// conditional rather than a plain `Omit`, because `Omit` over a union of card kinds keeps only the fields every kind
// shares: a library card would come out of it having forgotten the one thing it is, which note it holds.
type Unplaced<T> = T extends unknown ? Omit<T, 'id' | 'x' | 'y'> : never;

// `key` is a stable local name inside the framework — 'assumption', 'evaluation', 'browser' — and it is what the
// wires and the layout point at. Ids are minted when the group lands, so nothing here can collide with a stage.
export type RoomSpec = { key: string } & Unplaced<Room>;
// A doc carries the words it starts with. Its size is optional because most docs are happy at the usual size, and a
// framework whose shared doc is the thing everybody writes into wants a bigger one.
export type DocSpec = { key: string; title: string; text: string; pinned?: boolean; w?: number; h?: number };
export type CardSpec = { key: string } & Unplaced<Card>;
// Keys, not ids: a wire inside a framework is "the judge talks to the pain validator", whoever they turn out to be.
export type WireSpec = { from: string; to: string };
export type Spot = { x: number; y: number };

// One test case for a framework's people. `keys` names whose case it is (one person, or several who must both pass
// it); `expected` is there when the founder's notes state an answer, `rubric` when they state criteria instead.
export type Case = { id: string; keys: string[]; input: string; expected?: string; rubric?: string; addedBy: 'forge' | 'founder' };
// The last promoted run's scores. Written by the evals round; nothing reads it yet.
export type Scorecard = { mean: number; byPerson: Record<string, number>; cases: number; at: number; models: string[] };

export type Framework = {
  id: string; name: string; intent: string; version: number; builtAt: number;
  // What it was built from, and the hash of those notes' words at the time: a note edited since is a framework whose
  // briefs may no longer match what the founder learned.
  notes: { id: string; hash: string }[];
  rooms: RoomSpec[]; docs: DocSpec[]; cards: CardSpec[]; wires: WireSpec[];
  layout: Record<string, Spot>;
  dataset: Case[];
  scorecard?: Scorecard;
};

// What a framework becomes on the stage: the rooms, docs, cards and wires to merge into it, with ids of their own.
export type Placed = { rooms: Room[]; docs: Doc[]; cards: Card[]; wires: Wire[] };

// The size a doc is when the framework does not say. Here rather than beside the placing, because the window works
// out how much room a group needs before it has asked for one.
export const DOC_SIZE = { w: 340, h: 300 };
// How much of the canvas this framework will take up. The window needs this before it places anything: it is what
// says whether the group fits where the founder is looking, and what the view is moved to once it has landed.
export function spanOf(framework: Pick<Framework, 'rooms' | 'docs' | 'cards' | 'layout'>): { w: number; h: number } {
  const corners = [
    ...framework.rooms.map((room) => ({ key: room.key, w: room.w, h: room.h })),
    ...framework.docs.map((doc) => ({ key: doc.key, w: doc.w ?? DOC_SIZE.w, h: doc.h ?? DOC_SIZE.h })),
    ...framework.cards.map((card) => ({ key: card.key, w: card.w, h: card.h })),
  ].map((one) => ({ x: (framework.layout[one.key]?.x ?? 0) + one.w, y: (framework.layout[one.key]?.y ?? 0) + one.h }));
  return { w: Math.max(0, ...corners.map((corner) => corner.x)), h: Math.max(0, ...corners.map((corner) => corner.y)) };
}

// The same id rule as a skill and a note: a slug of the name, so the folder in the workspace is the framework the
// founder named.
export const FRAMEWORK_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
export const slugOf = (name: string) => name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
export const frameworkId = (name: string) => slugOf(name) || 'framework';

// The kinds of card in the words the dock uses for them, so a framework is described to the founder in the language
// they added those cards in.
const CARD_NAMES: Record<string, string> = {
  browser: 'browser', project: 'project folder', board: 'task board', note: 'sticky note', image: 'picture',
  link: 'link', library: 'note', imagegen: 'image studio', voicegen: 'voice studio', videogen: 'video studio',
};
const count = (many: number, one: string, more = `${one}s`) => `${many} ${many === 1 ? one : more}`;

// What the founder is about to put on their stage: "5 people · 1 doc · 1 browser · 1 note". Cards keep the order
// they are written in, so a framework's own file decides which of its cards is mentioned first.
export function sizeLine(framework: Pick<Framework, 'rooms' | 'docs' | 'cards'>): string {
  const kinds = new Map<string, number>();
  for (const card of framework.cards) kinds.set(card.kind, (kinds.get(card.kind) ?? 0) + 1);
  return [
    framework.rooms.length ? count(framework.rooms.length, 'person', 'people') : '',
    framework.docs.length ? count(framework.docs.length, 'doc') : '',
    ...[...kinds].map(([kind, many]) => count(many, CARD_NAMES[kind] ?? kind)),
  ].filter(Boolean).join(' · ');
}
