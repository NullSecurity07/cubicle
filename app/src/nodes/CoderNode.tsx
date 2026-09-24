import { useReactFlow, type NodeProps } from '@xyflow/react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { coderChannel, type CoderAsk as Asked, type CoderEvent, type CoderLine, type CoderPatch, type CoderState } from '../../shared/coder';
import { askCoder, getCoder, getCoderPatches, newCoderSession, stopCoder, undoCoder } from '../api';
import { feed, snapshot } from '../feed';
import { overlay, useFocused } from '../overlay/store';
import type { ProjectNodeType } from '../stage';
import { useFlushStage } from '../sync';
import { CoderAsk } from './CoderAsk';
import { CoderModel } from './CoderModel';
import { CardActions, Frame } from './Frame';
import './coder.css';

type View = { lines: CoderLine[]; state: CoderState; permission: Asked | null; waiting: number };
const SAID: Record<CoderState, string> = { idle: 'Idle', working: 'Working', waiting: 'Waiting for you', stopped: 'Stopped' };

// The card's log, its question and its state, as the server has them: the whole of it when the window opens (or the
// feed comes back after a gap), then one step at a time. The session the server started is written onto the card, so
// the stage the window saves never loses it.
function useCoder(id: string, keep: (session: string | undefined) => void): View {
  const [view, setView] = useState<View>({ lines: [], state: 'idle', permission: null, waiting: 0 });
  const kept = useRef(keep);
  kept.current = keep;
  useEffect(() => {
    const apply = (event: CoderEvent) => setView((was) => ({
      lines: event.lines ?? (event.line ? [...was.lines.slice(-199), event.line] : was.lines),
      state: event.state ?? was.state,
      permission: event.permission === undefined ? was.permission : event.permission,
      waiting: event.waiting ?? (event.permission === null ? 0 : was.waiting),
    }));
    const read = () => { getCoder(id).then((now) => apply({ lines: now.lines, state: now.state, permission: now.permission ?? null, waiting: now.waiting ?? 0 }), () => {}); };
    const stop = feed<CoderEvent>(coderChannel(id), (event) => {
      apply(event);
      if (event.session !== undefined && !event.lines) kept.current(event.session || undefined);
    }, (again) => { if (again) read(); });
    if (snapshot(coderChannel(id)) === undefined) read();
    return stop;
  }, [id]);
  return view;
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
    return <div className="coder__line coder__line--tool"><span className="coder__tool">{tool}</span> {line.file ? <span className="coder__file">{line.file}</span> : rest.join(' ')}</div>;
  }
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
  const { updateNodeData, updateNode } = useReactFlow();
  const flushStage = useFlushStage();
  const focused = useFocused(id);
  const view = useCoder(id, (session) => updateNodeData(id, { session }));
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState('');
  const [changes, setChanges] = useState(false);
  const log = useRef<HTMLDivElement>(null);
  const name = data.path.trim().replace(/\/+$/, '').split('/').pop() || 'Coder';
  const busy = view.state === 'working' || view.state === 'waiting';

  // A card saved when this was the one-shot project card was too small for a conversation, so it grows once.
  useEffect(() => {
    updateNode(id, (node) => {
      const [width, height] = [node.width ?? node.measured?.width ?? 0, node.height ?? node.measured?.height ?? 0];
      return height >= 380 && width >= 380 ? {} : { width: Math.max(width, 420), height: Math.max(height, 440) };
    });
  }, [id, updateNode]);
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight, behavior: 'smooth' }); }, [view.lines.length, view.permission, view.state]);
  // Back on the stage, the log is what the card shows.
  useEffect(() => { if (!focused) setChanges(false); }, [focused]);

  const attempt = async (work: () => Promise<unknown>) => { setProblem(''); try { await work(); } catch (error) { setProblem((error as Error).message); } };
  async function send() {
    const text = draft.trim();
    if (!text || busy) return;
    if (!data.path.trim()) { setProblem('Set the folder first.'); return; }
    await attempt(async () => { await flushStage(); await askCoder(id, text, { path: data.path, model: data.model }); setDraft(''); });
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } };
  const openChanges = () => { setChanges(true); if (!focused) overlay.open({ kind: 'focus', id }); };

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
      {changes && focused ? <Changes id={id} onBack={() => setChanges(false)} /> : (
        <div className="project__log coder__log nodrag nowheel" data-tail ref={log} aria-live="polite">
          {view.lines.length === 0 && !view.permission
            ? <p className="chat__empty">Set the folder, then tell the coder what to build or fix, here or through a person wired to this card. It works inside this folder only, and asks you before it changes a file or runs a command.</p>
            : view.lines.map((line) => <Line key={`${line.at}:${line.kind}:${line.text.slice(0, 48)}`} line={line} onChanges={openChanges} />)}
          {view.permission && <CoderAsk key={view.permission.id} cardId={id} ask={view.permission} />}
          {view.permission && view.waiting > 0 && <p className="coder__more">and {view.waiting} more waiting</p>}
          {view.state === 'working' && <div className="coder__working" aria-hidden="true"><i /><i /><i /></div>}
        </div>
      )}
      {problem && <p className="msg--problem coder__problem" role="alert">{problem}</p>}
      <div className="coder__tools nodrag">
        <button type="button" disabled={busy || !view.lines.some((one) => one.kind === 'ask')} title="Put the folder back to before the last thing the coder was asked" onClick={() => void attempt(() => undoCoder(id))}>Undo last</button>
        <button type="button" disabled={busy || !view.lines.length} title="Start a fresh conversation with the coder; this one stays in its history" onClick={() => void attempt(() => newCoderSession(id))}>New session</button>
      </div>
      <div className="ask nodrag nowheel">
        <textarea rows={1} value={draft} aria-label="Tell the coder" placeholder="Tell the coder what to do…" onChange={(event) => setDraft(event.target.value)} onKeyDown={onKeyDown} />
        {busy ? (
          <button type="button" className="ask__stop" aria-label="Stop" title="Stop the coder" onClick={() => void attempt(() => stopCoder(id))}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4.5" y="4.500" width="7" height="7" rx="1.5" fill="currentColor" /></svg>
          </button>
        ) : (
          <button type="button" aria-label="Send to the coder" disabled={!draft.trim()} onClick={() => void send()}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        )}
      </div>
    </Frame>
  );
}
