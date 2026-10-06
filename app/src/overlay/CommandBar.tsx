import { useReactFlow } from '@xyflow/react';
import { useJumpTo } from '../flow';
import { useEffect, useMemo, useRef, useState } from 'react';
import { plainLine } from '../../shared/library';
import type { Hit } from '../../shared/model';
import { useAddCard } from '../addCard';
import { fileUrl, getThreads, search, searchNotes } from '../api';
import { emit } from '../bus';
import { labelOf } from '../nodes/RoomSide';
import type { StageNode } from '../stage';
import { suggest, type Action, type Suggestion } from './commands';
import { capsOf, keysOf, pressed } from '../keys';
import { openNote } from '../library';
import { overlay, showDecision, showPlaybook, showThread } from './store';

const WHERE: Record<Hit['kind'], string> = { doc: 'Doc', chat: 'Conversation', memory: 'Memory', decision: 'Decision', file: 'File', link: 'Web page', skill: 'Playbook', library: 'Note' };
// Said quietly, between where a hit lives and what it says: a search that reaches back a year should not hand the
// founder something from last spring looking exactly like something from this morning.
const date = (at: number) => new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const fromHit = (hit: Hit): Suggestion => ({
  section: 'In the workspace', label: hit.title, hint: `${WHERE[hit.kind]}${hit.at ? ` · ${date(hit.at)}` : ''} · ${hit.text.replace(/\s+/g, ' ').slice(0, 110)}`,
  action: hit.kind === 'chat' ? { do: 'thread', id: hit.id } : hit.kind === 'decision' ? { do: 'decision', id: hit.id } : hit.kind === 'file' ? { do: 'file', path: hit.id }
    : hit.kind === 'memory' ? { do: 'focus', id: hit.id } : hit.kind === 'library' ? { do: 'note', id: hit.id } : { do: 'jump', id: hit.id },
});
// A passage of one of the founder's own notes. It says which note and which heading it was under, because that is how
// they will recognise it, and pressing it opens the note to be read.
const fromNote = (hit: Hit): Suggestion => ({ section: 'Notes', label: hit.title, hint: plainLine(hit.text).slice(0, 110), action: { do: 'note', id: hit.id } });

// One bar for everything: type a few letters of a name, a command in plain words, or what you are looking for.
// Patterns and names answer at once; the workspace search joins a moment later. Nothing typed here is ever guessed at.
export function CommandBar() {
  const { getNodes, fitView } = useReactFlow<StageNode>();
  const addCard = useAddCard();
  const [input, setInput] = useState('');
  // Each search's results remember the words they were for: a result for words no longer in the bar is never shown,
  // so a fast Enter cannot land on what an earlier search found.
  const [hits, setHits] = useState<{ for: string; hits: Hit[] }>({ for: '', hits: [] });
  const [notes, setNotes] = useState<{ for: string; hits: Hit[] }>({ for: '', hits: [] });
  const [answer, setAnswer] = useState('');
  const [at, setAt] = useState(0);
  const list = useRef<HTMLUListElement>(null);

  const known = useMemo(() => ({ cards: getNodes().map((node) => ({ id: node.id, type: node.type ?? '', label: labelOf(node), role: node.type === 'room' ? node.data.role : undefined })) }), [getNodes]);
  // What the founder asked for outright comes first, then what the workspace holds, then the offers to ask someone.
  // The founder's own notes rank above the rest of the workspace: they wrote them to be worked from.
  const offerFor = (text: string) => {
    const typed = suggest(text, known);
    const asked = text.trim();
    if (asked.length < 3) return typed;
    const mine = (found: { for: string; hits: Hit[] }) => (found.for === asked ? found.hits : []);
    return [...typed.filter((one) => !one.fallback), ...mine(notes).map(fromNote), ...mine(hits).map(fromHit), ...typed.filter((one) => one.fallback)];
  };
  const offered = useMemo(() => offerFor(input), [input, known, hits, notes]);

  // Only the search waits on an effect. Nothing here sets state for a keystroke: a state set from an effect after
  // each letter is a second render per letter, and typed fast those pile up until React gives up mid-word.
  useEffect(() => {
    const asked = input.trim();
    if (asked.length < 3) return;
    const stop = new AbortController();
    const soon = setTimeout(() => {
      search(asked, stop.signal).then((found) => setHits({ for: asked, hits: found.hits.slice(0, 6) })).catch(() => {});
      searchNotes(asked, stop.signal).then((found) => setNotes({ for: asked, hits: found.hits.slice(0, 5) })).catch(() => {});
    }, 220);
    return () => { clearTimeout(soon); stop.abort(); };
  }, [input]);
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [at]);

  const close = () => overlay.close({ kind: 'panel', name: 'command' });
  const goTo = useJumpTo();

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
    // A slice's own command: the bar has no idea what it does, only that the founder chose it.
    if (action.do === 'run') return action.run();
    if (action.do === 'add') addCard(action.kind, action.data);
    if (action.do === 'jump') goTo(action.id);
    if (action.do === 'focus') overlay.open({ kind: 'focus', id: action.id });
    // Every way into the playbook says where to look in it; asked for by name, it opens on the whole company.
    if (action.do === 'panel') { if (action.name === 'playbook') showPlaybook({}); overlay.open({ kind: 'panel', name: action.name }); }
    if (action.do === 'thread') { showThread(action.id); overlay.open({ kind: 'panel', name: 'messages' }); }
    if (action.do === 'decision') { showDecision(action.id); overlay.open({ kind: 'panel', name: 'decisions' }); }
    if (action.do === 'new-decision') { showDecision('new'); overlay.open({ kind: 'panel', name: 'decisions' }); }
    if (action.do === 'note') openNote(action.id);
    if (action.do === 'file') window.open(fileUrl(action.path), '_blank', 'noreferrer');
    if (action.do === 'fit') void fitView({ duration: 450, padding: 0.15, maxZoom: 1 });
    if (action.do === 'keys') overlay.open({ kind: 'panel', name: 'keys' });
    // The question goes into that person's own ask box, and their card comes forward so the answer is seen.
    if (action.do === 'ask') { overlay.open({ kind: 'focus', id: action.roomId }); emit('ask', { roomId: action.roomId, text: action.text }); }
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (pressed(event, 'command-down')) { event.preventDefault(); setAt((at + 1) % Math.max(1, offered.length)); }
    if (pressed(event, 'command-up')) { event.preventDefault(); setAt((at - 1 + offered.length) % Math.max(1, offered.length)); }
    // Enter works the suggestions out again from what is in the bar this instant, never from a list drawn for
    // fewer letters: typed fast, "add a partner called Sam" must add Sam.
    if (pressed(event, 'command-run')) {
      const now = offerFor((event.target as HTMLInputElement).value);
      const chosen = now[Math.min(at, now.length - 1)];
      if (chosen) { event.preventDefault(); run(chosen.action); }
    }
  }

  // A letter typed is one render: the words, the first suggestion chosen again, and last question's answer gone.
  function typed(event: React.ChangeEvent<HTMLInputElement>) {
    setInput(event.target.value);
    if (at !== 0) setAt(0);
    if (answer) setAnswer('');
  }

  let section = '';
  return (
    <section className="command" role="dialog" aria-modal="true" aria-label="Command bar">
      <input autoFocus role="combobox" aria-expanded="true" aria-controls="command-list" aria-label="Command or search" placeholder={'Try "hire a designer", "ask Maya to…", or a few words you remember'} value={input} onChange={typed} onKeyDown={onKeyDown} />
      {answer && <p className="command__answer" role="status">{answer}</p>}
      <ul id="command-list" role="listbox" aria-label="Suggestions" ref={list}>
        {offered.map((one, index) => {
          const head = one.section !== section ? (section = one.section) : '';
          return (
            <li key={`${one.section}-${one.label}-${index}`} role="presentation">
              {head && <h3>{head}</h3>}
              <button type="button" role="option" aria-selected={index === at} onMouseMove={() => { if (index !== at) setAt(index); }} onClick={() => run(one.action)}>
                <b>{one.label}</b>{one.hint && <small>{one.hint}</small>}
              </button>
            </li>
          );
        })}
      </ul>
      <footer><span><Caps id="command-up" /><Caps id="command-down" /> move</span><span><Caps id="command-run" /> run</span><span><Caps id="back" /> close</span></footer>
    </section>
  );
}

// The first key a shortcut answers to, as the key caps the founder sees on their own keyboard.
const Caps = ({ id }: { id: string }) => <>{capsOf(keysOf(id)[0]).map((cap) => <kbd key={cap}>{cap}</kbd>)}</>;
