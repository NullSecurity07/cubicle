import { useReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import { useEffect, useRef, useState } from 'react';
import { emptyInterview, insightsAsk, insightsTitle, interviewName, isAudioName, length, stamp, whereIs, type Interview, type InterviewCard } from '../../shared/interviews';
import { NEW_SIZE } from '../addCard';
import { emit } from '../bus';
import { useJumpTo, useWired } from '../flow';
import { overlay } from '../overlay/store';
import { freeSpot } from '../place';
import { CARD, WIRE, type StageNode } from '../stage';
import { useFlushStage } from '../sync';
import { useAttempt } from '../attempt';
import { CardActions, Frame } from './Frame';
import { askedForInsights, removeRecording, retryInterview, setConsent, soundUrl, uploadRecording, watchInterview } from './interviewApi';
import { startRecording, type Taking } from './interviewRecorder';
import './interview.css';

type InterviewNodeType = Node<InterviewCard, 'interview'>;

const today = () => { const day = new Date(); return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`; };
const PRIVATE = 'Recorded and written down on this machine. Nothing leaves it until you ask a wired person about it.';
const REFUSED = 'This window was not allowed to use the microphone. Allow it for this page and try again.';

// A customer interview. Who and when, a tick that they agreed to be recorded, then the call itself: recorded here, or
// a recording dropped on the card. The transcript fills in with times once it is written down, each time a place to
// listen from, and a wired person turns it into insights in a doc beside the card.
export function InterviewNode({ id, data, selected }: NodeProps<InterviewNodeType>) {
  const [interview, setInterview] = useState<Interview>(emptyInterview);
  const [editing, setEditing] = useState(!data.who?.trim());
  const [draft, setDraft] = useState({ who: data.who ?? '', company: data.company ?? '', on: data.on || today() });
  const [taking, setTaking] = useState<'idle' | 'recording' | 'saving'>('idle');
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const [over, setOver] = useState(false);
  const [now, setNow] = useState(0);
  const [since, setSince] = useState(0);
  const [playing, setPlaying] = useState<{ at: number; on: boolean } | null>(null);
  const [writer, setWriter] = useState('');
  const { problem, setProblem, attempt: act } = useAttempt();
  const recording = useRef<Taking | null>(null);
  const player = useRef<HTMLAudioElement>(null);
  const chooser = useRef<HTMLInputElement>(null);
  const flushStage = useFlushStage();
  const { getNodes, setNodes, setEdges, getEdges } = useReactFlow<StageNode>();
  const { updateNodeData } = useReactFlow();
  const jumpTo = useJumpTo();

  useEffect(() => {
    let stop = () => {};
    let gone = false;
    // The server must know this card before it will say anything about it.
    void flushStage().then(() => { if (!gone) stop = watchInterview(id, (event) => setInterview(event.data)); });
    return () => { gone = true; stop(); };
  }, [id, flushStage]);

  // A recording in progress: the meter and the clock move, and leaving the window asks first.
  useEffect(() => {
    if (taking !== 'recording') return;
    const started = Date.now();
    let frame = 0;
    const draw = () => { setLevel(recording.current?.level() ?? 0); setSeconds((Date.now() - started) / 1000); frame = requestAnimationFrame(draw); };
    frame = requestAnimationFrame(draw);
    const leaving = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', leaving);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('beforeunload', leaving); setLevel(0); };
  }, [taking]);
  useEffect(() => () => recording.current?.cancel(), []);

  // How long the transcriber has been at it, counted here: it says nothing until it is done.
  const busy = interview.state === 'transcribing';
  useEffect(() => {
    if (!busy) return;
    setSince(Date.now());
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  const who = data.who?.trim() || 'They';
  const people = useWired(id, 'room').filter((node) => node.data.name).map((node) => ({ id: node.id, name: String(node.data.name) }));
  const docs = useWired(id, 'doc');
  const chosen = people.find((person) => person.id === writer) ?? people[0];
  const total = interview.recordings.reduce((sum, one) => sum + one.seconds, 0);
  const canRecord = interview.consent && !busy && taking === 'idle' && !editing;

  // The tick shows at once; the server's word follows, and puts it back if it was refused.
  function consent(yes: boolean) {
    setInterview((was) => ({ ...was, consent: yes }));
    act(setConsent(id, yes).catch(async (error: Error) => { setInterview((was) => ({ ...was, consent: !yes })); throw error; }));
  }

  function save() {
    if (!draft.who.trim()) { setProblem('Say who the interview is with.'); return; }
    updateNodeData(id, { who: draft.who.trim(), company: draft.company.trim() || undefined, on: draft.on || undefined });
    setEditing(false);
    setProblem('');
  }

  async function record() {
    if (taking === 'recording') {
      const taken = recording.current;
      recording.current = null;
      if (!taken) return;
      setTaking('saving');
      act(taken.stop().then((blob) => uploadRecording(id, blob, taken.name)).finally(() => setTaking('idle')));
      return;
    }
    if (!canRecord) return;
    try {
      recording.current = await startRecording();
      setSeconds(0);
      setTaking('recording');
      setProblem('');
    } catch {
      setProblem(REFUSED);
    }
  }

  function add(files: File[]) {
    const file = files.find((one) => isAudioName(one.name) || one.type.startsWith('audio/') || one.type.startsWith('video/'));
    if (!file) { setProblem('That is not a recording. Drop a wav, mp3, m4a, ogg, webm or mp4 file.'); return; }
    if (!interview.consent) { setProblem(`Tick that ${who} agreed to be recorded first.`); return; }
    setTaking('saving');
    act(uploadRecording(id, file, file.name).finally(() => setTaking('idle')));
  }

  // From a time in the transcript: the recording it falls in, from that moment. The same time again pauses.
  function listen(at: number) {
    const audio = player.current;
    const where = whereIs(interview.recordings, at);
    if (!audio || !where) return;
    if (playing?.on && playingLine?.at === at) { audio.pause(); return; }
    const src = soundUrl(id, where.index);
    const go = () => { audio.currentTime = where.offset; void audio.play().catch((error: Error) => setProblem(`It would not play: ${error.message}`)); };
    if (!audio.src.endsWith(src)) { audio.src = src; audio.addEventListener('loadedmetadata', go, { once: true }); } else go();
    setPlaying({ at, on: true });
  }

  // "Write insights": the doc already wired to this card (the customer-discovery team's Interviews doc, say), or a new
  // one beside the card; the person wired to it; and the ask in their room, the road the command bar takes.
  async function writeInsights() {
    if (!chosen) return;
    const nodes = getNodes();
    const made = interview.insights && nodes.find((node) => node.id === interview.insights!.docId);
    const wiredDoc = made ?? nodes.find((node) => node.id === docs[0]?.id);
    let doc: { id: string; title: string; fresh: boolean };
    if (wiredDoc) doc = { id: wiredDoc.id, title: String((wiredDoc.data as { title?: string }).title ?? 'Untitled doc'), fresh: false };
    else {
      const self = nodes.find((node) => node.id === id);
      const [width, height] = NEW_SIZE.doc;
      const beside = { x: (self?.position.x ?? 0) + (self?.width ?? 440) + 80, y: self?.position.y ?? 0 };
      doc = { id: `doc-${Math.random().toString(36).slice(2, 8)}`, title: insightsTitle(data), fresh: true };
      setNodes((current) => [...current, { id: doc.id, type: 'doc', position: freeSpot(current, beside, width, height), width, height, data: { title: doc.title }, ...CARD } as StageNode]);
    }
    const edges = getEdges();
    const joined = (one: string, other: string) => edges.some((edge) => (edge.source === one && edge.target === other) || (edge.source === other && edge.target === one));
    const adding: Edge[] = [];
    if (!joined(id, doc.id)) adding.push({ id: `${id}-${doc.id}`, source: id, sourceHandle: 'r', target: doc.id, targetHandle: 'l', ...WIRE });
    if (!joined(chosen.id, doc.id)) adding.push({ id: `${chosen.id}-${doc.id}`, source: chosen.id, sourceHandle: 'r', target: doc.id, targetHandle: 'l', ...WIRE });
    if (adding.length) setEdges((current) => [...current, ...adding]);
    // Saved at once: the person may only write a doc the server already sees wired to them.
    await new Promise((drawn) => { setTimeout(drawn, 0); });
    await flushStage();
    await askedForInsights(id, doc.id, chosen.id);
    overlay.open({ kind: 'focus', id: chosen.id });
    emit('ask', { roomId: chosen.id, text: insightsAsk(data, doc) });
  }

  const playingLine = playing?.on ? interview.transcript.findLast((line) => line.at <= playing.at + 0.05) : undefined;

  return (
    <Frame selected={!!selected} minWidth={380} minHeight={420}>
      <header className="card__header card__header--doc">
        <svg className="doc-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.200a1.800 1.800 0 0 1 1.800 1.800v3.200a1.800 1.800 0 0 1-3.600 0V4a1.800 1.800 0 0 1 1.800-1.800zM4.300 7.300a3.700 3.700 0 0 0 7.400 0M8 11v2.600M5.800 13.600h4.400" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>
        <div className="card__name">{data.who?.trim() ? interviewName(data) : 'Interview'}</div>
        <CardActions id={id} what="this Interview card (its recordings and transcript stay in the workspace)" onEdit={() => { setDraft({ who: data.who ?? '', company: data.company ?? '', on: data.on || today() }); setEditing(true); }} />
      </header>
      <div
        className={`interview nodrag nowheel${over ? ' is-over' : ''}`}
        onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setOver(true); } }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => { if (!event.dataTransfer.files.length) return; event.preventDefault(); event.stopPropagation(); setOver(false); add(Array.from(event.dataTransfer.files)); }}
      >
        {editing ? (
          <form className="interview__setup" onSubmit={(event) => { event.preventDefault(); save(); }}>
            <p>Who is the conversation with?</p>
            <input aria-label="Who" placeholder="Name" value={draft.who} autoFocus onChange={(event) => setDraft({ ...draft, who: event.target.value })} />
            <input aria-label="Their company" placeholder="Company" value={draft.company} onChange={(event) => setDraft({ ...draft, company: event.target.value })} />
            <input aria-label="Date" type="date" value={draft.on} onChange={(event) => setDraft({ ...draft, on: event.target.value })} />
            <div className="interview__setup-end">
              {data.who?.trim() && <button type="button" onClick={() => setEditing(false)}>Cancel</button>}
              <button type="submit" className="primary" disabled={!draft.who.trim()}>Done</button>
            </div>
          </form>
        ) : (
          <>
            <label className={`interview__consent${interview.consent ? ' is-on' : ''}`}>
              <input type="checkbox" checked={interview.consent} disabled={taking !== 'idle'} onChange={(event) => consent(event.target.checked)} />
              <span>{who} agreed to be recorded</span>
            </label>

            <div className={`interview__deck${taking === 'recording' ? ' is-live' : ''}`}>
              <button
                type="button" className="interview__record" disabled={taking === 'saving' || (taking === 'idle' && !canRecord)}
                aria-label={taking === 'recording' ? 'Stop recording' : 'Record'} aria-pressed={taking === 'recording'}
                title={!interview.consent ? `Tick that ${who} agreed first` : taking === 'recording' ? 'Stop recording' : 'Record from this machine\'s microphone'}
                onClick={() => void record()}
              ><span /></button>
              <div className="interview__meter" aria-hidden="true"><i style={{ transform: `scaleX(${level})` }} /></div>
              <span className="interview__clock" aria-label="Recording time">{taking === 'saving' ? 'saving…' : stamp(seconds)}</span>
            </div>
            <p className="interview__or">
              {taking === 'recording' ? 'Recording. Press the square to stop.' : <>Or drop a recording here, or <button type="button" disabled={!interview.consent || taking !== 'idle' || busy} onClick={() => chooser.current?.click()}>choose a file</button>.</>}
              <input ref={chooser} type="file" hidden aria-label="Recording file" accept="audio/*,video/*,.m4a,.opus" onChange={(event) => { add(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
            </p>

            {interview.recordings.length > 0 && (
              <ul className="interview__recordings" aria-label="Recordings">
                {interview.recordings.map((one, index) => (
                  <li key={one.path}>
                    <span>Recording {index + 1}</span><span>{length(one.seconds)}</span>
                    <button type="button" aria-label={`Remove recording ${index + 1}`} title="Remove this recording" disabled={busy} onClick={() => { if (window.confirm(`Remove recording ${index + 1}? Its sound goes to the workspace's trash.`)) act(removeRecording(id, index)); }}>
                      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {busy && <p className="interview__status" role="status">{interview.line ?? 'Writing it down…'} <span>{stamp((now - since) / 1000)}</span></p>}
            {interview.state === 'failed' && interview.problem && (
              <p className="interview__status is-failed" role="alert">{interview.problem} <button type="button" onClick={() => act(retryInterview(id))}>Try again</button></p>
            )}

            {interview.transcript.length > 0 && (
              <section className="interview__transcript" aria-label="Transcript">
                <h3>Transcript <span>{length(total)}{interview.tookMs && interview.engine !== 'fake' ? `, written down in ${Math.max(1, Math.round(interview.tookMs / 1000))} s` : ''}</span></h3>
                <ol data-tail>
                  {interview.transcript.map((line, index) => (
                    <li key={index} className={line === playingLine ? 'is-playing' : undefined}>
                      <button type="button" aria-label={`Listen from ${stamp(line.at)}`} title="Listen from here" onClick={() => listen(line.at)}>{stamp(line.at)}</button>
                      <span>{line.text}</span>
                    </li>
                  ))}
                </ol>
              </section>
            )}
            {!interview.recordings.length && !busy && <p className="interview__empty">{interview.consent ? 'Press record when the call starts. On headphones the other side is not heard here: record in the call app and drop the file instead.' : `Tick that ${who} agreed to be recorded, then record the call or drop a recording.`}</p>}

            <section className="interview__insights" aria-label="Insights">
              <h3>Insights</h3>
              {interview.insights && (
                <p>{interview.insights.by} was asked to write them in <button type="button" className="interview__link" onClick={() => jumpTo(interview.insights!.docId)}>{interview.insights.title}</button>.</p>
              )}
              <div className="interview__ask">
                {people.length > 1 && (
                  <select aria-label="Who writes the insights" value={chosen?.id} onChange={(event) => setWriter(event.target.value)}>
                    {people.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
                  </select>
                )}
                <button
                  type="button" className="primary" disabled={!chosen || !interview.transcript.length}
                  title={!interview.transcript.length ? 'Once the transcript is in' : !chosen ? 'Wire a person to this card first' : `${chosen.name} writes pains, workaround, quotes and would-pay into a doc`}
                  onClick={() => act(writeInsights())}
                >{interview.insights ? 'Ask again' : 'Write insights'}</button>
              </div>
            </section>
          </>
        )}
        {problem && <p className="board__problem">{problem}</p>}
        <p className="interview__private">{PRIVATE}</p>
      </div>
      <audio ref={player} hidden preload="none"
        onTimeUpdate={(event) => { const audio = event.currentTarget; const index = interview.recordings.findIndex((_, at) => audio.src.endsWith(soundUrl(id, at))); const from = interview.recordings.slice(0, Math.max(0, index)).reduce((sum, one) => sum + one.seconds, 0); setPlaying({ at: from + audio.currentTime, on: !audio.paused }); }}
        onPause={() => setPlaying((was) => (was ? { ...was, on: false } : was))}
      />
    </Frame>
  );
}
