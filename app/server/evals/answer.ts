import type { Proposal } from '../../shared/forge.ts';
import type { Case } from '../../shared/frameworks.ts';
import type { ChatMessage } from '../../shared/model.ts';
import { scratchStage } from '../forge/build.ts';
import { noteOf, notesBlock } from '../library/notes.ts';
import { runTurn } from '../loop.ts';
import { buildMessages } from '../prompt.ts';
import { promptSize, type ModelClient } from '../providers.ts';
import type { createRecall } from '../recall.ts';
import { route } from '../router.ts';
import type { Store } from '../store.ts';
import { JUDGE_CHUNKS } from './score.ts';

// Putting one question to one person, on a stage that exists only for the length of the answer. The forge does this
// to choose between two briefs and the evals do it to score the briefs a framework already has, and it has to be the
// same machinery both times — a rerun that answered questions a slightly different way would be measuring the
// machinery rather than the team.
//
// Nothing here touches the founder's own stage. The people live in a `Stage` held in memory, the ids say `forge-` out
// loud, no tool is offered (a team is measured on its judgement, not on what it can go and fetch), and nothing that
// is said is written anywhere but the run file.

// The passages of the founder's notes that answer one question, asked for once and kept. The same three go to the
// person answering and to the judge scoring them, which is the only way the two can be talking about the same thing;
// each keeps the note it came from, because a person is told which of the founder's notes they are reading.
export type Passage = { title: string; text: string };

export function createPassages(asked: {
  recall: ReturnType<typeof createRecall>; noteIds: string[]; titleOf: (noteId: string) => string; top?: number;
}): (kase: Case) => Promise<Passage[]> {
  const kept = new Map<string, Passage[]>();
  return async (kase: Case) => {
    const known = kept.get(kase.id);
    if (known) return known;
    const hits = await asked.recall.search(kase.input, {
      allow: (piece) => asked.noteIds.includes(noteOf(piece.id)), top: asked.top ?? JUDGE_CHUNKS,
    });
    const found = hits.map((hit) => ({ title: asked.titleOf(noteOf(hit.id)), text: hit.text }));
    kept.set(kase.id, found);
    return found;
  };
}

export const NO_TOOLS = 'No tools are open to you in this conversation, whatever your brief names: do not call one. '
  + 'Answer in words, and where you would look something up or write to a doc, say what you would do and what you need from the founder first.';

// One whole turn of one person, with one brief, against one case. No `tools` and no `tool_choice` go out with the
// request: an empty list or a `tool_choice` of none is what confuses gpt-oss into calling a tool anyway.
export async function answerCase(asked: {
  team: Pick<Proposal, 'rooms' | 'docs' | 'wires'>; noteIds: string[];
  key: string; brief: string; input: string; passages: Passage[];
  store: Store; clients: ModelClient[]; usage: Parameters<typeof route>[1];
  signal?: AbortSignal;
}): Promise<{ text: string; provider?: string }> {
  const team = { ...asked.team, rooms: asked.team.rooms.map((one) => (one.key === asked.key ? { ...one, brief: asked.brief } : one)) };
  const stage = scratchStage(team, asked.noteIds);
  const roomId = `forge-${asked.key}`;
  const docs = Object.fromEntries(team.docs.map((doc) => [`forge-${doc.key}`, doc.text]));
  const history: ChatMessage[] = [{ id: 'case', role: 'user', text: asked.input, at: Date.now() }];
  const [system, ...rest] = buildMessages(stage, roomId, docs, history);
  // The founder's notes reach the person exactly as they would on their own stage: the passages that answer this
  // question, under the name of the note. The library's seam cannot do it here — it reads the founder's saved stage,
  // and this stage was never saved — so the block is added the same way, by hand.
  const byNote = [...new Set(asked.passages.map((one) => one.title))]
    .map((title) => ({ title, chunks: asked.passages.filter((one) => one.title === title).map((one) => one.text) }));
  const block = notesBlock(byNote);
  // No tool is offered here, but the brief still names the ones the person has on the stage, and gpt-oss will reach
  // for one it was told about — a call Groq then refuses with a 400. Said once, plainly, so the answer is in words.
  const extra = [block, NO_TOOLS].filter(Boolean).join('\n\n');
  const messages = [system.role === 'system' ? { ...system, content: `${system.content}\n\n${extra}` } : system, ...rest];
  const { order } = route(asked.clients, asked.usage, { promptChars: promptSize(messages), tools: false });
  const reply = await runTurn({
    messages, tools: [], clients: order, usage: asked.usage, signal: asked.signal, source: 'run', query: asked.input,
    context: { stage, roomId, store: asked.store, granted: new Map() },
    events: { token: () => {}, tool: () => {} },
  });
  return { text: reply.text, ...(reply.provider ? { provider: reply.provider } : {}) };
}
