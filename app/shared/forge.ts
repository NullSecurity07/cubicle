import type { Case, Framework, WireSpec } from './frameworks.ts';

// The forge: the founder chooses notes and says what they want a team for, and a model proposes one. What travels
// between the two sides is this — a proposal the founder can edit before anything is built, and a job they can watch
// while it is. Nothing here is on the stage yet: a forge job ends with a framework saved, and placing it is the
// founder's own press.

// One person as the forge proposes them. The same fields a room on the stage has, minus everywhere it could stand:
// the layout is worked out when the framework is written, so adding or removing somebody in the preview cannot leave
// a hole in the drawing.
export type Person = { key: string; name: string; role: string; accent: string; brief: string };
export type ProposalDoc = { key: string; title: string; text: string };
// Only the two cards a team can be given without the founder having to set anything up first. A browser needs no
// key and a board needs no account; a project folder, a mailbox or a studio would be a card that cannot work until
// the founder goes and connects something, which is not what lands in one press.
export type ProposalCard = { key: string; kind: 'browser' | 'board' };
export type Proposal = {
  name: string;
  rooms: Person[]; docs: ProposalDoc[]; cards: ProposalCard[]; wires: WireSpec[];
  dataset: Case[];
};

// Read the notes, propose the team, let the founder look at it, write the briefs, run the cases, and it is theirs.
// `previewing` is where a job waits for the founder: nothing is spent while it sits there.
export type ForgeState = 'reading' | 'proposing' | 'previewing' | 'building' | 'testing' | 'done' | 'failed';
export const FORGE_STEPS = ['Read', 'Propose', 'Preview', 'Build', 'Test', 'Place'] as const;

// `quick` proves the shape of a team in about a minute; `full` writes a second brief for every person, scores both
// and rewrites the winner once. `calls` is what has really been spent, counted one model call at a time.
export type ForgeMode = 'quick' | 'full';
export type ForgeJob = {
  id: string; state: ForgeState; mode: ForgeMode; lines: string[];
  proposal?: Proposal; framework?: Framework;
  // One line about each person's winning brief, from the judge that scored it. The scorecard carries the numbers;
  // this is the sentence that says what the number is about.
  critiques?: Record<string, string>;
  calls: number; error?: string;
};

// What a mode costs, roughly, so the founder chooses knowing. Five people, three cases each: `full` writes two briefs
// each and rewrites the winner, `quick` asks one brief one case.
export const CALLS: Record<ForgeMode, number> = { quick: 12, full: 60 };
export const callsLine = (mode: ForgeMode) => `about ${CALLS[mode]} calls`;

// A progress line as it goes out on the window's one live feed.
export type ForgeLine = { kind: 'forge'; jobId: string; line: string };
export const FORGE_CHANNEL = 'forge';
