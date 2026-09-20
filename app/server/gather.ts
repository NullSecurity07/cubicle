import type { Stage } from '../shared/model.ts';
import type { Decisions } from './decisions.ts';
import type { Piece } from './recall.ts';
import type { Skills } from './skills.ts';
import type { Store } from './store.ts';

export const TEXT_FILE = /\.(txt|md|markdown|csv|tsv|json|ya?ml|xml|html?|css|js|mjs|ts|tsx|jsx|py|rb|go|rs|java|c|h|cpp|sh|sql|log|ini|toml|env)$/i;

// Everything in the workspace that holds words, read fresh: docs, each room's talk and memory, decisions, text files
// in the shared folder, the pages behind link cards, and the playbook. This is what recall searches.
export const gatherPieces = (store: Store, decisions: Decisions, readMemory: (roomId: string) => Promise<{ notes: string; summary: string }>, skills?: Skills) => async (): Promise<Piece[]> => {
  const stage: Stage = await store.loadStage();
  const pieces: Piece[] = [];
  for (const doc of stage.docs) pieces.push({ kind: 'doc', id: doc.id, title: doc.title, text: await store.readDoc(doc.id).catch(() => '') });
  for (const room of stage.rooms) {
    const chat = await store.readChat(room.id).catch(() => []);
    const said = chat.filter((message) => message.text.trim()).map((message) => `${message.role === 'assistant' ? room.name : message.from ? `${message.from} (colleague)` : 'Founder'}: ${message.text.trim()}`);
    if (said.length) pieces.push({ kind: 'chat', id: room.id, roomId: room.id, title: `Conversation with ${room.name}`, text: said.join('\n\n'), at: chat.at(-1)?.at });
    const memory = await readMemory(room.id).catch(() => ({ notes: '', summary: '' }));
    const kept = [memory.notes.trim() && `Notes:\n${memory.notes.trim()}`, memory.summary.trim() && `Earlier conversation, in short:\n${memory.summary.trim()}`].filter(Boolean).join('\n\n');
    if (kept) pieces.push({ kind: 'memory', id: room.id, roomId: room.id, title: `What ${room.name} remembers`, text: kept });
  }
  for (const decision of await decisions.list()) {
    pieces.push({ kind: 'decision', id: decision.id, title: decision.title, at: decision.decidedAt ?? decision.at, text: [
      decision.status === 'decided' ? `Decided: ${decision.chosen}` : `Not decided yet; proposed by ${decision.proposedBy ?? 'someone'}.`,
      decision.why && `Why: ${decision.why}`, decision.effect && `Expected effect: ${decision.effect}`, decision.context && `Context: ${decision.context}`,
      decision.options.length && `Options: ${decision.options.join('; ')}`,
    ].filter(Boolean).join('\n\n') });
  }
  for (const name of await store.listFiles().catch(() => [])) {
    if (!TEXT_FILE.test(name)) continue;
    const bytes = await store.readFileBytes(name);
    if (bytes && bytes.length <= 400_000) pieces.push({ kind: 'file', id: name, title: name, text: bytes.toString('utf8') });
  }
  // A skill that is off or gone quiet is out of every prompt, so it is out of recall too: the panel is where it lives.
  for (const skill of (await skills?.list().catch(() => [])) ?? []) {
    if (skill.state === 'active') pieces.push({ kind: 'skill', id: skill.id, title: skill.name, text: `${skill.when}\n\n${skill.procedure.join('\n')}` });
  }
  for (const card of stage.cards ?? []) {
    if (card.kind !== 'link') continue;
    const page = await store.readPage(card.id).catch(() => null);
    if (page?.text) pieces.push({ kind: 'link', id: card.id, title: page.title || card.url, text: page.text });
  }
  return pieces.filter((piece) => piece.text.trim());
};
