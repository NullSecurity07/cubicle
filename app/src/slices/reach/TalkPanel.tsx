import { useEffect, useRef, useState } from 'react';
import type { ChatMessage, Room } from '../../../shared/model';
import { getChat, getStage, sendChat } from '../../api';
import { Message } from '../../nodes/Message';
import { PanelShell } from '../../overlay/PanelShell';
import { getReach, listen } from './api';
import { quiet, record, say, type Recording } from './voice';

// Talking to one person out loud: hold the button, say it, and hear the answer back. The conversation here is the
// same one as on their card — this only adds a mouth and an ear to it.
export function TalkPanel() {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [roomId, setRoomId] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [live, setLive] = useState<string | null>(null);
  const [doing, setDoing] = useState('');
  const [problem, setProblem] = useState('');
  const [saying, setSaying] = useState('');
  const taking = useRef<Recording | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const room = rooms.find((one) => one.id === roomId);

  useEffect(() => {
    getStage().then((stage) => { setRooms(stage.rooms); setRoomId((held) => held || stage.rooms[0]?.id || ''); }).catch((error: Error) => setProblem(error.message));
    return () => { quiet(); taking.current?.cancel(); };
  }, []);
  useEffect(() => { if (roomId) getChat(roomId).then(setMessages).catch(() => {}); }, [roomId]);
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [messages, live]);

  async function hear() {
    setProblem('');
    try {
      taking.current = await record();
      setDoing('Listening…');
    } catch { setProblem('This window cannot reach the microphone. Allow it in the browser, or type instead.'); }
  }
  async function wroteDown() {
    const taken = taking.current;
    if (!taken) return;
    taking.current = null;
    setDoing('Writing down what you said…');
    try {
      const samples = await taken.stop();
      // The first time, the model this runs on has to be fetched; the server says how that is going.
      const watching = setInterval(() => { getReach().then((state) => { if (state.speech) setDoing(state.speech); }).catch(() => {}); }, 1200);
      let heard = '';
      try { heard = (await listen(samples)).text; } finally { clearInterval(watching); }
      setDraft((held) => `${held ? `${held} ` : ''}${heard}`.trim());
    } catch (error) { setProblem((error as Error).message); }
    setDoing('');
  }

  async function send() {
    const text = draft.trim();
    if (!text || !roomId || live !== null) return;
    setDraft('');
    setProblem('');
    setMessages((held) => [...held, { id: `local-${Date.now()}`, role: 'user', text, at: Date.now() }]);
    let said = '';
    setLive('');
    try {
      await sendChat(roomId, text, (event) => {
        if ('token' in event) { said += event.token; setLive(said); }
        if ('error' in event) throw new Error(event.error);
      });
      setMessages(await getChat(roomId));
    } catch (error) { setProblem((error as Error).message); }
    setLive(null);
  }

  async function speak(message: ChatMessage) {
    if (saying === message.id) { quiet(); setSaying(''); return; }
    setProblem('');
    setSaying(message.id);
    try { await say(message.id, message.text, () => setSaying('')); } catch (error) { setProblem((error as Error).message); setSaying(''); }
  }

  return (
    <PanelShell name="talk" title="Talk" note={room ? `with ${room.name}` : undefined}>
      {problem && <p className="msg--problem">{problem}</p>}
      <div className="reach__row">
        <select value={roomId} onChange={(event) => { quiet(); setSaying(''); setRoomId(event.target.value); }} aria-label="Who to talk to">
          {rooms.map((one) => <option key={one.id} value={one.id}>{one.name}</option>)}
        </select>
        {!rooms.length && <span className="reach__quiet">Add a person to the stage first.</span>}
      </div>
      <div className="reach-talk__log" ref={log}>
        {!messages.length && !live && <p className="panel__empty">Hold the button and say what you need.</p>}
        {messages.map((message) => (
          <div key={message.id} className="reach-talk__said">
            <Message message={message} />
            {message.role === 'assistant' && message.text.trim() && (
              <button type="button" className="reach-talk__speak" onClick={() => void speak(message)} aria-label={saying === message.id ? 'Stop' : 'Say this out loud'}>
                {saying === message.id ? 'Stop' : 'Say this out loud'}
              </button>
            )}
          </div>
        ))}
        {live !== null && <Message live message={{ role: 'assistant', text: live || '…' }} />}
      </div>
      {doing && <p className="reach__quiet">{doing}</p>}
      <div className="reach-talk__ask">
        <button
          type="button" className={`reach-talk__mic${taking.current ? ' is-on' : ''}`}
          onPointerDown={() => void hear()} onPointerUp={() => void wroteDown()} onPointerLeave={() => { if (taking.current) void wroteDown(); }}
        >Hold to talk</button>
        <textarea rows={2} value={draft} placeholder={room ? `Say something to ${room.name}…` : 'Say something…'} onChange={(event) => setDraft(event.target.value)} aria-label="What to say" />
        <button type="button" className="primary" disabled={!draft.trim() || live !== null} onClick={() => void send()}>Send</button>
      </div>
    </PanelShell>
  );
}
