import { Panel, useStore } from '@xyflow/react';
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
import { setMissionsOpen, useMissions } from './Missions';
import { SLICES, sliceCommands } from './slices';

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
      if (!menu.closest('.bar--vertical')) return;
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
function View({ name, label, keys, open, className, children }: { name: string; label: string; keys?: string; open: boolean; className?: string; children: ReactNode }) {
  return (
    <button type="button" className={[className, open && 'is-open'].filter(Boolean).join(' ') || undefined} aria-label={label} onClick={() => overlay.open({ kind: 'panel', name })}>
      {children}
      <Label name={label} keys={keys} />
    </button>
  );
}

// The partner is added by the partner slice's own words, the ones "add partner" in the command bar runs, so the dock
// needs nothing of the slice but that command. Once a partner is on the stage the same button opens them.
const addPartner = () => sliceCommands().find((one) => one.when?.('add partner'))?.action;
function Partner() {
  const partner = useStore((flow) => flow.nodes.find((node) => node.type === 'room' && (node.data as { partner?: boolean }).partner)?.id ?? null);
  const action = addPartner();
  if (!action || action.do !== 'run') return null;
  const label = partner ? 'Your partner' : 'Add partner';
  return (
    <button type="button" aria-label={label} onClick={() => (partner ? overlay.open({ kind: 'focus', id: partner }) : action.run())}>
      <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="7.300" cy="7.200" r="2.700" /><path d="M2.300 16.500c.5-3 2.400-4.600 5-4.600s4.500 1.600 5 4.600" /><path d="M11.800 4.800a2.700 2.700 0 1 1 .9 5.100M14.300 11.900c1.700.5 2.900 2 3.300 4.600" /></svg>
      <Label name={label} />
    </button>
  );
}

// The first-run list's progress as a ring, and the way back to the list once its corner card is closed. Gone for good
// once the founder has sent the list away.
function Started() {
  const { state, open } = useMissions();
  if (!state || state.dismissed) return null;
  const done = state.missions.filter((one) => one.done).length;
  const all = state.missions.length;
  const label = done === all ? 'You know your way around' : 'Getting started';
  return (
    <button type="button" className={`dock__started${open ? ' is-open' : ''}`} aria-label={label} aria-pressed={open} onClick={() => setMissionsOpen(!open)}>
      <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="6.600" className="ring__track" /><circle cx="10" cy="10" r="6.600" pathLength={100} strokeDasharray={`${Math.round((done / all) * 100)} 100`} transform="rotate(-90 10 10)" /></svg>
      <Label name={`${label} · ${done} of ${all}`} />
    </button>
  );
}

// What comes to the founder: what waits for them, the conversations and choices, the ledger of bets, and how the
// machine is doing. A slice's view gets its button only when that slice is there to open it.
const hasPanel = (name: string) => SLICES.some((slice) => !!slice.panels?.[name]);
function Incoming({ place, open }: { place: string; open: Set<string> }) {
  return (
    <>
      <div className="dock__set" role="group" aria-label="For you">
        <Needs open={open.has('needs')} />
        <View name="messages" label="Messages" keys={keyHint('messages')} open={open.has('messages')}>
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.500 5.200c0-.9.700-1.700 1.700-1.700h9.600c1 0 1.700.8 1.700 1.700v6.600c0 .9-.7 1.700-1.700 1.700H9l-3.700 3v-3h-.1c-1 0-1.700-.8-1.700-1.700z" /></svg>
        </View>
        <View name="decisions" label="Decisions" keys={keyHint('decisions')} open={open.has('decisions')}>
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3.500v13M5.500 16.500h9M4 6.500h12M4 6.500l-2 5a2.300 2.300 0 0 0 4 0zM16 6.500l-2 5a2.300 2.300 0 0 0 4 0z" /></svg>
        </View>
        {hasPanel('bets') && (
          <View name="bets" label="Bets" open={open.has('bets')}>
            <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="6.800" /><circle cx="10" cy="10" r="3.600" /><circle cx="10" cy="10" r="0.700" /></svg>
          </View>
        )}
      </div>
      <span className="dock__gap" aria-hidden="true" />
      <div className="dock__set" role="group" aria-label="How it is going">
        <View name="dashboard" label="Dashboard" keys={keyHint('dashboard')} open={open.has('dashboard')}>
          <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3.500" y="3.500" width="5.500" height="7" rx="1.500" /><rect x="11" y="3.500" width="5.500" height="4" rx="1.500" /><rect x="11" y="9.500" width="5.500" height="7" rx="1.500" /><rect x="3.500" y="12.500" width="5.500" height="4" rx="1.500" /></svg>
        </View>
        {hasPanel('health') && (
          <View name="health" label="Health" open={open.has('health')}>
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2.500 10.500h3.300l1.900-4.300 3.100 8 2-5.200 1 1.500h3.700" /></svg>
          </View>
        )}
        {hasPanel('apikeys') && (
          <View name="apikeys" label="Keys" open={open.has('apikeys')}>
            <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="6.800" cy="13.200" r="3.300" /><path d="M9.200 10.800l6.300-6.300M13.300 6.700l2 2M11.600 8.400l1.500 1.500" /></svg>
          </View>
        )}
        <Quota place={place} />
        <View name="keys" label="Keyboard shortcuts" keys={keyHint('cheatsheet')} open={open.has('keys')}>
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7.400 7.600a2.700 2.700 0 1 1 3.900 2.400c-.8.400-1.300 1-1.300 1.900v.6" /><circle cx="10" cy="15.300" r="0.500" /></svg>
        </View>
      </div>
    </>
  );
}

const POSITION = { right: 'center-right', left: 'center-left', bottom: 'bottom-center' } as const;

// The only chrome on the stage. The dock floats at the foot of the window with what the founder does: the command
// bar, a person, a card, a team, the partner, and the first-run list. It can stand on either edge instead
// (dockPlace.ts). New cards land at the centre of the view.
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
    <Panel position={POSITION[place]} className={`dock bar bar--${place} dock--${place}${place === 'bottom' ? '' : ' bar--vertical dock--vertical'}`}>
      <div className="dock__set" role="group" aria-label="Ask">
        <View name="command" label="Command bar" keys={keyHint('command-bar')} open={open.has('command')} className="dock__ask">
          <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="9" cy="9" r="5.200" /><path d="M13 13l3.800 3.800" /></svg>
        </View>
      </div>
      <span className="dock__gap" aria-hidden="true" />
      <div className="dock__set" role="group" aria-label="Make">
        <button type="button" aria-label="Add person" onClick={() => add('room')}>
          <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="7" r="3.2" /><path d="M3.8 17c.6-3.4 3-5.200 6.200-5.200s5.600 1.800 6.200 5.200" /></svg>
          <Label name="Add person" />
        </button>
        <button type="button" aria-label="Add doc" onClick={() => add('doc')}>
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.500 2.500h6L15 6v11.500H5.500zM11.500 2.500V6H15M8 10h4.500M8 13h4.500" /></svg>
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
        <Partner />
      </div>
      <span className="dock__gap" aria-hidden="true" />
      <div className="dock__set" role="group" aria-label="Learn">
        <Started />
      </div>
      <span className="dock__gap" aria-hidden="true" />
      <Incoming place={place} open={open} />
    </Panel>
  );
}
