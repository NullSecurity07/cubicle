import { useReactFlow } from '@xyflow/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Hit } from '../../shared/model';
import { useAddCard } from '../addCard';
import { fileUrl, getThreads, search } from '../api';
import { emit } from '../bus';
import { labelOf } from '../nodes/RoomSide';
import type { StageNode } from '../stage';
import { KEYS, suggest, type Action, type Suggestion } from './commands';
import { overlay, showDecision, showThread } from './store';

const WHERE: Record<Hit['kind'], string> = { doc: 'Doc', chat: 'Conversation', memory: 'Memory', decision: 'Decision', file: 'File', link: 'Web page', skill: 'Playbook' };
const fromHit = (hit: Hit): Suggestion => ({
  section: 'In the workspace', label: hit.title, hint: `${WHERE[hit.kind]} · ${hit.text.replace(/\s+/g, ' ').slice(0, 110)}`,
  action: hit.kind === 'chat' ? { do: 'thread', id: hit.id } : hit.kind === 'decision' ? { do: 'decision', id: hit.id } : hit.kind === 'file' ? { do: 'file', path: hit.id }
    : hit.kind === 'memory' ? { do: 'focus', id: hit.id } : { do: 'jump', id: hit.id },
});

// One bar for everything: type a few letters of a name, a command in plain words, or what you are looking for.
// Patterns and names answer at once; the workspace search joins a moment later. Nothing typed here is ever guessed at.
export function CommandBar() {
  const { getNodes, setNodes, fitView } = useReactFlow<StageNode>();
  const addCard = useAddCard();
  const [input, setInput] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [answer, setAnswer] = useState('');
  const [at, setAt] = useState(0);
  const list = useRef<HTMLUListElement>(null);

  const known = useMemo(() => ({ cards: getNodes().map((node) => ({ id: node.id, type: node.type ?? '', label: labelOf(node), role: node.type === 'room' ? node.data.role : undefined })) }), [getNodes]);
  const typed = useMemo(() => suggest(input, known), [input, known]);
  // What the founder asked for outright comes first, then what the workspace holds, then the offers to ask someone.
  const offered = useMemo(() => {
    const found = hits.map(fromHit);
    return input.trim().length < 3 ? typed : [...typed.filter((one) => !one.fallback), ...found, ...typed.filter((one) => one.fallback)];
  }, [typed, hits, input]);

  useEffect(() => {
    setAt(0); setAnswer('');
    const asked = input.trim();
    if (asked.length < 3) { setHits([]); return; }
    const stop = new AbortController();
    const soon = setTimeout(() => { search(asked, stop.signal).then((found) => setHits(found.hits.slice(0, 6))).catch(() => {}); }, 220);
    return () => { clearTimeout(soon); stop.abort(); };
  }, [input]);
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [at]);

  const close = () => overlay.close({ kind: 'panel', name: 'command' });
  const goTo = (id: string) => { setNodes((nodes) => nodes.map((node) => ({ ...node, selected: node.id === id }))); void fitView({ nodes: [{ id }], duration: 450, maxZoom: 1, padding: 0.35 }); };

  function run(action: Action) {
    if (action.do === 'idle') {
      void getThreads().then((threads) => {
        const rooms = threads.filter((thread) => thread.kind === 'room');
        const busy = rooms.filter((thread) => thread.live).map((thread) => thread.title);
        const idle = rooms.filter((thread) => !thread.live).map((thread) => thread.title);
        setAnswer(`${idle.length ? `Idle: ${idle.join(', ')}.` : 'Nobody is idle.'}${busy.length ? ` Working: ${busy.join(', ')}.` : ''}`);
      }).catch(() => setAnswer('Could not ask the server.'));
      return;
    }
    close();
    if (action.do === 'add') addCard(action.kind, action.data);
    if (action.do === 'jump') goTo(action.id);
    if (action.do === 'focus') overlay.open({ kind: 'focus', id: action.id });
    if (action.do === 'panel') overlay.open({ kind: 'panel', name: action.name });
    if (action.do === 'thread') { showThread(action.id); overlay.open({ kind: 'panel', name: 'messages' }); }
    if (action.do === 'decision') { showDecision(action.id); overlay.open({ kind: 'panel', name: 'decisions' }); }
    if (action.do === 'new-decision') { showDecision('new'); overlay.open({ kind: 'panel', name: 'decisions' }); }
    if (action.do === 'file') window.open(fileUrl(action.path), '_blank', 'noreferrer');
    if (action.do === 'fit') void fitView({ duration: 450, padding: 0.15, maxZoom: 1 });
    if (action.do === 'keys') overlay.open({ kind: 'panel', name: 'keys' });
    // The question goes into that person's own ask box, and their card comes forward so the answer is seen.
    if (action.do === 'ask') { overlay.open({ kind: 'focus', id: action.roomId }); emit('ask', { roomId: action.roomId, text: action.text }); }
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'ArrowDown') { event.preventDefault(); setAt((at + 1) % Math.max(1, offered.length)); }
    if (event.key === 'ArrowUp') { event.preventDefault(); setAt((at - 1 + offered.length) % Math.max(1, offered.length)); }
    if (event.key === 'Enter' && offered[at]) { event.preventDefault(); run(offered[at].action); }
  }

  let section = '';
  return (
    <section className="command" role="dialog" aria-modal="true" aria-label="Command bar">
      <input autoFocus role="combobox" aria-expanded="true" aria-controls="command-list" aria-label="Command or search" placeholder={'Try "hire a designer", "ask Maya to…", or a few words you remember'} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={onKeyDown} />
      {answer && <p className="command__answer" role="status">{answer}</p>}
      <ul id="command-list" role="listbox" aria-label="Suggestions" ref={list}>
        {offered.map((one, index) => {
          const head = one.section !== section ? (section = one.section) : '';
          return (
            <li key={`${one.section}-${one.label}-${index}`} role="presentation">
              {head && <h3>{head}</h3>}
              <button type="button" role="option" aria-selected={index === at} onMouseMove={() => setAt(index)} onClick={() => run(one.action)}>
                <b>{one.label}</b>{one.hint && <small>{one.hint}</small>}
              </button>
            </li>
          );
        })}
      </ul>
      <footer><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> run</span><span><kbd>Esc</kbd> close</span></footer>
    </section>
  );
}

export function KeysSheet() {
  return (
    <section className="command command--keys" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
      <h2>Keyboard shortcuts</h2>
      <dl>{KEYS.map((key) => <div key={key.keys}><dt>{key.keys.split(' ').map((part) => <kbd key={part}>{part}</kbd>)}</dt><dd>{key.what}</dd></div>)}</dl>
    </section>
  );
}
