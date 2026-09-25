import { useReactFlow, type Node, type NodeProps } from '@xyflow/react';
import { useEffect, useRef, useState } from 'react';
import { CHECK_NAMES, DESKTOP, EMPTY_SITE, PHONE, SITE_LOOK_NAMES, SITE_LOOKS, type Site, type SiteLook } from '../../shared/site';
import { useAddCard } from '../addCard';
import { emit } from '../bus';
import { pressed } from '../keys';
import { useElapsed } from '../media';
import { WIRE } from '../stage';
import { useFlushStage } from '../sync';
import { CardActions, Frame } from './Frame';
import { editSite, makeSite, pageUrl, serveSite, stopSite, watchSite, zipUrl } from './siteApi';
import './site.css';

export type SiteNodeType = Node<{ brief?: string; look?: SiteLook; sections?: string[] }, 'site'>;

// One width of the page, drawn at its real size in a frame and scaled to fit the pane, so what the card shows is what a
// visitor's screen shows. The frame may scroll; it runs no script, so nothing in it can reach the app.
function Screen({ src, width, height, label, scale }: { src: string; width: number; height: number; label: string; scale: number }) {
  return (
    <figure className="site__screen" style={{ width: width * scale, height: height * scale }}>
      {scale > 0 && <iframe src={src} title={label} sandbox="allow-same-origin" loading="lazy" className="nowheel" style={{ width, height, transform: `scale(${scale})` }} />}
      <figcaption>{label}</figcaption>
    </figure>
  );
}

// A one-page website: a brief and what is wired to the card become a page in one of three looks, looked at on a
// laptop and a phone side by side, checked by the critic, and handed over as a folder. Notes remake the sections
// they touch, as the next version beside the last.
export function SiteNode({ id, data, selected }: NodeProps<SiteNodeType>) {
  const { updateNodeData, getNodes, getEdges, getNode, setEdges } = useReactFlow();
  const addCard = useAddCard();
  const [site, setSite] = useState<Site>(EMPTY_SITE);
  const [shownVersion, setShownVersion] = useState<number | null>(null);
  const [notes, setNotes] = useState('');
  const [asked, setAsked] = useState(false);
  const [problem, setProblem] = useState('');
  const [serving, setServing] = useState(false);
  const [scale, setScale] = useState(0);
  const again = useRef<() => void>(() => {});
  const log = useRef<HTMLDivElement>(null);
  const panes = useRef<HTMLDivElement>(null);
  const flushStage = useFlushStage();
  const making = asked || site.state === 'making';
  const elapsed = useElapsed(making);

  useEffect(() => {
    let watch: ReturnType<typeof watchSite> | null = null;
    let gone = false;
    // The server must know this card before it will say anything about it.
    void flushStage().then(() => {
      if (gone) return;
      watch = watchSite(id, (event) => {
        setSite(event.site);
        if (event.site.state !== 'making') setAsked(false);
      });
      again.current = watch.again;
    });
    return () => { gone = true; watch?.stop(); };
  }, [id, flushStage]);

  // The feed is the fast path, not the only one: while a site is being made the card also asks now and then.
  useEffect(() => {
    if (!making) return;
    const timer = setInterval(() => again.current(), 2000);
    return () => clearInterval(timer);
  }, [making]);
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [site.log]);

  // Both widths at one scale, so the phone sits beside the laptop at its true size against it.
  useEffect(() => {
    const at = panes.current;
    if (!at) return;
    const fit = () => setScale(Math.max(0.1, (at.clientWidth - 14) / (DESKTOP.width + PHONE.width)));
    fit();
    const watch = new ResizeObserver(fit);
    watch.observe(at);
    return () => watch.disconnect();
  }, []);

  const newest = site.versions.at(-1);
  const seenNewest = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (newest && seenNewest.current !== undefined && newest.version !== seenNewest.current) setShownVersion(null);
    seenNewest.current = newest?.version;
  }, [newest]);
  const version = site.versions.find((one) => one.version === shownVersion) ?? newest;
  const brief = data.brief ?? '';
  const look = data.look ?? 'clean';

  const act = (job: Promise<unknown>) => { setProblem(''); setAsked(true); job.catch((error: Error) => { setProblem(error.message); setAsked(false); }); };
  const make = () => { if (!making && brief.trim()) act(makeSite(id, { brief: brief.trim(), look })); };
  const edit = () => { if (!making && version && notes.trim()) { act(editSite(id, notes.trim(), version.version)); setNotes(''); } };

  // "Serve locally": the page opened in a plain browser card wired to this one, put down beside it when there is none.
  async function openInBrowser() {
    if (!version || serving) return;
    setServing(true);
    setProblem('');
    try {
      const joined = getEdges().filter((edge) => edge.source === id || edge.target === id).map((edge) => (edge.source === id ? edge.target : edge.source));
      let browserId = getNodes().find((node) => node.type === 'browser' && joined.includes(node.id) && !(node.data as { app?: unknown }).app)?.id;
      if (!browserId) {
        const me = getNode(id);
        const at = me ? { x: me.position.x + (me.width ?? 760) + 330, y: me.position.y + 200 } : undefined;
        browserId = addCard('browser', {}, at);
        const made = browserId;
        setEdges((edges) => [...edges, { id: `${id}-${made}`, source: id, sourceHandle: 'r', target: made, targetHandle: 'l', ...WIRE }]);
        await new Promise((settle) => setTimeout(settle, 0));
      }
      await flushStage();
      await serveSite(id, browserId, version.version);
      emit('effect', { kind: 'browser-moved', id: browserId, roomId: '' });
    } catch (error) { setProblem((error as Error).message); } finally { setServing(false); }
  }

  // What this site is made from, in the founder's words, so nothing on it is a surprise.
  const using = (() => {
    const joined = getEdges().filter((edge) => edge.source === id || edge.target === id).map((edge) => (edge.source === id ? edge.target : edge.source));
    return getNodes().filter((node) => joined.includes(node.id)).flatMap((node) => {
      if (node.type === 'doc') return [String((node.data as { title?: string }).title ?? 'a document')];
      if (node.type === 'note') return ['a note'];
      if (node.type === 'project') return [`${String((node.data as { path?: string }).path ?? '').split('/').filter(Boolean).at(-1) ?? 'a'} project`];
      if (node.type === 'metrics') return ['the Metrics card'];
      if (node.type === 'imagegen') return ['the Image studio'];
      if (node.type === 'image') return ['a picture'];
      return [];
    });
  })();
  const failed = !making && (problem || (site.state === 'failed' ? site.problem : ''));
  const src = version ? pageUrl(id, version.version) : '';

  return (
    <Frame selected={!!selected} minWidth={560} minHeight={560}>
      <header className="card__header card__header--doc">
        <svg className="doc-icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.8" y="2.6" width="12.4" height="10.8" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.2" /><path d="M1.8 5.4h12.4M4 4h.01M5.6 4h.01M4.2 8h4.4M4.2 10.2h2.6" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>
        <div className="card__name">Site {version && <span>v{version.version}</span>}</div>
        <CardActions id={id} what="this Site card (its folders stay in the workspace)" />
      </header>
      <div className="studio site nodrag">
        <div className="site__panes" ref={panes} aria-label="Previews">
          {version && !making && (
            <div className="site__pair" key={version.version}>
              <Screen src={src} width={DESKTOP.width} height={DESKTOP.height} scale={scale} label={`Desktop, ${DESKTOP.width} px`} />
              <Screen src={src} width={PHONE.width} height={PHONE.height} scale={scale} label={`Phone, ${PHONE.width} px`} />
            </div>
          )}
          {making && (
            <div className="project__log site__lines nowheel" ref={log} aria-live="polite">
              {site.log.length ? site.log.map((line, index) => <div key={index}>{line}</div>) : <div>starting…</div>}
              <div className="studio__clock">{elapsed}</div>
            </div>
          )}
          {!version && !making && <p className="chat__empty">Say what the site is for and who it is for, then press Make. Wire documents, notes, a project, pictures or a Metrics card to it and it is made from them.</p>}
        </div>
        {version && !making && (
          <ul className="site__checks" aria-label="What the critic checked">
            {version.checks.map((check) => (
              <li key={check.rule} className={check.ok ? 'is-ok' : 'is-off'} title={check.said}>
                <span aria-hidden="true">{check.ok ? '✓' : '!'}</span>{CHECK_NAMES[check.rule]}
              </li>
            ))}
          </ul>
        )}
        {version && !making && (
          <div className="studio__done">
            <span className="studio__by">{version.sections.length} sections · {SITE_LOOK_NAMES[version.look]} · {Math.max(1, Math.round(version.bytes / 1024))} KB</span>
            <a href={zipUrl(id, version.version)} download title="index.html, style.css and media/, as one zip. Put the folder on any static host.">Download folder</a>
            <button type="button" className="site__open" disabled={serving} onClick={() => void openInBrowser()} title="Opens this version in a browser card on the stage">{serving ? 'Opening…' : 'Open in browser card'}</button>
          </div>
        )}
        {site.versions.length > 1 && !making && (
          <div className="studio__versions nowheel" aria-label="Versions of this site">
            {site.versions.map((one) => (
              <button key={one.version} type="button" className={one.version === version?.version ? 'is-shown' : undefined} title={one.said?.join('; ') ?? one.brief} onClick={() => setShownVersion(one.version)}>
                <b>v{one.version}</b> {one.notes ?? one.brief ?? 'From the brief'}
              </button>
            ))}
          </div>
        )}
        {version?.said?.length && !making ? <p className="studio__note site__said nowheel">{version.said.join('; ')}.</p> : null}
        {version && !making && (
          <form className="studio__notes" onSubmit={(event) => { event.preventDefault(); edit(); }}>
            <textarea
              aria-label="Notes on this site" rows={1} value={notes}
              placeholder="Shorter hero, drop pricing, button: Book a demo"
              onChange={(event) => setNotes(event.target.value)}
              onKeyDown={(event) => { if (pressed(event, 'send')) { event.preventDefault(); edit(); } }}
            />
            <button type="submit" disabled={!notes.trim()} title="Only the sections the notes touch are made again. The new version lands beside this one.">Edit</button>
          </form>
        )}
        {!!using.length && <p className="studio__using">Using: {using.join(', ')}</p>}
        <form className="studio__ask" onSubmit={(event) => { event.preventDefault(); make(); }}>
          <textarea
            aria-label="What the site is for" rows={2} value={brief}
            placeholder="A waitlist page for Ledgerly: invoicing for small agencies. Button to hello@ledgerly.app"
            onChange={(event) => updateNodeData(id, { brief: event.target.value })}
            onKeyDown={(event) => { if (pressed(event, 'send')) { event.preventDefault(); make(); } }}
          />
          <div className="studio__end">
            <select aria-label="Look" value={look} onChange={(event) => updateNodeData(id, { look: event.target.value as SiteLook })}>
              {SITE_LOOKS.map((one) => <option key={one} value={one}>{SITE_LOOK_NAMES[one]}</option>)}
            </select>
            {making
              ? <button type="button" onClick={() => void stopSite(id)}>Stop</button>
              : <button type="submit" className="primary" disabled={!brief.trim()} title={version ? 'A new version from the brief, beside the others' : ''}>Make</button>}
          </div>
        </form>
        {failed && <p className="msg--problem studio__problem">That did not work: {failed}</p>}
      </div>
    </Frame>
  );
}
