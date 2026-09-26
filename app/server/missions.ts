import { companyTemplate } from '../shared/partner.ts';
import { seedDocs, seedStage, type ChatMessage, type Decision, type Mission, type Stage, type Task } from '../shared/model.ts';

export type Facts = { stage: Stage; chats: Record<string, ChatMessage[]>; docs: Record<string, string>; decisions: Decision[]; tasks: Task[] };
// Steps that reach outside and therefore waited for the founder's yes.
const APPROVED = new Set(['send_email', 'run_code', 'code_task', 'code_reply', 'browse']);
const wordsIn = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);

// What the founder wrote in a doc: no headings, and not the Decisions and Bets sections, which the app writes itself
// once the partner keeps the company document. A decision line landing there is not the founder filling in the brief.
const APP_SECTIONS = /^(decisions|bets)$/i;
export function founderWords(text: string): string {
  let skipping = false;
  return text.split('\n').filter((line) => {
    const heading = /^\s*#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) { skipping = APP_SECTIONS.test(heading[1].trim()); return false; }
    return !skipping;
  }).join('\n');
}

const TEMPLATE = wordsIn([...Object.values(seedDocs), companyTemplate()].join(' '));
// Whether the founder has written something of their own in a doc: eight words the templates do not have, outside
// the headings and the sections the app writes. The same test ticks "fill in the brief" and tells "add partner"
// whether the idea is already there.
export const saysSomething = (text: string) => [...wordsIn(founderWords(text))].filter((word) => !TEMPLATE.has(word)).length >= 8;

// The first-run list. Every tick is read off the workspace: what the founder did shows, whatever was or was not clicked.
export function missionsOf({ stage, chats, docs, decisions, tasks }: Facts): Mission[] {
  const briefed = stage.docs.some((doc) => doc.pinned && saysSomething(docs[doc.id] ?? ''));
  const seedWires = new Set(seedStage.wires.map((wire) => `${wire.from}>${wire.to}`));
  const seedRooms = new Set(seedStage.rooms.map((room) => room.id));
  const acted = Object.values(chats).some((chat) => chat.some((message) => message.tools?.some((tool) => APPROVED.has(tool.name) && tool.ok === true)))
    || tasks.some((task) => task.run?.state === 'done');
  return [
    { id: 'talk', title: 'Talk to someone', tip: 'Type in a person\'s ask box, or press Ctrl K and write "ask Maya to…".', done: Object.values(chats).some((chat) => chat.some((message) => message.role === 'user' && !message.from)) },
    { id: 'brief', title: 'Fill in the company brief', tip: 'Everyone reads the pinned brief in every conversation. A few honest lines about what you sell and to whom change every answer you get.', done: briefed },
    { id: 'wire', title: 'Connect something', tip: 'Drag from a dot on a person to a doc, a card or another person. A wire is what lets them read it, drive it or ask each other.', done: stage.wires.some((wire) => !seedWires.has(`${wire.from}>${wire.to}`)) },
    { id: 'person', title: 'Add a person', tip: 'The dock\'s first button, or Ctrl K and "hire a designer". You name them and write their brief.', done: stage.rooms.some((room) => !seedRooms.has(room.id) && !!room.name.trim()) },
    { id: 'act', title: 'Let someone act', tip: 'Ask for real work: an email, a calculation, a coding task, or run a task on a board. Anything that reaches outside waits for your OK first.', done: acted },
    { id: 'decide', title: 'Record a decision', tip: 'Press D. Write down one thing you decided and why, or ask a person to lay a choice out for you. People work from your decisions afterwards.', done: decisions.some((decision) => decision.status === 'decided') },
  ];
}
