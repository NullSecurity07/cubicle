import { Panel } from '@xyflow/react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { preset, type AppKey } from '../shared/apps';
import { useAttention } from './overlay/attention';
import { overlay, useLayers } from './overlay/store';
import { useDockPlace } from './dockPlace';
import { useAddCard, type CardKind } from './addCard';
import { openFrameworks } from './frameworks';
import { openLibrary } from './library';
import { BlocksIcon } from './nodes/FrameworksPanel';
import { keyHint, pressed } from './keys';
import { useModels } from './models';

// The name beside a button, and its key when it has one. It shows after a short hover or on keyboard focus (theme.css),
// in place of the browser's own tooltip, which is slow, plain and always below the pointer. The button keeps its
// aria-label: this is only for the eyes.
function Label({ name, keys }: { name: string; keys?: string }) {
  return <span className="dock__label" aria-hidden="true">{name}{keys && <kbd>{keys}</kbd>}</span>;
}

// A menu beside a dock on the side of the window opens level with its button, then moves up or down just enough to
// stay whole in the window. Along the bottom it opens upward and needs no help.
function useInView<T extends HTMLElement>(open: boolean, key: unknown) {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!open || !menu) return;
    const fit = () => {
      menu.style.setProperty('--shift', '0px');
      if (!menu.closest('.dock--vertical')) return;
      // Measured without transforms: the menu may still be growing in when this runs.
      const room = 12;
      const top = (menu.offsetParent?.getBoundingClientRect().top ?? 0) + menu.offsetTop;
      let shift = Math.min(0, window.innerHeight - room - (top + menu.offsetHeight));
      if (top + shift < room) shift = room - top;
      menu.style.setProperty('--shift', `${Math.round(shift)}px`);
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [open, key]);
  return ref;
}

// One ring per model provider: how much of today's free quota is left. Amber under a fifth, red when gone.
function Quota({ place }: { place: string }) {
  const models = useModels() ?? [];
  const [open, setOpen] = useState(false);
  const detail = useInView<HTMLDivElement>(open, `${place}${models.length}`);
  if (!models.length) return null;
  const tone = (left: number) => (left <= 0.05 ? 'out' : left < 0.2 ? 'low' : 'fine');
  return (
    <div className="quota">
      <button type="button" className="quota__rings" aria-label="Model usage today" aria-expanded={open} onClick={() => setOpen(!open)}>
        {models.map((model) => (
          <svg key={model.name} viewBox="0 0 20 20" className={`ring ring--${tone(model.left)}`} role="img" aria-label={`${model.name}: ${Math.round(model.left * 100)}% left`}>
            <circle cx="10" cy="10" r="7" className="ring__track" />
            <circle cx="10" cy="10" r="7" pathLength={100} strokeDasharray={`${Math.round(model.left * 100)} 100`} transform="rotate(-90 10 10)" />
          </svg>
        ))}
        <Label name="Model usage today" />
      </button>
      {open && (
        <div ref={detail} className="quota__detail" role="dialog" aria-label="Model usage today">
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
  ['deck', 'Deck', 'Slides from a brief and what is wired, as a PDF'],
  ['site', 'Site studio', 'A one-page website from a brief, as a folder'],
  ['metrics', 'Metrics', 'Your north star and the numbers beside it'],
  ['runway', 'Runway', 'Cash, burn, and the month it runs out'],
  ['competitor', 'Competitor', 'A rival\'s pages watched, and every change'],
  ['interview', 'Interview', 'A customer call, recorded and written down here'],
  ['survey', 'Survey', 'PMF or NPS: copy it out, import the answers back'],
];

// Sites the founder is already signed in to: a browser card that opens as them. "Any app" asks for a name and an address.
const APPS: [key: Exclude<AppKey, 'custom'>, label: string, hint: string][] = [
  ['linkedin', 'LinkedIn', 'People, companies and your feed'],
  ['x', 'X', 'Posts, people and your timeline'],
  ['gmail', 'Gmail', 'Your inbox, read and drafted in'],
];

// The small form behind "Add any app": the founder names the site and says where it lives.
function AnyApp({ onAdd, place }: { onAdd: (name: string, home: string) => void; place: string }) {
  const form = useInView<HTMLFormElement>(true, place);
  const [name, setName] = useState('');
  const [home, setHome] = useState('');
  const [error, setError] = useState('');
  return (
    <form ref={form} className="dock__menu dock__app" aria-label="Add any app" onSubmit={(event) => {
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
function Needs({ open }: { open: boolean }) {
  const count = useAttention().length;
  useEffect(() => { document.title = count ? `(${count}) Stage` : 'Stage'; }, [count]);
  return (
    <button type="button" className={`dock__needs${count ? ' is-waiting' : ''}${open ? ' is-open' : ''}`} aria-label={count ? `Needs you: ${count} waiting` : 'Needs you: nothing waiting'} onClick={() => overlay.open({ kind: 'panel', name: 'needs' })}>
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.200 13.500V9a4.800 4.800 0 0 1 9.600 0v4.500l1.400 1.800H3.800zM8.300 17.300a1.900 1.900 0 0 0 3.400 0" /></svg>
      {count > 0 && <b aria-hidden="true">{count > 9 ? '9+' : count}</b>}
      <Label name={count ? `Needs you · ${count} waiting` : 'Needs you'} keys={keyHint('needs')} />
    </button>
  );
}

// A panel view the dock opens: its button is lit while that view is open, so the founder sees where they are.
function View({ name, label, keys, open, children }: { name: string; label: string; keys?: string; open: boolean; children: ReactNode }) {
  return (
    <button type="button" className={open ? 'is-open' : undefined} aria-label={label} onClick={() => overlay.open({ kind: 'panel', name })}>
      {children}
      <Label name={label} keys={keys} />
    </button>
  );
}

const POSITION = { right: 'center-right', left: 'center-left', bottom: 'bottom-center' } as const;

// The only chrome on the stage, in three groups: make something, see something, and what is happening now. It stands
// in a column on the right edge unless the founder moved it (dockPlace.ts). New cards land at the centre of the view.
export function Dock() {
  const addCard = useAddCard();
  const place = useDockPlace();
  const open = new Set(useLayers().flatMap((layer) => (layer.kind === 'panel' ? [layer.name] : [])));
  const [more, setMore] = useState(false);
  // The menu either lists cards or, after "Add any app", is the small form for one.
  const [anyApp, setAnyApp] = useState(false);
  const menu = useInView<HTMLDivElement>(more && !anyApp, place);
  const close = () => { setMore(false); setAnyApp(false); };
  // A note is picked, not made: the library opens, and the card lands once the founder has chosen or added one.
  const add = (kind: CardKind) => { close(); if (kind === 'library') openLibrary(); else addCard(kind); };
  // preset() throws on a missing name or address; the form shows that and stays open.
  const addApp = (key: AppKey, name?: string, home?: string) => { const app = preset(key, name, home); close(); addCard('browser', { app }); };

  return (
    <Panel position={POSITION[place]} className={`dock dock--${place}${place === 'bottom' ? '' : ' dock--vertical'}`}>
      <div className="dock__set" role="group" aria-label="Make">
        <button type="button" aria-label="Add person" onClick={() => add('room')}>
          <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="7" r="3.2" /><path d="M3.8 17c.6-3.4 3-5.2 6.2-5.2s5.6 1.8 6.2 5.2" /></svg>
          <Label name="Add person" />
        </button>
        <button type="button" aria-label="Add doc" onClick={() => add('doc')}>
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.5 2.5h6L15 6v11.5H5.5zM11.5 2.5V6H15M8 10h4.5M8 13h4.5" /></svg>
          <Label name="Add doc" />
        </button>
        <div className="dock__more" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close(); }} onKeyDown={(event) => { if (pressed(event, 'cancel')) close(); }}>
          <button type="button" aria-label="More cards" aria-expanded={more} onClick={() => (more ? close() : setMore(true))}>
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4.500v11M4.500 10h11" /></svg>
            <Label name="More cards" />
          </button>
          {more && !anyApp && (
            <div ref={menu} className="dock__menu" role="menu" aria-label="More cards">
              {/* The cards in two columns and the apps in a third, so the menu is short and every row is in view at once. */}
              <div className="dock__group">
                <h6 role="presentation">Cards</h6>
                <div className="dock__cards">
                  {MORE.map(([kind, label, hint]) => <button key={kind} type="button" role="menuitem" aria-label={`Add ${label.toLowerCase()}`} onClick={() => add(kind)}><b>{label}</b><small>{hint}</small></button>)}
                </div>
              </div>
              <div className="dock__group dock__group--apps">
                <h6 role="presentation">Apps, signed in as you</h6>
                {APPS.map(([key, label, hint]) => <button key={key} type="button" role="menuitem" aria-label={`Add ${label}`} onClick={() => addApp(key)}><b>{label}</b><small>{hint}</small></button>)}
                <button type="button" role="menuitem" aria-label="Add any app" onClick={() => setAnyApp(true)}><b>Any app</b><small>A site you name, opened as you</small></button>
              </div>
            </div>
          )}
          {more && anyApp && <AnyApp place={place} onAdd={(name, home) => addApp('custom', name, home)} />}
        </div>
        <button type="button" aria-label="Frameworks" onClick={() => { close(); openFrameworks(); }}>
          <BlocksIcon />
          <Label name="Frameworks" />
        </button>
      </div>
      <span className="dock__gap" aria-hidden="true" />
      <div className="dock__set" role="group" aria-label="See">
        <View name="dashboard" label="Dashboard" keys={keyHint('dashboard')} open={open.has('dashboard')}>
          <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3.500" y="3.500" width="5.500" height="7" rx="1.500" /><rect x="11" y="3.500" width="5.500" height="4" rx="1.500" /><rect x="11" y="9.500" width="5.500" height="7" rx="1.500" /><rect x="3.500" y="12.500" width="5.500" height="4" rx="1.500" /></svg>
        </View>
        <View name="command" label="Command bar" keys={keyHint('command-bar')} open={open.has('command')}>
          <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="9" cy="9" r="5.200" /><path d="M13 13l3.800 3.800" /></svg>
        </View>
        <View name="messages" label="Messages" keys={keyHint('messages')} open={open.has('messages')}>
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.500 5.200c0-.9.700-1.700 1.700-1.700h9.600c1 0 1.700.8 1.700 1.700v6.600c0 .9-.7 1.700-1.700 1.700H9l-3.700 3v-3h-.1c-1 0-1.700-.8-1.700-1.700z" /></svg>
        </View>
        <View name="decisions" label="Decisions" keys={keyHint('decisions')} open={open.has('decisions')}>
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3.500v13M5.500 16.500h9M4 6.500h12M4 6.500l-2 5a2.300 2.300 0 0 0 4 0zM16 6.500l-2 5a2.300 2.300 0 0 0 4 0z" /></svg>
        </View>
      </div>
      <span className="dock__gap" aria-hidden="true" />
      <div className="dock__set" role="group" aria-label="Now">
        <Needs open={open.has('needs')} />
        <Quota place={place} />
      </div>
    </Panel>
  );
}
