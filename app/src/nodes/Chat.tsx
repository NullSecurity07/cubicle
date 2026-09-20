import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import type { Attachment, ChatMessage, ToolEvent } from '../../shared/model';
import { deleteMessage, getChat, sendChat, uploadFile } from '../api';
import { emit, listen } from '../bus';
import { useLearnedIn } from '../overlay/playbook';
import { overlay, showPlaybook } from '../overlay/store';
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
  const [files, setFiles] = useState<Attachment[]>([]);
  const [editing, setEditing] = useState<ChatMessage | null>(null);
  // What this person learned while the window has been open. It is not something anybody said, so it is never stored
  // as a message: it is a line under the conversation that opens the playbook on what was learned.
  const learned = useLearnedIn(id);
  const picker = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
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
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [messages, live, learned]);
  // Editing an earlier message happens in the ask box: the caret goes there, and Escape there cancels the edit.
  useEffect(() => { if (editing) box.current?.focus(); }, [editing]);

  // `again` re-asks an earlier message: it and everything after it leave the conversation first (kept in the trash).
  async function send(again?: { replace?: string; text: string; attachments?: Attachment[] }) {
    const text = again?.text ?? draft.trim();
    const attachments = again ? again.attachments ?? [] : files;
    const replace = again?.replace ?? editing?.id;
    if ((!text && !attachments.length) || thinking) return;
    setDraft('');
    setFiles([]);
    setEditing(null);
    setProblem('');
    setNotice('');
    const before = replace ? messages.slice(0, Math.max(0, messages.findIndex((message) => message.id === replace))) : messages;
    const asked = [...before, { id: `local-${Date.now()}`, role: 'user' as const, text: text || 'See the attached file.', at: Date.now(), ...(attachments.length ? { attachments } : {}) }];
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
      }, stop.current.signal, { replace, attachments });
      // The server gave the new message its lasting id: take its copy, so edit and delete address the right one.
      getChat(id).then(setMessages).catch(() => {});
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

  // A question sent from the command bar is asked here, exactly as if it had been typed in this box.
  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => listen('ask', (asked) => { if (asked.roomId === id) void sendRef.current({ text: asked.text }); }), [id]);
  async function attach(list: FileList | File[]) {
    setProblem('');
    for (const file of [...list].slice(0, 5 - files.length)) {
      try { const saved = await uploadFile(file); setFiles((current) => [...current, saved]); } catch (error) { setProblem(`${file.name}: ${(error as Error).message}`); }
    }
  }
  function onDrop(event: DragEvent) {
    if (!event.dataTransfer.files.length) return;
    event.preventDefault();
    void attach(event.dataTransfer.files);
  }
  function remove(message: ChatMessage) {
    deleteMessage(id, message.id).then(setMessages).catch((error: Error) => setProblem(error.message));
  }
  function regenerate() {
    const asked = messages.findLast((message) => message.role === 'user' && !message.from);
    if (asked) void send({ replace: asked.id, text: asked.text, attachments: asked.attachments });
  }
  const lastReply = messages.findLast((message) => message.role === 'assistant');
  const lastAsked = messages.findLast((message) => message.role === 'user' && !message.from);

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Escape' && editing) { setEditing(null); setDraft(''); }
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); }
  }

  return (
    <>
      <div className="chat nodrag nowheel" data-tail ref={log} onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
        {messages.length === 0 && !live && <p className="chat__empty">Ask {name} anything about {role.toLowerCase()}.</p>}
        {messages.map((message) => (
          <Message
            key={message.id} message={message}
            onDelete={thinking || message.id.startsWith('local-') ? undefined : () => remove(message)}
            onEdit={!thinking && message.role === 'user' && !message.from && !message.id.startsWith('local-') ? () => { setEditing(message); setDraft(message.text); setFiles(message.attachments ?? []); } : undefined}
            onRegenerate={!thinking && message === lastReply && lastAsked && messages.indexOf(lastAsked) < messages.indexOf(message) ? regenerate : undefined}
          />
        ))}
        {learned.map((one) => (
          <button
            key={one.id} type="button" className="msg msg--notice msg--learned"
            title="Open the playbook here"
            onClick={() => { showPlaybook({ skill: one.name }); overlay.open({ kind: 'panel', name: 'playbook' }); }}
          >{one.action === 'create' ? 'learned' : 'improved'}: "{one.name}"</button>
        ))}
        {notice && <p className="msg msg--notice">{notice}</p>}
        {live && (live.text || live.tools.length > 0) && <Message live message={{ role: 'assistant', text: live.text, tools: live.tools }} />}
        {problem && <p className="msg msg--problem">{problem}</p>}
      </div>
      {(files.length > 0 || editing) && (
        <div className="ask__extras nodrag">
          {editing && <span className="ask__editing">Editing an earlier message: what came after it will be replaced. Esc cancels.</span>}
          {files.map((file) => (
            <span key={file.path} className="ask__file">{file.path.split('/').pop()?.replace(/^[a-z0-9]+-/, '')}
              <button type="button" aria-label={`Remove ${file.path.split('/').pop()}`} onClick={() => setFiles(files.filter((one) => one !== file))}>×</button>
            </span>
          ))}
        </div>
      )}
      <div className="ask nodrag nowheel" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
        <input ref={picker} type="file" multiple hidden onChange={(event) => { if (event.target.files) void attach(event.target.files); event.target.value = ''; }} />
        <button type="button" className="ask__attach" aria-label="Attach a file" title="Attach a file (or drop one here)" onClick={() => picker.current?.click()}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M11.500 7.500 7.300 11.700a2.400 2.400 0 0 1-3.400-3.400l5-5a1.600 1.600 0 0 1 2.300 2.300L6.400 10.400a.800.800 0 0 1-1.200-1.200L9 5.500" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        <textarea ref={box} rows={1} value={draft} placeholder={`Ask ${name}…`} onChange={(event) => setDraft(event.target.value)} onKeyDown={onKeyDown} {...(editing ? { 'data-holds-escape': '' } : {})} />
        {thinking ? (
          <button type="button" className="ask__stop" aria-label="Stop" title="Stop" onClick={() => stop.current?.abort()}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4.5" y="4.500" width="7" height="7" rx="1.5" fill="currentColor" /></svg>
          </button>
        ) : (
          <button type="button" aria-label="Send" disabled={!draft.trim() && !files.length} onClick={() => void send()}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        )}
      </div>
    </>
  );
}
