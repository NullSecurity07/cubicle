import { useReactFlow, type NodeProps } from '@xyflow/react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ChatMessage } from '../../shared/model';
import { getChat, sendChat } from '../api';
import type { RoomNodeType } from '../stage';
import { useFlushStage } from '../sync';
import { Avatar } from './Avatar';
import { CardActions, Frame } from './Frame';

type Status = 'idle' | 'thinking' | 'error';

export function RoomNode({ id, data, selected }: NodeProps<RoomNodeType>) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [reply, setReply] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [problem, setProblem] = useState('');
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ name: data.name, role: data.role, brief: data.brief });
  const { updateNodeData } = useReactFlow();
  const flushStage = useFlushStage();
  const log = useRef<HTMLDivElement>(null);
  const setup = editing || !data.name;

  useEffect(() => { getChat(id).then(setMessages).catch((error: Error) => { setStatus('error'); setProblem(error.message); }); }, [id]);
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [messages, reply]);

  async function send() {
    const text = draft.trim();
    if (!text || status === 'thinking') return;
    setDraft('');
    setProblem('');
    setStatus('thinking');
    setMessages((current) => [...current, { role: 'user', text, at: Date.now() }]);
    let streamed = '';
    try {
      await flushStage();
      await sendChat(id, text, (event) => {
        if ('token' in event) { streamed += event.token; setReply(streamed); }
        if ('error' in event) throw new Error(event.error);
        if ('done' in event) setMessages((current) => [...current, { role: 'assistant', text: streamed, at: Date.now(), provider: event.provider }]);
      });
      setStatus('idle');
    } catch (error) {
      setStatus('error');
      setProblem((error as Error).message);
    } finally {
      setReply('');
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); }
  }

  function saveForm() {
    const next = { name: form.name.trim(), role: form.role.trim(), brief: form.brief.trim() };
    if (!next.name || !next.role) return;
    updateNodeData(id, next);
    setEditing(false);
  }

  const lastAsk = messages.findLast((message) => message.role === 'user')?.text;
  const doing = status === 'thinking' ? 'replying…' : status === 'error' ? 'could not reply' : lastAsk ?? 'Ready when you are';

  return (
    <Frame selected={!!selected} minWidth={300} minHeight={280}>
      <header className="card__header">
        <Avatar accent={data.accent} />
        <div className="card__who">
          <div className="card__name">{data.name || 'New person'} {data.role && <span>· {data.role}</span>}</div>
          <div className="card__doing">{setup ? 'Tell me who this is' : doing}</div>
        </div>
        <CardActions id={id} what={data.name ? `${data.name} and this conversation` : 'this person'} onEdit={() => { setForm({ name: data.name, role: data.role, brief: data.brief }); setEditing(true); }} />
        <div className={`status status--${status}`} title={status} />
      </header>
      {setup ? (
        <form className="setup nodrag nowheel" onSubmit={(event) => { event.preventDefault(); saveForm(); }}>
          <label>Name<input autoFocus value={form.name} placeholder="Maya" onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
          <label>Role<input value={form.role} placeholder="Marketing" onChange={(event) => setForm({ ...form, role: event.target.value })} /></label>
          <label>What they do for you<textarea rows={3} value={form.brief} placeholder="Positioning, copy, launch plans…" onChange={(event) => setForm({ ...form, brief: event.target.value })} /></label>
          <div className="setup__end">
            {data.name && <button type="button" onClick={() => setEditing(false)}>Cancel</button>}
            <button type="submit" className="primary" disabled={!form.name.trim() || !form.role.trim()}>Done</button>
          </div>
        </form>
      ) : (<>
      <div className="chat nodrag nowheel" ref={log}>
        {messages.length === 0 && !reply && <p className="chat__empty">Ask {data.name} anything about {data.role.toLowerCase()}.</p>}
        {messages.map((message, index) => <p key={index} className={`msg msg--${message.role}`}>{message.text}</p>)}
        {reply && <p className="msg msg--assistant">{reply}</p>}
        {problem && <p className="msg msg--problem">{problem}</p>}
      </div>
      <div className="ask nodrag nowheel">
        <textarea rows={1} value={draft} placeholder={`Ask ${data.name}…`} onChange={(event) => setDraft(event.target.value)} onKeyDown={onKeyDown} />
        <button type="button" aria-label="Send" disabled={!draft.trim() || status === 'thinking'} onClick={() => void send()}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      </div>
      </>)}
    </Frame>
  );
}
