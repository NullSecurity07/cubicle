import { useReactFlow, type NodeProps } from '@xyflow/react';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { coderChannel, type CoderAsk as Asked, type CoderEvent, type CoderLine, type CoderLive, type CoderLiveTool, type CoderPatch, type CoderState, type GraphMark, type GraphView } from '../../shared/coder';
import { askCoder, getCoder, getCoderGraph, getCoderPatches, mapCoderFolder, newCoderSession, stopCoder, undoCoder } from '../api';
import { feed, snapshot } from '../feed';
import { overlay, useFocused } from '../overlay/store';
import type { ProjectNodeType } from '../stage';
import { useFlushStage } from '../sync';
import { CoderAsk } from './CoderAsk';
import { CoderModel } from './CoderModel';
import { CardActions, Frame } from './Frame';
import { Words } from './Rich';
import './coder.css';
import { pressed } from '../keys';
import { useAttempt } from '../attempt';
import { SEND_ICON, STOP_ICON } from './icons';
import { useGrowOnce } from '../flow';

type View = { lines: CoderLine[]; state: CoderState; permission: Asked | null; waiting: number; live: CoderLive | null };
const SAID: Record<CoderState, string> = { idle: 'Idle', working: 'Working', waiting: 'Waiting for you', stopped: 'Stopped' };

// The card's log, its question and its state, as the server has them: the whole of it when the window opens (or the
// feed comes back after a gap), then one step at a time. The session the server started is written onto the card, so
// the stage the window saves never loses it.
function useCoder(id: string, keep: (session: string | undefined) => void): View {
  const [view, setView] = useState<View>({ lines: [], state: 'idle', permission: null, waiting: 0, live: null });
  const kept = useRef(keep);
  kept.current = keep;
  useEffect(() => {
    const apply = (event: CoderEvent) => setView((was) => ({
      lines: event.lines ?? (event.line ? [...was.lines.slice(-199), event.line] : was.lines),
      state: event.state ?? was.state,
      permission: event.permission === undefined ? was.permission : event.permission,
      waiting: event.waiting ?? (event.permission === null ? 0 : was.waiting),
      live: event.live === undefined ? was.live : event.live,
    }));
    const read = () => { getCoder(id).then((now) => apply({ lines: now.lines, state: now.state, permission: now.permission ?? null, waiting: now.waiting ?? 0, live: now.live ?? null }), () => {}); };
    const stop = feed<CoderEvent>(coderChannel(id), (event) => {
      apply(event);
      if (event.session !== undefined && !event.lines) kept.current(event.session || undefined);
    }, (again) => { if (again) read(); });
    if (snapshot(coderChannel(id)) === undefined) read();
    return stop;
  }, [id]);
  return view;
}

// The folder's map as the server has it, read again whenever a map is made and whenever the feed comes back. The
// counts are written onto the card too, so the stage the window saves keeps them.
function useMap(id: string, keep: (mark: GraphMark) => void): GraphView & { ready: boolean } {
  const [view, setView] = useState<GraphView & { ready: boolean }>({ mapped: false, mapping: false, ready: false });
  const kept = useRef(keep);
  kept.current = keep;
  useEffect(() => {
    const read = () => { getCoderGraph(id).then((now) => setView({ ...now, ready: true }), () => {}); };
    const stop = feed<CoderEvent>(coderChannel(id), (event) => {
      if (event.mapping !== undefined) setView((was) => ({ ...was, mapping: !!event.mapping }));
      if (event.graph) { kept.current(event.graph); read(); }
    }, (again) => { if (again) read(); });
    read();
    return stop;
  }, [id]);
  return view;
}

// "3 minutes ago", said the way the rest of the card says time.
function ago(at: number, now: number) {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

// The start of Graphify's own report, for the card opened large.
function MapReport({ map, onBack }: { map: GraphView; onBack: () => void }) {
  return (
    <div className="coder__changes coder__report nodrag nowheel">
      <button type="button" className="coder__back" onClick={onBack}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 4 6 8l4 4" /></svg>Back to the log
      </button>
      {map.report ? <Words text={map.report} /> : <p className="chat__empty">This folder has no map yet.</p>}
      {map.page && <a className="coder__open" href={map.page} target="_blank" rel="noreferrer">Open the graph</a>}
    </div>
  );
}

// How long a step ran, the way a stopwatch says it: 0.4 s, 3.2 s, 2 m 5 s.
function took(ms: number) {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} m ${Math.round((ms % 60_000) / 1000)} s`;
}
// Time since the work began, counted in whole seconds.
function elapsed(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} m ${seconds % 60} s`;
}
// Tokens the way people say them: 840, 6.3k, 1.2M.
function count(tokens: number) {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 100_000 ? 1 : 0).replace(/\.0$/, '')}k`;
  return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

// What a command printed: its last few lines, kept scrolled to the newest.
function Output({ text, lines = 6 }: { text: string; lines?: number }) {
  const box = useRef<HTMLPreElement>(null);
  const shown = text.split('\n').slice(-lines).join('\n');
  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; }, [shown]);
  return <pre className="coder__out" ref={box}>{shown}</pre>;
}

// A finished step, with how long it took and, when it printed something, a quiet way to look at it. The step's own
// words stay alone in their line, the way the log has always said them.
function Step({ line, children }: { line: CoderLine; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const timed = line.took !== undefined && line.took >= 100;
  if (!timed && !line.detail) return <>{children}</>;
  return (
    <>
      <div className="coder__step">
        {children}
        {timed && <span className="coder__took"> · {took(line.took!)}</span>}
        {line.detail && (
          <button type="button" className={`coder__peek${open ? ' is-open' : ''}`} aria-label={open ? 'Hide output' : 'Show output'} aria-expanded={open} title={open ? 'Hide output' : 'Show output'} onClick={() => setOpen((was) => !was)}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4" /></svg>
          </button>
        )}
      </div>
      {open && line.detail && <pre className="coder__out coder__out--done">{line.detail}</pre>}
    </>
  );
}

// A step still running: a small turning ring, the tool and what it works on, and what a command has printed so far.
function Running({ tool }: { tool: CoderLiveTool }) {
  return (
    <div className="coder__running">
      <div className="coder__running-head"><i className="coder__ring" aria-hidden="true" /><span className="coder__tool">{tool.tool}</span> {tool.file ? <span className="coder__file">{tool.file}</span> : tool.what}</div>
      {tool.output && <Output text={tool.output} />}
    </div>
  );
}

// The coder this moment, at the foot of the log: thinking, the steps running, the reply as it is written, and a quiet
// line saying which step, for how long and how many tokens so far.
function Live({ live, now }: { live: CoderLive; now: number }) {
  const tokens = live.tokens.input + live.tokens.output + live.tokens.reasoning + live.tokens.cache;
  const pulse = [live.step > 0 ? `Step ${live.step}` : '', elapsed(now - live.since), tokens > 0 ? `${count(tokens)} tokens` : '', live.cost > 0 ? `$${live.cost < 1 ? live.cost.toFixed(3) : live.cost.toFixed(2)}` : ''].filter(Boolean).join(' · ');
  return (
    <div className="coder__live">
      {live.thinking && <div className="coder__thinking">Thinking…</div>}
      {live.tools.map((tool) => <Running key={tool.id} tool={tool} />)}
      {live.text && <div className="coder__line coder__line--reply is-live">{live.text}</div>}
      <div className="coder__pulse">{pulse}</div>
    </div>
  );
}

// One step in the log. A diff opens the card large on the changes themselves.
function Line({ line, onChanges }: { line: CoderLine; onChanges: () => void }) {
  if (line.kind === 'ask') return <div className="coder__line coder__line--ask"><span className="coder__who">{line.by ?? 'You'}</span>{line.text}</div>;
  if (line.kind === 'reply') return <div className="coder__line coder__line--reply">{line.text}</div>;
  if (line.kind === 'diff') {
    const [, added, removed, files] = /^\+(\d+) −(\d+) in (.+)$/.exec(line.text) ?? [];
    return (
      <button type="button" className="coder__line coder__line--diff" title="See the changes" onClick={onChanges}>
        {added ? <><span className="coder__added">+{added}</span> <span className="coder__removed">−{removed}</span> in {files}</> : line.text}
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4" /></svg>
      </button>
    );
  }
  if (line.kind === 'tool') {
    const [tool, ...rest] = line.text.split(' ');
    return <Step line={line}><div className="coder__line coder__line--tool"><span className="coder__tool">{tool}</span> {line.file ? <span className="coder__file">{line.file}</span> : rest.join(' ')}</div></Step>;
  }
  // A failure shows its full words on the chevron when the line had to cut them short.
  if (line.kind === 'error' && line.detail && line.detail.length > 160) return <Step line={line}><div className="coder__line coder__line--error">{line.text}</div></Step>;
  return <div className={`coder__line coder__line--${line.kind}`}>{line.text}</div>;
}

// The changes the coder made, file by file, for the card opened large.
function Changes({ id, onBack }: { id: string; onBack: () => void }) {
  const [files, setFiles] = useState<CoderPatch[] | null>(null);
  const [problem, setProblem] = useState('');
  useEffect(() => { getCoderPatches(id).then(setFiles, (error: Error) => setProblem(error.message)); }, [id]);
  return (
    <div className="coder__changes nodrag nowheel">
      <button type="button" className="coder__back" onClick={onBack}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 4 6 8l4 4" /></svg>Back to the log
      </button>
      {problem && <p className="msg--problem">{problem}</p>}
      {files && !files.length && <p className="chat__empty">Nothing in the folder has changed.</p>}
      {files?.map((file) => (
        <section key={file.file} className="coder__patch" aria-label={file.file}>
          <h4><span>{file.file}</span><span className="coder__added">+{file.additions}</span><span className="coder__removed">−{file.deletions}</span></h4>
          <pre>{file.patch.split('\n').filter((row) => !/^(diff --git|index |--- |\+\+\+ )/.test(row)).map((row, at) => (
            <span key={at} className={row.startsWith('+') ? 'is-added' : row.startsWith('-') ? 'is-removed' : row.startsWith('@@') ? 'is-hunk' : undefined}>{row}{'\n'}</span>
          ))}</pre>
        </section>
      ))}
    </div>
  );
}

// A running OpenCode in one folder. The founder asks it directly here, or a wired person hands it work; every step,
// every question and every change shows here as it happens.
export function CoderNode({ id, data, selected }: NodeProps<ProjectNodeType>) {
  const { updateNodeData } = useReactFlow();
  const flushStage = useFlushStage();
  const focused = useFocused(id);
  const view = useCoder(id, (session) => updateNodeData(id, { session }));
  const [draft, setDraft] = useState('');
  const { problem, setProblem, attempt } = useAttempt();
  const [changes, setChanges] = useState(false);
  const [report, setReport] = useState(false);
  const map = useMap(id, (graph) => updateNodeData(id, { graph }));
  const [now, setNow] = useState(() => Date.now());
  const log = useRef<HTMLDivElement>(null);
  const name = data.path.trim().replace(/\/+$/, '').split('/').pop() || 'Coder';
  const busy = view.state === 'working' || view.state === 'waiting';
  const live = busy ? view.live : null;
  const showing = !!live && (live.thinking || live.tools.length > 0 || !!live.text);
  const [clock, setClock] = useState(() => Date.now());

  // A card saved when this was the one-shot project card was too small for a conversation, so it grows once.
  useGrowOnce(id, { width: 380, height: 380 }, { width: 420, height: 440 });
  const liveSize = live ? live.text.length + live.tools.reduce((sum, one) => sum + 1 + (one.output?.length ?? 0), 0) : 0;
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight, behavior: 'smooth' }); }, [view.lines.length, view.permission, view.state, liveSize, live?.thinking]);
  // The live line's seconds count up while the coder works.
  useEffect(() => {
    if (!live) return;
    setClock(Date.now());
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [!!live, live?.since]);
  // Back on the stage, the log is what the card shows.
  useEffect(() => { if (!focused) { setChanges(false); setReport(false); } }, [focused]);
  // "Mapped 3 minutes ago" stays true as the minutes pass.
  useEffect(() => {
    if (!map.mapped) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [map.mapped, map.at]);

  async function send() {
    const text = draft.trim();
    if (!text || busy) return;
    if (!data.path.trim()) { setProblem('Set the folder first.'); return; }
    await attempt(async () => { await flushStage(); await askCoder(id, text, { path: data.path, model: data.model }); setDraft(''); });
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => { if (pressed(event, 'send')) { event.preventDefault(); void send(); } };
  const openChanges = () => { setReport(false); setChanges(true); if (!focused) overlay.open({ kind: 'focus', id }); };
  const openReport = () => { setChanges(false); setReport(true); if (!focused) overlay.open({ kind: 'focus', id }); };
  async function mapFolder() {
    if (!data.path.trim()) { setProblem('Set the folder first.'); return; }
    await attempt(async () => { await flushStage(); await mapCoderFolder(id, data.path); });
  }

  return (
    <Frame selected={!!selected} minWidth={340} minHeight={320}>
      <header className="card__header card__header--doc">
        <svg className="doc-icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.800" y="2.800" width="12.400" height="10.400" rx="2" fill="none" stroke="currentColor" strokeWidth="1.2" /><path d="M4.600 6.400 6.600 8l-2 1.600M8.200 10h3" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
        <div className="card__name">{name}</div>
        <CoderModel model={data.model} onPick={(model) => updateNodeData(id, { model })} />
        <span className={`coder__dot coder__dot--${view.state}`} role="status" aria-label={`Coder: ${SAID[view.state]}`} title={SAID[view.state]} />
        <CardActions id={id} what={`the ${name} coder (the folder itself stays)`} />
      </header>
      <input className="project__path nodrag" aria-label="Project folder" spellCheck={false} placeholder="/full/path/to/your/project" value={data.path} onChange={(event) => updateNodeData(id, { path: event.target.value })} />
      {changes && focused ? <Changes id={id} onBack={() => setChanges(false)} /> : report && focused ? <MapReport map={map} onBack={() => setReport(false)} /> : (
        <div className="project__log coder__log nodrag nowheel" data-tail ref={log} aria-live="polite">
          {view.lines.length === 0 && !view.permission
            ? <p className="chat__empty">Set the folder, then tell the coder what to build or fix, here or through a person wired to this card. It works inside this folder only, and asks you before it changes a file or runs a command.</p>
            : view.lines.map((line) => <Line key={`${line.at}:${line.kind}:${line.text.slice(0, 48)}`} line={line} onChanges={openChanges} />)}
          {live && <Live live={live} now={clock} />}
          {view.permission && <CoderAsk key={view.permission.id} cardId={id} ask={view.permission} />}
          {view.permission && view.waiting > 0 && <p className="coder__more">and {view.waiting} more waiting</p>}
          {view.state === 'working' && !showing && <div className="coder__working" aria-hidden="true"><i /><i /><i /></div>}
        </div>
      )}
      {problem && <p className="msg--problem coder__problem" role="alert">{problem}</p>}
      {map.mapped && map.at && !map.mapping && (
        <p className="coder__map nodrag">
          <span>Mapped {ago(map.at, now)} · {map.nodes?.toLocaleString('en-GB')} nodes · {map.communities?.toLocaleString('en-GB')} groups</span>
          {map.page && <a href={map.page} target="_blank" rel="noreferrer" title="The map as a picture, in your browser">Open graph</a>}
          <button type="button" title="What Graphify found" onClick={openReport}>Report</button>
        </p>
      )}
      <div className="coder__tools nodrag">
        <button type="button" disabled={busy || !view.lines.some((one) => one.kind === 'ask')} title="Put the folder back to before the last thing the coder was asked" onClick={() => void attempt(() => undoCoder(id))}>Undo last</button>
        <button type="button" disabled={busy || !view.lines.length} title="Start a fresh conversation with the coder; this one stays in its history" onClick={() => void attempt(() => newCoderSession(id))}>New session</button>
        <button type="button" disabled={busy || map.mapping || !data.path.trim()} title="Map the folder's code with Graphify, so people and the coder find their way around it" onClick={() => void mapFolder()}>{map.mapping ? 'Mapping…' : 'Map folder'}</button>
      </div>
      <div className="ask nodrag nowheel">
        <textarea rows={1} value={draft} aria-label="Tell the coder" placeholder="Tell the coder what to do…" onChange={(event) => setDraft(event.target.value)} onKeyDown={onKeyDown} />
        {busy ? (
          <button type="button" className="ask__stop" aria-label="Stop" title="Stop the coder" onClick={() => void attempt(() => stopCoder(id))}>
            {STOP_ICON}
          </button>
        ) : (
          <button type="button" aria-label="Send to the coder" disabled={!draft.trim()} onClick={() => void send()}>
            {SEND_ICON}
          </button>
        )}
      </div>
    </Frame>
  );
}
