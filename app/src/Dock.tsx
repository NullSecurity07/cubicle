import { Panel } from '@xyflow/react';
import { useEffect, useState } from 'react';
import { preset, type AppKey } from '../shared/apps';
import type { ModelInfo } from '../shared/model';
import { getModels } from './api';
import { listen } from './bus';
import { useAttention } from './overlay/attention';
import { overlay } from './overlay/store';
import { useAddCard, type CardKind } from './addCard';
import { openFrameworks } from './frameworks';
import { openLibrary } from './library';
import { BlocksIcon } from './nodes/FrameworksPanel';
import { pressed } from './keys';

// One ring per model provider: how much of today's free quota is left. Amber under a fifth, red when gone.
function Quota() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const load = () => { getModels().then(setModels).catch(() => {}); };
    load();
    return listen('usage', load);
  }, []);
  if (!models.length) return null;
  const tone = (left: number) => (left <= 0.05 ? 'out' : left < 0.2 ? 'low' : 'fine');
  return (
    <div className="quota">
      <button type="button" className="quota__rings" aria-label="Model usage today" aria-expanded={open} title="Model usage today" onClick={() => setOpen(!open)}>
        {models.map((model) => (
          <svg key={model.name} viewBox="0 0 20 20" className={`ring ring--${tone(model.left)}`} role="img" aria-label={`${model.name}: ${Math.round(model.left * 100)}% left`}>
            <circle cx="10" cy="10" r="7" className="ring__track" />
            <circle cx="10" cy="10" r="7" pathLength={100} strokeDasharray={`${Math.round(model.left * 100)} 100`} transform="rotate(-90 10 10)" />
          </svg>
        ))}
      </button>
      {open && (
        <div className="quota__detail" role="dialog" aria-label="Model usage today">
          {models.map((model) => (
            <div key={model.name} className="quota__row">
              <span className={`quota__dot ring--${tone(model.left)}`} />
              <span className="quota__name">{model.name}<small>{model.model}</small></span>
              <span className="quota__numbers">{Math.round(model.left * 100)}% left<small>{model.requests} replies · {model.tokens.toLocaleString()} tokens · $0</small></span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const MORE: [kind: CardKind, label: string, hint: string][] = [
  ['library', 'Note from library', 'Something you learned, for a person to work from'],
  ['note', 'Sticky note', 'Words a wired person keeps in mind'],
  ['link', 'Link', 'A web page a wired person reads'],
  ['source', 'Source website', 'A site people search when it fits'],
  ['image', 'Picture', 'An image a wired person can see'],
  ['imagegen', 'Image studio', 'Pictures from a few words, free'],
  ['voicegen', 'Voice studio', 'Words said out loud, on this machine'],
  ['videogen', 'Video studio', 'A short narrated film from a brief'],
  ['browser', 'Browser', 'A live browser a wired person drives'],
  ['project', 'Coder', 'OpenCode in a folder, driven by you or a wired person'],
  ['board', 'Task board', 'People propose, you run'],
  ['leads', 'Leads', 'People to sell to, and where each one stands'],
];

// Sites the founder is already signed in to: a browser card that opens as them. "Any app" asks for a name and an address.
const APPS: [key: Exclude<AppKey, 'custom'>, label: string, hint: string][] = [
  ['linkedin', 'LinkedIn', 'People, companies and your feed'],
  ['x', 'X', 'Posts, people and your timeline'],
  ['gmail', 'Gmail', 'Your inbox, read and drafted in'],
];

// The small form behind "Add any app": the founder names the site and says where it lives.
function AnyApp({ onAdd }: { onAdd: (name: string, home: string) => void }) {
  const [name, setName] = useState('');
  const [home, setHome] = useState('');
  const [error, setError] = useState('');
  return (
    <form className="dock__menu dock__app" aria-label="Add any app" onSubmit={(event) => {
      event.preventDefault();
      try { onAdd(name, home); } catch (problem) { setError((problem as Error).message); }
    }}>
      <h6>Any app, signed in as you</h6>
      <label>App name<input autoFocus value={name} placeholder="Notion" onChange={(event) => { setName(event.target.value); setError(''); }} /></label>
      <label>App address<input value={home} placeholder="notion.so" onChange={(event) => { setHome(event.target.value); setError(''); }} /></label>
      {error && <p className="dock__error" role="alert">{error[0].toUpperCase() + error.slice(1)}.</p>}
      <button type="submit" className="dock__submit">Add app</button>
    </form>
  );
}

// The bell: how many things wait for the founder, in the one colour that means "needs you". The window title carries the count too.
function Needs() {
  const count = useAttention().length;
  useEffect(() => { document.title = count ? `(${count}) Stage` : 'Stage'; }, [count]);
  return (
    <button type="button" className={`dock__needs${count ? ' is-waiting' : ''}`} aria-label={count ? `Needs you: ${count} waiting` : 'Needs you: nothing waiting'} title="Needs you" onClick={() => overlay.open({ kind: 'panel', name: 'needs' })}>
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.200 13.500V9a4.800 4.800 0 0 1 9.600 0v4.500l1.400 1.800H3.800zM8.300 17.300a1.900 1.900 0 0 0 3.400 0" /></svg>
      {count > 0 && <b aria-hidden="true">{count > 9 ? '9+' : count}</b>}
    </button>
  );
}

// The only chrome on the stage: add a person, add a doc, and today's model usage. New cards land at the centre of the view.
export function Dock() {
  const addCard = useAddCard();
  const [more, setMore] = useState(false);
  // The menu either lists cards or, after "Add any app", is the small form for one.
  const [anyApp, setAnyApp] = useState(false);
  const close = () => { setMore(false); setAnyApp(false); };
  // A note is picked, not made: the library opens, and the card lands once the founder has chosen or added one.
  const add = (kind: CardKind) => { close(); if (kind === 'library') openLibrary(); else addCard(kind); };
  // preset() throws on a missing name or address; the form shows that and stays open.
  const addApp = (key: AppKey, name?: string, home?: string) => { const app = preset(key, name, home); close(); addCard('browser', { app }); };

  return (
    <Panel position="bottom-center" className="dock">
      <button type="button" aria-label="Add person" title="Add person" onClick={() => add('room')}>
        <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="7" r="3.2" /><path d="M3.8 17c.6-3.4 3-5.2 6.2-5.2s5.6 1.8 6.2 5.2" /></svg>
      </button>
      <button type="button" aria-label="Add doc" title="Add doc" onClick={() => add('doc')}>
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.5 2.5h6L15 6v11.5H5.5zM11.5 2.5V6H15M8 10h4.5M8 13h4.5" /></svg>
      </button>
      <div className="dock__more" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close(); }} onKeyDown={(event) => { if (pressed(event, 'cancel')) close(); }}>
        <button type="button" aria-label="More cards" aria-expanded={more} title="More cards" onClick={() => (more ? close() : setMore(true))}>
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4.500v11M4.500 10h11" /></svg>
        </button>
        {more && !anyApp && (
          <div className="dock__menu" role="menu" aria-label="More cards">
            {/* Two columns, so every row is in view at once: nothing waits below a scroll. */}
            <div className="dock__group">
              <h6 role="presentation">Cards</h6>
              {MORE.map(([kind, label, hint]) => <button key={kind} type="button" role="menuitem" aria-label={`Add ${label.toLowerCase()}`} onClick={() => add(kind)}><b>{label}</b><small>{hint}</small></button>)}
            </div>
            <div className="dock__group dock__group--apps">
              <h6 role="presentation">Apps, signed in as you</h6>
              {APPS.map(([key, label, hint]) => <button key={key} type="button" role="menuitem" aria-label={`Add ${label}`} onClick={() => addApp(key)}><b>{label}</b><small>{hint}</small></button>)}
              <button type="button" role="menuitem" aria-label="Add any app" onClick={() => setAnyApp(true)}><b>Any app</b><small>A site you name, opened as you</small></button>
            </div>
          </div>
        )}
        {more && anyApp && <AnyApp onAdd={(name, home) => addApp('custom', name, home)} />}
      </div>
      <button type="button" aria-label="Frameworks" title="Frameworks: teams that land ready to work" onClick={() => { close(); openFrameworks(); }}>
        <BlocksIcon />
      </button>
      <span className="dock__gap" aria-hidden="true" />
      <button type="button" aria-label="Command bar" title="Find or do anything (Ctrl K)" onClick={() => overlay.open({ kind: 'panel', name: 'command' })}>
        <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="9" cy="9" r="5.200" /><path d="M13 13l3.800 3.800" /></svg>
      </button>
      <button type="button" aria-label="Messages" title="Messages" onClick={() => overlay.open({ kind: 'panel', name: 'messages' })}>
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.500 5.200c0-.9.700-1.700 1.700-1.700h9.600c1 0 1.700.8 1.700 1.700v6.600c0 .9-.7 1.700-1.700 1.700H9l-3.700 3v-3h-.1c-1 0-1.700-.8-1.700-1.700z" /></svg>
      </button>
      <button type="button" aria-label="Decisions" title="Decisions" onClick={() => overlay.open({ kind: 'panel', name: 'decisions' })}>
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3.500v13M5.500 16.500h9M4 6.500h12M4 6.500l-2 5a2.300 2.300 0 0 0 4 0zM16 6.500l-2 5a2.300 2.300 0 0 0 4 0z" /></svg>
      </button>
      <Needs />
      <Quota />
    </Panel>
  );
}
