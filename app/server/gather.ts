import type { ChatMessage, Stage } from '../shared/model.ts';
import { dayKey } from './clock.ts';
import type { Decisions } from './decisions.ts';
import type { Piece } from './recall.ts';
import type { Skills } from './skills.ts';
import type { Store } from './store.ts';

export const TEXT_FILE = /\.(txt|md|markdown|csv|tsv|json|ya?ml|xml|html?|css|js|mjs|ts|tsx|jsx|py|rb|go|rs|java|c|h|cpp|sh|sql|log|ini|toml|env)$/i;

// A whole conversation is not one moment. Dated by its last message it would stamp something said in July with a day
// in September, and recall is the one tool whose whole purpose is reaching back, so the talk is gathered a day at a
// time: whatever passage is cut out of one of these, the day it carries is true of every word in it.
const byDay = (messages: ChatMessage[]): ChatMessage[][] => {
  const days = new Map<string, ChatMessage[]>();
  for (const message of messages) {
    const key = dayKey(message.at);
    days.set(key, [...(days.get(key) ?? []), message]);
  }
  return [...days.values()];
};

// Everything in the workspace that holds words, read fresh: docs, each room's talk and memory, decisions, text files
// in the shared folder, the pages behind link cards, and the playbook. This is what recall searches. Each piece
// carries when it is from, where there is an honest answer; a memory has none, so it goes undated rather than guessed.
// `kinds` reads only those: the playbook asks for skills on every turn, and reading every doc, chat and file in the
// workspace to find them is most of what a turn cost before it had started.
export const gatherPieces = (store: Store, decisions: Decisions, readMemory: (roomId: string) => Promise<{ notes: string; summary: string }>, skills?: Skills) => async (kinds?: ReadonlySet<Piece['kind']>): Promise<Piece[]> => {
  const want = (kind: Piece['kind']) => !kinds || kinds.has(kind);
  const stage: Stage = await store.loadStage();
  const pieces: Piece[] = [];
  if (want('doc')) for (const doc of stage.docs) pieces.push({ kind: 'doc', id: doc.id, title: doc.title, text: await store.readDoc(doc.id).catch(() => ''), at: await store.docTime(doc.id).catch(() => undefined) });
  if (want('chat') || want('memory')) for (const room of stage.rooms) {
    const chat = want('chat') ? await store.readChat(room.id).catch(() => []) : [];
    const said = (message: ChatMessage) => `${message.role === 'assistant' ? room.name : message.from ? `${message.from} (colleague)` : 'Founder'}: ${message.text.trim()}`;
    // A turn that failed is not something anybody said, so recall never brings it back.
    for (const day of byDay(chat.filter((message) => message.text.trim() && !message.failed))) {
      pieces.push({ kind: 'chat', id: room.id, roomId: room.id, title: `Conversation with ${room.name}`, text: day.map(said).join('\n\n'), at: day.at(-1)!.at });
    }
    if (!want('memory')) continue;
    const memory = await readMemory(room.id).catch(() => ({ notes: '', summary: '' }));
    const kept = [memory.notes.trim() && `Notes:\n${memory.notes.trim()}`, memory.summary.trim() && `Earlier conversation, in short:\n${memory.summary.trim()}`].filter(Boolean).join('\n\n');
    if (kept) pieces.push({ kind: 'memory', id: room.id, roomId: room.id, title: `What ${room.name} remembers`, text: kept });
  }
  if (want('decision')) for (const decision of await decisions.list()) {
    pieces.push({ kind: 'decision', id: decision.id, title: decision.title, at: decision.decidedAt ?? decision.at, text: [
      decision.status === 'decided' ? `Decided: ${decision.chosen}` : `Not decided yet; proposed by ${decision.proposedBy ?? 'someone'}.`,
      decision.why && `Why: ${decision.why}`, decision.effect && `Expected effect: ${decision.effect}`, decision.context && `Context: ${decision.context}`,
      decision.options.length && `Options: ${decision.options.join('; ')}`,
    ].filter(Boolean).join('\n\n') });
  }
  if (want('file')) for (const name of await store.listFiles().catch(() => [])) {
    if (!TEXT_FILE.test(name)) continue;
    const bytes = await store.readFileBytes(name);
    if (bytes && bytes.length <= 400_000) pieces.push({ kind: 'file', id: name, title: name, text: bytes.toString('utf8'), at: await store.fileTime(name).catch(() => undefined) });
  }
  // A skill that is off or gone quiet is out of every prompt, so it is out of recall too: the panel is where it lives.
  if (want('skill')) for (const skill of (await skills?.list().catch(() => [])) ?? []) {
    if (skill.state === 'active') pieces.push({ kind: 'skill', id: skill.id, title: skill.name, text: `${skill.when}\n\n${skill.procedure.join('\n')}`, at: skill.usedAt ?? skill.createdAt });
  }
  if (want('link')) for (const card of stage.cards ?? []) {
    if (card.kind !== 'link') continue;
    const page = await store.readPage(card.id).catch(() => null);
    if (page?.text) pieces.push({ kind: 'link', id: card.id, title: page.title || card.url, text: page.text, at: await store.pageTime(card.id).catch(() => undefined) });
  }
  return pieces.filter((piece) => piece.text.trim());
};
