import { useReactFlow, type Node, type NodeProps } from '@xyflow/react';
import { useEffect, useRef, useState } from 'react';
import { DECK_LOOKS, DECK_PURPOSES, EMPTY_DECK, LOOK_NAMES, PURPOSE_NAMES, SHAPE_NAMES, type Deck, type DeckLook, type DeckPurpose } from '../../shared/deck';
import { fileUrl } from '../api';
import { pressed } from '../keys';
import { useElapsed } from '../media';
import { useFlushStage } from '../sync';
import { editDeck, makeDeck, slideUrl, stopDeck, watchDeck } from './deckApi';
import { CardActions, Frame } from './Frame';
import './deck.css';

export type DeckNodeType = Node<{ brief?: string; purpose?: DeckPurpose; look?: DeckLook }, 'deck'>;

// One slide drawn at any width: the slide's own 1280×720 page, scaled to fit, never clickable inside.
function SlideView({ src, title }: { src: string; title: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  useEffect(() => {
    const at = box.current;
    if (!at) return;
    const fit = () => setScale(at.clientWidth / 1280);
    fit();
    const watch = new ResizeObserver(fit);
    watch.observe(at);
    return () => watch.disconnect();
  }, []);
  return (
    <div className="deck__slide" ref={box}>
      {scale > 0 && <iframe src={src} title={title} tabIndex={-1} loading="lazy" sandbox="" style={{ transform: `scale(${scale})` }} />}
    </div>
  );
}

// A deck: a brief and whatever is wired to the card become slides in the product's look, a strip of them to pick
// from, and a PDF. Notes under it remake only the slides they touch, as the next version beside the last.
export function DeckNode({ id, data, selected }: NodeProps<DeckNodeType>) {
  const { updateNodeData, getNodes, getEdges } = useReactFlow();
  const [deck, setDeck] = useState<Deck>(EMPTY_DECK);
  const [hint, setHint] = useState<string | null>(null);
  const [shownVersion, setShownVersion] = useState<number | null>(null);
  const [slide, setSlide] = useState(0);
  const [notes, setNotes] = useState('');
  const [asked, setAsked] = useState(false);
  const [problem, setProblem] = useState('');
  const again = useRef<() => void>(() => {});
  const log = useRef<HTMLDivElement>(null);
  const flushStage = useFlushStage();
  const making = asked || deck.state === 'making';
  const elapsed = useElapsed(making);

  useEffect(() => {
    let watch: ReturnType<typeof watchDeck> | null = null;
    let gone = false;
    // The server must know this card before it will say anything about it.
    void flushStage().then(() => {
      if (gone) return;
      watch = watchDeck(id, (event) => {
        setDeck(event.deck);
        setHint(event.hint ?? null);
        if (event.deck.state !== 'making') setAsked(false);
      });
      again.current = watch.again;
    });
    return () => { gone = true; watch?.stop(); };
  }, [id, flushStage]);

  // The feed is the fast path, not the only one: while a deck is being made the card also asks now and then.
  useEffect(() => {
    if (!making) return;
    const timer = setInterval(() => again.current(), 2000);
    return () => clearInterval(timer);
  }, [making]);
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [deck.log]);

  // A new version is shown the moment it lands, from its first slide.
  const newest = deck.versions.at(-1);
  const seenNewest = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (newest && seenNewest.current !== undefined && newest.version !== seenNewest.current) { setShownVersion(null); setSlide(0); }
    seenNewest.current = newest?.version;
  }, [newest]);
  const version = deck.versions.find((one) => one.version === shownVersion) ?? newest;
  const at = version ? Math.min(slide, version.slides.length - 1) : 0;
  const brief = data.brief ?? '';
  const purpose = data.purpose ?? 'pitch';
  const look = data.look ?? 'clean';

  const act = (job: Promise<unknown>) => { setProblem(''); setAsked(true); job.catch((error: Error) => { setProblem(error.message); setAsked(false); }); };
  const make = () => { if (!making && brief.trim()) act(makeDeck(id, { brief: brief.trim(), purpose, look })); };
  const edit = () => { if (!making && version && notes.trim()) { act(editDeck(id, notes.trim(), version.version)); setNotes(''); } };

  // What this deck is made from, in the founder's words, so nothing in it is a surprise.
  const using = (() => {
    const joined = getEdges().filter((edge) => edge.source === id || edge.target === id).map((edge) => (edge.source === id ? edge.target : edge.source));
    return getNodes().filter((node) => joined.includes(node.id)).flatMap((node) => {
      if (node.type === 'doc') return [String((node.data as { title?: string }).title ?? 'a document')];
      if (node.type === 'note') return ['a note'];
      if (node.type === 'project') return [`${String((node.data as { path?: string }).path ?? '').split('/').filter(Boolean).at(-1) ?? 'a'} project`];
      if (node.type === 'metrics') return ['the Metrics card'];
      return [];
    });
  })();
  const failed = !making && (problem || (deck.state === 'failed' ? deck.problem : ''));

  return (
    <Frame selected={!!selected} minWidth={380} minHeight={520}>
      <header className="card__header card__header--doc">
        <svg className="doc-icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.800" y="3" width="12.400" height="8" rx="1.400" fill="none" stroke="currentColor" strokeWidth="1.2" /><path d="M8 11v2.500M5.500 13.500h5M4.500 6h4M4.500 8.200h2.500" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>
        <div className="card__name">Deck {version && <span>v{version.version}</span>}</div>
        <CardActions id={id} what="this Deck card (its PDFs stay in the shared files)" />
      </header>
      <div className="studio deck nodrag">
        <div className="deck__stage">
          {version && !making && <SlideView key={`${version.version}-${at}`} src={slideUrl(id, version.version, at)} title={`Slide ${at + 1}: ${version.slides[at]?.headline ?? ''}`} />}
          {making && (
            <div className="project__log deck__lines nowheel" ref={log} aria-live="polite">
              {deck.log.length ? deck.log.map((line, index) => <div key={index}>{line}</div>) : <div>starting…</div>}
              <div className="studio__clock">{elapsed}</div>
            </div>
          )}
          {!version && !making && <p className="chat__empty">{hint ?? 'Say what the deck is for and press Make. Wire documents, notes, a project or a Metrics card to it and it is made from them.'}</p>}
        </div>
        {version && !making && (
          <div className="deck__strip nowheel" aria-label="Slides">
            {version.slides.map((one, index) => (
              <button key={one.id} type="button" className={index === at ? 'is-shown' : undefined} aria-label={`Slide ${index + 1}: ${one.headline}`} title={`${SHAPE_NAMES[one.shape]} · ${one.headline}`} onClick={() => setSlide(index)}>
                <SlideView src={slideUrl(id, version.version, index)} title={`Slide ${index + 1}`} />
                <small>{index + 1}</small>
              </button>
            ))}
          </div>
        )}
        {version && !making && version.slides[at]?.notes && <p className="studio__note deck__speaker" title="Speaker notes: never on the slide">{version.slides[at].notes}</p>}
        {version && !making && (
          <div className="studio__done">
            <span className="studio__by">{version.slides.length} slides · {LOOK_NAMES[version.look]}</span>
            <a href={fileUrl(version.pdf)} download>Download PDF</a>
            <a href={fileUrl(version.html)} download title="The slides as one web page, fonts included">HTML</a>
          </div>
        )}
        {deck.versions.length > 1 && !making && (
          <div className="studio__versions nowheel" aria-label="Versions of this deck">
            {deck.versions.map((one) => (
              <button key={one.version} type="button" className={one.version === version?.version ? 'is-shown' : undefined} title={one.said?.join('; ') ?? one.brief}
                onClick={() => { setShownVersion(one.version); setSlide(0); }}>
                <b>v{one.version}</b> {one.notes ?? one.brief ?? 'From the brief'}
              </button>
            ))}
          </div>
        )}
        {version?.said?.length && !making ? <p className="studio__note">{version.said.join('; ')}.</p> : null}
        {version && !making && (
          <form className="studio__notes" onSubmit={(event) => { event.preventDefault(); edit(); }}>
            <textarea
              aria-label="Notes on this deck" rows={1} value={notes}
              placeholder="Merge 2 and 3, drop 5, slide 4: say it for a buyer"
              onChange={(event) => setNotes(event.target.value)}
              onKeyDown={(event) => { if (pressed(event, 'send')) { event.preventDefault(); edit(); } }}
            />
            <button type="submit" disabled={!notes.trim()} title="Only the slides the notes touch are made again. The new version lands beside this one.">Edit</button>
          </form>
        )}
        {!!using.length && <p className="studio__using">Using: {using.join(', ')}</p>}
        <form className="studio__ask" onSubmit={(event) => { event.preventDefault(); make(); }}>
          <textarea
            aria-label="What the deck is for" rows={2} value={brief}
            placeholder="Seed deck, 10 slides: we help agencies… raising $1.5M"
            onChange={(event) => updateNodeData(id, { brief: event.target.value })}
            onKeyDown={(event) => { if (pressed(event, 'send')) { event.preventDefault(); make(); } }}
          />
          <div className="studio__end">
            <select aria-label="What it is for" value={purpose} onChange={(event) => updateNodeData(id, { purpose: event.target.value as DeckPurpose })}>
              {DECK_PURPOSES.map((one) => <option key={one} value={one}>{PURPOSE_NAMES[one]}</option>)}
            </select>
            <select aria-label="Look" value={look} onChange={(event) => updateNodeData(id, { look: event.target.value as DeckLook })}>
              {DECK_LOOKS.map((one) => <option key={one} value={one}>{LOOK_NAMES[one]}</option>)}
            </select>
            {making
              ? <button type="button" onClick={() => void stopDeck(id)}>Stop</button>
              : <button type="submit" className="primary" disabled={!brief.trim() || !!hint} title={hint ?? (version ? 'A new version from the brief, beside the others' : '')}>Make</button>}
          </div>
        </form>
        {failed && <p className="msg--problem studio__problem">That did not work: {failed}</p>}
      </div>
    </Frame>
  );
}
