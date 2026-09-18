import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ChatMessage, ToolEvent } from '../../shared/model';
import { getChat, sendChat } from '../api';
import { emit, listen } from '../bus';
import { useFlushStage } from '../sync';
import { Message } from './Message';

export type Status = 'idle' | 'thinking' | 'waiting' | 'error';
type Live = { text: string; tools: ToolEvent[] };

// The conversation with one person: the log, the reply as it streams (words and tool chips), and the ask box.
export function Chat({ id, name, role, onStatus }: { id: string; name: string; role: string; onStatus: (status: Status, lastAsk?: string) => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [live, setLive] = useState<Live | null>(null);
  const [notice, setNotice] = useState('');
  const [problem, setProblem] = useState('');
  const flushStage = useFlushStage();
  const log = useRef<HTMLDivElement>(null);
  const stop = useRef<AbortController>(null);
  const thinking = live !== null;

  const report = (status: Status, list = messages) => onStatus(status, list.findLast((message) => message.role === 'user')?.text);
  useEffect(() => {
    getChat(id).then((loaded) => { setMessages(loaded); report('idle', loaded); }).catch((error: Error) => { setProblem(error.message); report('error'); });
    return () => stop.current?.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  // A colleague consulted this person: the question and the answer were written to this room by the server.
  useEffect(() => listen('effect', (effect) => { if (effect.kind === 'chat-changed' && effect.id === id) getChat(id).then(setMessages).catch(() => {}); }), [id]);
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [messages, live]);

  async function send() {
    const text = draft.trim();
    if (!text || thinking) return;
    setDraft('');
    setProblem('');
    setNotice('');
    const asked = [...messages, { id: `local-${Date.now()}`, role: 'user' as const, text, at: Date.now() }];
    setMessages(asked);
    report('thinking', asked);
    const now: Live = { text: '', tools: [] };
    setLive(now);
    stop.current = new AbortController();
    let finished = false;
    try {
      await flushStage();
      await sendChat(id, text, (event) => {
        if ('token' in event) now.text += event.token;
        if ('tool' in event) {
          now.tools = [...now.tools.filter((tool) => tool.id !== event.tool.id), event.tool];
          if (event.tool.effect) emit('effect', { ...event.tool.effect, roomId: id });
        }
        if ('notice' in event) setNotice(event.notice);
        if ('error' in event) throw new Error(event.error);
        if ('done' in event) { finished = true; if (event.message.text.trim() || event.message.tools) setMessages((current) => [...current, event.message]); }
        setLive({ ...now });
        if ('tool' in event) report(now.tools.some((tool) => tool.waiting) ? 'waiting' : 'thinking', asked);
      }, stop.current.signal);
      report('idle', asked);
    } catch (error) {
      if (stop.current.signal.aborted) {
        // Stopped by the founder: keep what was said, then take the server's saved copy so ids match.
        if (!finished && (now.text.trim() || now.tools.length)) setMessages((current) => [...current, { id: `local-${Date.now()}`, role: 'assistant', text: now.text, at: Date.now(), tools: now.tools, stopped: true }]);
        setTimeout(() => { getChat(id).then(setMessages).catch(() => {}); }, 600);
        report('idle', asked);
      } else {
        setProblem((error as Error).message);
        report('error', asked);
      }
    } finally {
      setLive(null);
      emit('usage', null);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); }
  }

  return (
    <>
      <div className="chat nodrag nowheel" ref={log}>
        {messages.length === 0 && !live && <p className="chat__empty">Ask {name} anything about {role.toLowerCase()}.</p>}
        {messages.map((message) => <Message key={message.id} message={message} />)}
        {notice && <p className="msg msg--notice">{notice}</p>}
        {live && (live.text || live.tools.length > 0) && <Message live message={{ role: 'assistant', text: live.text, tools: live.tools }} />}
        {problem && <p className="msg msg--problem">{problem}</p>}
      </div>
      <div className="ask nodrag nowheel">
        <textarea rows={1} value={draft} placeholder={`Ask ${name}…`} onChange={(event) => setDraft(event.target.value)} onKeyDown={onKeyDown} />
        {thinking ? (
          <button type="button" className="ask__stop" aria-label="Stop" title="Stop" onClick={() => stop.current?.abort()}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4.5" y="4.500" width="7" height="7" rx="1.5" fill="currentColor" /></svg>
          </button>
        ) : (
          <button type="button" aria-label="Send" disabled={!draft.trim()} onClick={() => void send()}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        )}
      </div>
    </>
  );
}
