import { useEdges, useNodes } from '@xyflow/react';
import { useEffect, useState } from 'react';
import type { ChatMessage } from '../../shared/model';
import { getChat, getMemory } from '../api';
import { listen } from '../bus';
import type { StageNode } from '../stage';
import type { Status } from './Chat';

// How a card is named when it is listed somewhere else.
export function labelOf(node: StageNode): string {
  if (node.type === 'room') return node.data.name || 'New person';
  if (node.type === 'doc') return node.data.title || 'Untitled doc';
  if (node.type === 'project') return node.data.path.split('/').filter(Boolean).pop() ?? 'Project';
  if (node.type === 'note') return node.data.text.trim().split('\n')[0].slice(0, 40) || 'Note';
  if (node.type === 'image') return node.data.path.split('/').pop() ?? 'Picture';
  if (node.type === 'link') return node.data.title || node.data.url || 'Link';
  if (node.type === 'imagegen') return 'Image studio';
  return node.type === 'browser' ? 'Browser' : 'Board';
}
const KIND: Record<string, string> = { room: 'can ask', doc: 'reads and writes', browser: 'drives', project: 'hands coding work to', board: 'proposes tasks on', note: 'reads', image: 'sees', link: 'reads', imagegen: 'makes pictures in' };
const compact = (count: number) => (count >= 1000 ? `${(count / 1000).toFixed(count >= 10_000 ? 0 : 1)}k` : String(count));

// Beside a focused person: what they are wired to, what they remember, and what this conversation has cost.
export function RoomSide({ id, name, status, onEditMemory }: { id: string; name: string; status: Status; onEditMemory: () => void }) {
  const nodes = useNodes<StageNode>();
  const edges = useEdges();
  const [memory, setMemory] = useState<{ notes: string; summary: string } | null>(null);
  const [chat, setChat] = useState<ChatMessage[]>([]);

  // Both change only when a turn ends or the founder edits the memory.
  useEffect(() => {
    if (status === 'thinking' || status === 'waiting') return;
    getChat(id).then(setChat).catch(() => {});
    getMemory(id).then(setMemory).catch(() => {});
  }, [id, status]);
  useEffect(() => listen('effect', (effect) => { if (effect.kind === 'memory-changed' && effect.id === id) getMemory(id).then(setMemory).catch(() => {}); }), [id]);

  const wired = edges.filter((edge) => edge.source === id || edge.target === id)
    .map((edge) => nodes.find((node) => node.id === (edge.source === id ? edge.target : edge.source)))
    .filter((node): node is StageNode => !!node);
  const replies = chat.filter((message) => message.role === 'assistant');
  const used = replies.reduce((sum, message) => ({ input: sum.input + (message.usage?.input ?? 0), output: sum.output + (message.usage?.output ?? 0) }), { input: 0, output: 0 });
  const last = replies.at(-1);

  return (
    <aside className="side nowheel" aria-label={`About ${name}`}>
      <section>
        <h3>Wired to</h3>
        {wired.length ? <ul>{wired.map((node) => <li key={node.id}><span>{labelOf(node)}</span><em>{KIND[node.type ?? ''] ?? ''}</em></li>)}</ul>
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
          <div><dt>Replies</dt><dd>{replies.length}</dd></div>
          <div><dt>Tokens read</dt><dd>{compact(used.input)}</dd></div>
          <div><dt>Tokens written</dt><dd>{compact(used.output)}</dd></div>
          {last?.provider && <div><dt>Last answered by</dt><dd>{last.provider}</dd></div>}
        </dl>
      </section>
    </aside>
  );
}
