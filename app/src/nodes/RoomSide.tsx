import { useEffect, useState } from 'react';
import { builtFrom, casesFor } from '../../shared/evals';
import type { ChatMessage, Room } from '../../shared/model';
import { safeHost } from '../../shared/sources';
import { getChat, getMemory, watchMemory } from '../api';
import { listen } from '../bus';
import { useFlowPick, useWired } from '../flow';
import { useFrameworks } from '../frameworks';
import { compact } from '../numbers';
import { useNotes } from '../library';
import { SLICES } from '../slices';
import type { StageNode } from '../stage';
import type { Status } from './Chat';

// How a card is named when it is listed somewhere else.
export function labelOf(node: StageNode, notes: { id: string; title: string }[] = []): string {
  if (node.type === 'room') return node.data.name || 'New person';
  // A note card only says which note it is; its name is the note's title, kept in the library.
  if (node.type === 'library') return notes.find((note) => note.id === node.data.noteId)?.title ?? 'Note from the library';
  if (node.type === 'doc') return node.data.title || 'Untitled doc';
  // A card the founder has put down but not filled in yet (a picture card with no picture, a project with no folder)
  // has none of these, and a name for a list must never be the thing that takes the whole window down.
  if (node.type === 'project') return (node.data.path ?? '').split('/').filter(Boolean).pop() ?? 'Project';
  if (node.type === 'note') return (node.data.text ?? '').trim().split('\n')[0].slice(0, 40) || 'Note';
  if (node.type === 'image') return (node.data.path ?? '').split('/').pop() || 'Picture';
  if (node.type === 'link') return node.data.title || node.data.url || 'Link';
  if (node.type === 'imagegen') return 'Image studio';
  if (node.type === 'voicegen') return 'Voice studio';
  if (node.type === 'videogen') return 'Video studio';
  if (node.type === 'leads') return 'Leads';
  // A source is named the way people name it when they search it: its title, else its site.
  if (node.type === 'source') return node.data.title?.trim() || safeHost(node.data.url ?? '') || 'Source';
  // A browser signed in to an app is that app to the founder: "LinkedIn", not "Browser".
  if (node.type === 'browser') return node.data.app?.name || 'Browser';
  return 'Board';
}
const KIND: Record<string, string> = { room: 'can ask', doc: 'reads and writes', browser: 'drives', project: 'gives coding work to', board: 'proposes tasks on', leads: 'keeps leads on', note: 'reads', image: 'sees', link: 'reads', source: 'searches', imagegen: 'makes pictures in', voicegen: 'speaks in', videogen: 'makes films in', library: 'reads' };

// Where a person came from, when they came from a saved team: which of the founder's notes they were written out of,
// and what they scored on the founder's own test cases the last time anybody asked. Nothing is said at all about a
// person the founder made by hand, or about a team nobody has scored yet — a line with no number in it would only be
// furniture.
function BuiltFrom({ stamp }: { stamp?: Room['framework'] }) {
  const frameworks = useFrameworks();
  const notes = useNotes();
  const held = stamp ? frameworks.find((one) => one.id === stamp.id) : undefined;
  const score = stamp && held?.scorecard?.byPerson[stamp.key];
  if (!stamp || !held || score === undefined) return null;
  const noteId = held.notes[0]?.id;
  return (
    <p className="side__from">
      {builtFrom({
        noteTitle: notes.find((note) => note.id === noteId)?.title,
        frameworkName: held.name, score, cases: casesFor(held.dataset, stamp.key),
      })}
    </p>
  );
}

// Beside a focused person: where they came from, what they are wired to, what they remember, and what this
// conversation has cost.
export function RoomSide({ id, name, status, onEditMemory }: { id: string; name: string; status: Status; onEditMemory: () => void }) {
  const notes = useNotes();
  const [memory, setMemory] = useState<{ notes: string; summary: string } | null>(null);
  // Null until the conversation has been read: a view that could not read it said "Replies 0", which is a lie about
  // a conversation full of words rather than a view that is not ready yet.
  const [chat, setChat] = useState<ChatMessage[] | null>(null);

  // Both change only when a turn ends or the founder edits the memory.
  useEffect(() => {
    if (status === 'thinking' || status === 'waiting') return;
    getChat(id).then(setChat).catch(() => {});
    getMemory(id).then(setMemory).catch(() => {});
  }, [id, status]);
  useEffect(() => listen('effect', (effect) => { if (effect.kind === 'memory-changed' && effect.id === id) getMemory(id).then(setMemory).catch(() => {}); }), [id]);
  useEffect(() => watchMemory(id, () => { getMemory(id).then(setMemory).catch(() => {}); }), [id]);

  // What this panel reads of the canvas, and nothing else: a card dragged elsewhere does not draw it again.
  const me = useFlowPick(({ nodes }) => { const node = nodes.find((one) => one.id === id); return node?.type === 'room' ? node.data : null; });
  const wired = useWired(id) as unknown as StageNode[];
  const replies = (chat ?? []).filter((message) => message.role === 'assistant');
  const used = replies.reduce((sum, message) => ({ input: sum.input + (message.usage?.input ?? 0), output: sum.output + (message.usage?.output ?? 0) }), { input: 0, output: 0 });
  const last = replies.at(-1);

  return (
    <aside className="side nowheel" aria-label={`About ${name}`}>
      {me && <BuiltFrom stamp={me.framework} />}
      {/* What a slice knows about this person that the stage does not: the voice they answer in. */}
      {me && SLICES.map((slice) => (slice.person ? <slice.person key={slice.name} roomId={id} room={me} /> : null))}
      <section>
        <h3>Wired to</h3>
        {wired.length ? <ul>{wired.map((node) => <li key={node.id}><span>{labelOf(node, notes)}</span><em>{KIND[node.type ?? ''] ?? ''}</em></li>)}</ul>
          : <p className="side__none">Nothing yet. Drag a line from {name} to a doc, a card or another person.</p>}
      </section>
      <section>
        <h3>Remembers <button type="button" onClick={onEditMemory}>Edit</button></h3>
        {memory?.notes.trim() ? <p className="side__text">{memory.notes.trim()}</p> : <p className="side__none">No notes yet.</p>}
        {memory?.summary.trim() && <><h4>Earlier conversation, in short</h4><p className="side__text">{memory.summary.trim()}</p></>}
      </section>
      <section>
        <h3>This conversation</h3>
        <dl>
          <div><dt>Replies</dt><dd>{chat ? replies.length : '—'}</dd></div>
          <div><dt>Tokens read</dt><dd>{chat ? compact(used.input) : '—'}</dd></div>
          <div><dt>Tokens written</dt><dd>{chat ? compact(used.output) : '—'}</dd></div>
          {last?.provider && <div><dt>Last answered by</dt><dd>{last.provider}</dd></div>}
        </dl>
      </section>
    </aside>
  );
}
