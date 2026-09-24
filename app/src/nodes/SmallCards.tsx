import { useReactFlow, type NodeProps } from '@xyflow/react';
import { useEffect, useRef, useState, type DragEvent } from 'react';
import { fileUrl, refreshLink, uploadFile } from '../api';
import { useMedia } from '../media';
import { safeHost } from '../../shared/sources';
import { studioBehind } from '../../shared/model';
import { useFlowPick, useGrowOnce } from '../flow';
import { fromFlow, type ImageNodeType, type LinkNodeType, type NoteNodeType, type SourceNodeType } from '../stage';
import { useFlushStage } from '../sync';
import { CardActions, Frame } from './Frame';
import { LivePicture, OpenLarge } from './LivePicture';

const COLORS = ['#f0b35a', '#ee8a72', '#6fcf97', '#4e8cff', '#b58cff'];

// A sticky note. Wired to a person, its words are part of what that person knows.
export function NoteNode({ id, data, selected }: NodeProps<NoteNodeType>) {
  const { updateNodeData } = useReactFlow();
  const color = data.color ?? COLORS[0];
  return (
    <Frame selected={!!selected} minWidth={180} minHeight={120}>
      <div className="note" style={{ '--note': color } as React.CSSProperties}>
        <header className="card__header card__header--doc note__bar">
          <button type="button" className="note__color nodrag" aria-label="Change colour" title="Change colour" onClick={() => updateNodeData(id, { color: COLORS[(COLORS.indexOf(color) + 1) % COLORS.length] })} />
          <div className="card__saved" />
          <CardActions id={id} what="this note" />
        </header>
        <textarea className="note__text nodrag nowheel" aria-label="Note" placeholder="A thought, a rule, a number…" value={data.text} onChange={(event) => updateNodeData(id, { text: event.target.value })} />
      </div>
    </Frame>
  );
}

// A picture on the stage. Wired to a person, a model that can see gets it with every question.
export function ImageNode({ id, data, selected }: NodeProps<ImageNodeType>) {
  const { updateNodeData } = useReactFlow();
  const picker = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState('');
  // An empty picture card wired to an image studio shows what that studio has drawn. The founder who joins the two
  // up has said "show me what that makes"; before this they said it and got an empty box. The wire is read out of
  // the live graph rather than a snapshot, so the picture arrives the moment the wire is drawn.
  // The rule itself is `studioBehind`, the one the server shows people and films with.
  const behind = useFlowPick(({ nodes, edges }) => (data.path ? '' : studioBehind(fromFlow(nodes, edges), id) ?? ''));
  const studio = useMedia(behind);
  const drawn = behind ? studio.media.results[0] : undefined;
  async function take(file?: File) {
    if (!file) return;
    if (!file.type.startsWith('image/')) { setProblem('That is not a picture.'); return; }
    try { setProblem(''); updateNodeData(id, { path: (await uploadFile(file)).path }); } catch (error) { setProblem((error as Error).message); }
  }
  const onDrop = (event: DragEvent) => { if (event.dataTransfer.files.length) { event.preventDefault(); void take(event.dataTransfer.files[0]); } };
  return (
    <Frame selected={!!selected} minWidth={160} minHeight={140}>
      <header className="card__header card__header--doc">
        <svg className="doc-icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="1.800" fill="none" stroke="currentColor" strokeWidth="1.2" /><path d="M2.500 11l3.200-3.200 2.600 2.600 1.900-1.900 3.300 3.300" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></svg>
        <div className="card__name">{data.path ? data.path.split('/').pop()?.replace(/^[a-z0-9]+-/, '') : 'Picture'}</div>
        <CardActions id={id} what="this picture card (the file stays in the shared files)" />
      </header>
      <div className="picture nodrag" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
        <input ref={picker} type="file" accept="image/*" hidden onChange={(event) => { void take(event.target.files?.[0]); event.target.value = ''; }} />
        {data.path ? <img src={fileUrl(data.path)} alt="" draggable={false} />
          : drawn ? <><img src={fileUrl(drawn.path)} alt={drawn.prompt} draggable={false} /><p className="picture__from">from the image studio</p></>
            : <button type="button" onClick={() => picker.current?.click()}>Drop a picture here, or choose one</button>}
        {problem && <p className="msg--problem">{problem}</p>}
      </div>
    </Frame>
  );
}

// A web page on the stage. Wired to a person, the page's text is part of what that person knows.
export function LinkNode({ id, data, selected }: NodeProps<LinkNodeType>) {
  const { updateNodeData } = useReactFlow();
  const flushStage = useFlushStage();
  const [draft, setDraft] = useState(data.url);
  const [state, setState] = useState<{ reading?: boolean; preview?: string; problem?: string }>({});
  async function read(url: string) {
    updateNodeData(id, { url, title: undefined });
    if (!url.trim()) return;
    setState({ reading: true });
    try {
      await new Promise((settle) => setTimeout(settle, 0));
      await flushStage();
      const page = await refreshLink(id);
      updateNodeData(id, { title: page.title });
      setState({ preview: page.preview });
    } catch (error) { setState({ problem: (error as Error).message }); }
  }
  // A web address dropped on the stage arrives asking to be read.
  useEffect(() => {
    if (!data.read) return;
    updateNodeData(id, { read: undefined });
    void read(data.url);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.read]);
  return (
    <Frame selected={!!selected} minWidth={240} minHeight={120}>
      <header className="card__header card__header--doc">
        <svg className="doc-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M6.800 9.200a2.600 2.600 0 0 0 3.700 0l2.200-2.200a2.600 2.600 0 0 0-3.700-3.700l-.900.900M9.200 6.800a2.600 2.600 0 0 0-3.700 0L3.300 9a2.600 2.600 0 0 0 3.700 3.700l.900-.900" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>
        <div className="card__name">{data.title || 'Link'}</div>
        {data.url && <a className="link__open nodrag" href={data.url} target="_blank" rel="noreferrer" title="Open in your browser">open</a>}
        <CardActions id={id} what="this link" />
      </header>
      <form className="link nodrag" onSubmit={(event) => { event.preventDefault(); void read(draft.trim()); }}>
        <input aria-label="Web address" placeholder="https://…  then Enter" spellCheck={false} value={draft} onChange={(event) => setDraft(event.target.value)} />
        <p>{state.reading ? 'Reading the page…' : state.problem ? state.problem : state.preview ?? (data.url ? 'Wired people read this page. Press Enter to read it again.' : 'Paste an address. A person wired to this card gets the page text as background.')}</p>
      </form>
    </Frame>
  );
}

// A website the founder trusts. Nobody has to be wired to it: every person may search inside it when the founder's
// line about it fits their question, and the founder watches that search live under the two fields.
export function SourceNode({ id, data, selected }: NodeProps<SourceNodeType>) {
  const { updateNodeData } = useReactFlow();
  // A card saved before it had a live picture was too short to show one, so it grows once to the new size.
  useGrowOnce(id, { width: 360, height: 300 }, { width: 360, height: 320 });
  const flushStage = useFlushStage();
  const [draft, setDraft] = useState(data.url);
  const [state, setState] = useState<{ reading?: boolean; problem?: string }>({});
  const host = safeHost(data.url);
  // The host whose icon has loaded, so a site without one keeps the globe.
  const [icon, setIcon] = useState('');
  async function read(url: string) {
    if (url === data.url && data.title) return;
    updateNodeData(id, { url, title: undefined });
    if (!url) return;
    setState({ reading: true });
    try {
      // Let the new address reach the stage first: the server reads the site from the saved card.
      await new Promise((settle) => setTimeout(settle, 0));
      await flushStage();
      const page = await refreshLink(id);
      updateNodeData(id, { title: page.title });
      setState({});
    } catch (error) { setState({ problem: (error as Error).message }); }
  }
  // A card that lands with an address and no name, as an accepted proposal does, reads its name by itself.
  useEffect(() => {
    if (data.url && !data.title) void read(data.url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  return (
    <Frame selected={!!selected} minWidth={260} minHeight={260}>
      <header className="card__header card__header--doc">
        {/* Only the site's name goes out, to fetch its small icon; until it arrives, or when a site has none, a globe. */}
        <span className="source__icon" aria-hidden="true">
          {icon !== host && <svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" strokeWidth="1.2" /><path d="M2.400 8h11.200M8 2.400c1.700 1.600 2.500 3.500 2.500 5.600S9.700 12 8 13.600M8 2.400C6.300 4 5.500 5.900 5.500 8S6.300 12 8 13.600" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>}
          {host && <img key={host} src={`https://icons.duckduckgo.com/ip3/${host}.ico`} alt="" draggable={false} hidden={icon !== host} onLoad={() => setIcon(host)} onError={() => setIcon('')} />}
        </span>
        <div className="card__name">{data.title || host || 'Source website'}</div>
        {data.url && <a className="link__open nodrag" href={data.url} target="_blank" rel="noreferrer" title="Open in your browser">open</a>}
        <OpenLarge id={id} />
        <CardActions id={id} what="this website" />
      </header>
      <form className="link source nodrag" onSubmit={(event) => { event.preventDefault(); void read(draft.trim()); }}>
        <input aria-label="Web address" placeholder="https://…  then Enter" spellCheck={false} value={draft} onChange={(event) => setDraft(event.target.value)}
          onBlur={() => { if (draft.trim() !== data.url) void read(draft.trim()); }} />
        <input aria-label="What people find here" placeholder="What people find here, in a line" value={data.about} onChange={(event) => updateNodeData(id, { about: event.target.value })} />
        <p className={state.problem ? 'msg--problem' : undefined}>{state.reading ? 'Looking at the site…' : state.problem ?? 'Every person may search inside this site when your line fits their question.'}</p>
      </form>
      <LivePicture id={id} kind="source" idle={<p className="chat__empty">When a person searches this site, you watch it here.</p>} />
    </Frame>
  );
}
