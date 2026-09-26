import { useReactFlow } from '@xyflow/react';
import { useEffect, useSyncExternalStore } from 'react';
import type { UiSlice } from '..';
import { DOC_SIZE } from '../../../shared/frameworks';
import { COMPANY_TITLE, findCompanyDoc, PARTNER_BRIEF, PARTNER_CHANNEL, PARTNER_ROLE, type PartnerEvent } from '../../../shared/partner';
import { NEW_SIZE, useAddCard } from '../../addCard';
import { request, send } from '../../api';
import { emit } from '../../bus';
import { feed } from '../../feed';
import { overlay } from '../../overlay/store';
import { WIRE, type StageNode } from '../../stage';
import { useFlushStage } from '../../sync';
import { askMorning } from './api';
import { BetsPanel } from './BetsPanel';
import { partnerCommands } from './words';
import './partner.css';

// The partner, as the founder sees them: "add partner" puts one person and the Company document on the stage, wired
// together; "morning note" asks for today's note now; "bets" opens the ledger. What happened is said in one quiet
// line at the foot of the window, with a way to the partner.

type Said = { text: string; roomId?: string; problem?: true } | null;
let said: Said = null;
let wanted: { name: string } | null = null;
const hearers = new Set<() => void>();
const tell = () => { for (const one of hearers) one(); };
const say = (next: Said) => { said = next; tell(); };
const subscribe = (one: () => void) => { hearers.add(one); return () => { hearers.delete(one); }; };
const useSaid = () => useSyncExternalStore(subscribe, () => said);
const useWanted = () => useSyncExternalStore(subscribe, () => wanted);

const morning = () => {
  say({ text: 'Asking your partner for the morning note…' });
  askMorning()
    .then((note) => say({ text: note.unchanged ? `Nothing changed since ${new Date(note.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}. ${note.who}'s note stands: ${note.things[0]}` : `${note.who}'s morning note: ${note.things[0]}`, roomId: note.roomId }))
    .catch((error: Error) => say({ text: error.message, problem: true }));
};
const frame = () => new Promise<void>((done) => { requestAnimationFrame(() => done()); });

function PartnerDesk() {
  const flow = useReactFlow<StageNode>();
  const addCard = useAddCard();
  const flush = useFlushStage();
  const asked = useWanted();
  const now = useSaid();

  // The partner and the Company document go down side by side, wired, and the stage is saved before the server is
  // asked to give the document its sections, so the server finds the window's doc rather than making a second one.
  useEffect(() => {
    if (!asked) return;
    wanted = null;
    const { name } = asked;
    const nodes = flow.getNodes();
    const held = nodes.find((node) => node.type === 'room' && (node.data as { partner?: boolean }).partner);
    if (held) { overlay.open({ kind: 'focus', id: held.id }); say({ text: `${String((held.data as { name?: string }).name || 'Your partner')} is already your partner.`, roomId: held.id }); return; }
    const centre = flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    const roomId = addCard('room', { name, role: PARTNER_ROLE, brief: PARTNER_BRIEF, partner: true }, centre);
    // The stage's own company doc ("Company brief" on a fresh stage) is the partner's; a new one only when there is none.
    const docs = nodes.filter((node) => node.type === 'doc').map((node) => ({ id: node.id, title: String((node.data as { title?: string }).title ?? ''), pinned: !!(node.data as { pinned?: boolean }).pinned }));
    const company = findCompanyDoc(docs);
    const docId = company?.id ?? addCard('doc', { title: COMPANY_TITLE, pinned: true }, { x: centre.x + NEW_SIZE.room[0] / 2 + 80 + DOC_SIZE.w / 2, y: centre.y });
    flow.setEdges((current) => [...current, { id: `${roomId}-${docId}`, source: roomId, sourceHandle: 'r', target: docId, targetHandle: 'l', ...WIRE }]);
    void (async () => {
      for (let tries = 0; tries < 30 && !flow.getNodes().some((node) => node.id === docId); tries += 1) await frame();
      await frame();
      // Both new cards in view: the doc was put down last, so the view had glided to it and left the partner behind.
      void flow.fitView({ nodes: [{ id: roomId }, { id: docId }], duration: 400, padding: 0.25, maxZoom: 1 });
      await flush();
      await request('/api/partner/company', send('POST', { id: docId }));
      say({ text: `${name} is your partner. The Company document is theirs to keep: start it with the idea.`, roomId });
    })().catch((error: Error) => say({ text: error.message, problem: true }));
  }, [asked, flow, addCard, flush]);

  // The app wrote into the Company document (a decision, a bet, its sections): an open card reads it again, so the
  // founder's next keystroke does not save the old text over the new lines.
  useEffect(() => feed<PartnerEvent>(PARTNER_CHANNEL, (event) => { if (event.docChanged) emit('effect', { kind: 'doc-changed', id: event.docChanged, roomId: '' }); }), []);

  useEffect(() => {
    if (!now || now.text.endsWith('…')) return;
    const timer = setTimeout(() => say(null), 9000);
    return () => clearTimeout(timer);
  }, [now]);
  if (!now) return null;
  return (
    <div className={`partner-notice${now.problem ? ' is-problem' : ''}`} role="status">
      <span>{now.text}</span>
      {now.roomId && <button type="button" onClick={() => { overlay.open({ kind: 'focus', id: now.roomId! }); say(null); }}>Open</button>}
      <button type="button" className="partner-notice__close" aria-label="Close" onClick={() => say(null)}>
        <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3.500 3.500l5 5M8.500 3.500l-5 5" /></svg>
      </button>
    </div>
  );
}

export default {
  name: 'partner',
  commands: partnerCommands({ add: (name) => { wanted = { name }; tell(); }, morning }),
  overlay: PartnerDesk,
  panels: { bets: BetsPanel },
} satisfies UiSlice;
