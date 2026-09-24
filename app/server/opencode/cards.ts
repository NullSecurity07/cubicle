import { basename } from 'node:path';
import type { Card, Stage } from '../../shared/model.ts';
import { projectDir } from '../folder.ts';
import { wired } from '../prompt.ts';

// The coder card as the coder slice and the map slice both read it: the one place that says what a project card is,
// what it is called, and which one a room is wired to.
export type Project = Extract<Card, { kind: 'project' }>;
export type CardRef = { id: string; dir: string; name: string; session?: string; model?: string };

// The coder's tools by name, kept beside the card they need. `context/offer.ts` should read CODER_TOOLS rather than
// spell them out, and the safety net reads CODER_WORK: the two that change files and so get a checkpoint first.
export const CODER_TOOLS = ['code_task', 'code_reply', 'code_stop', 'code_status'] as const;
export const CODER_WORK = ['code_task', 'code_reply'] as const;

export const projects = (stage: Stage) => (stage.cards ?? []).filter((card): card is Project => card.kind === 'project');
export const nameOf = (card: Project) => basename(card.path.trim().replace(/\/+$/, '')) || 'Project';
// The card as the coder needs it: the folder checked, its name, and whatever session and model the stage holds.
export const refOf = (card: Project, forbidden: string[]): CardRef => ({ id: card.id, dir: projectDir(card.path, forbidden), name: nameOf(card), session: card.session, model: card.model });
// The coder card wired to one room, the first one if several are.
export function wiredProject(stage: Stage, roomId: string): Project | undefined {
  const cards = projects(stage);
  const [id] = wired(stage, roomId, cards.map((one) => one.id));
  return cards.find((one) => one.id === id);
}
