import { useReactFlow, type Node, type NodeProps } from '@xyflow/react';
import { useEffect, useRef, useState } from 'react';
import { agoText, hostOf, localDay, samePage, siteUrl, suggestedPages, type ChangeRow, type CompetitorView } from '../../shared/competitor';
import { fileUrl } from '../api';
import { useAttempt } from '../attempt';
import { useFlushStage } from '../sync';
import { crawlCompetitor, followCompetitor, stopCompetitorPage, watchCompetitorPage } from './competitorApi';
import { CardActions, Frame } from './Frame';
import './competitor.css';

export type CompetitorNodeType = Node<{ name: string; url: string; pages?: string[] }, 'competitor'>;

const shortDay = (at: number) => new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const pathOf = (url: string) => { try { const { pathname, search } = new URL(url); return `${pathname}${search}`; } catch { return url; } };

// One change: the day and the page, the lines that changed, and under them what the wired person made of it.
function Change({ change, person }: { change: ChangeRow; person: string | null }) {
  return (
    <li className="rival__change">
      <div className="rival__when"><time dateTime={localDay(change.at)}>{shortDay(change.at)}</time><span>{change.label}</span></div>
      <p className="rival__phrase">{change.phrase}</p>
      {change.lines.length > 1 && (
        <ul className="rival__lines" aria-label="Changed lines">
          {change.lines.map((line, index) => (
            <li key={index} className={line.startsWith('+ ') ? 'is-added' : /^[−-] /.test(line) ? 'is-gone' : 'is-more'}>{line}</li>
          ))}
        </ul>
      )}
      {change.note
        ? <p className="rival__note"><b>{change.note.by}</b>{change.note.text}</p>
        : person && <p className="rival__note is-waiting">{person} is reading it…</p>}
    </li>
  );
}

// A rival on the stage: their pages being watched, what changed on them, and a whole-site read on demand. The watches
// are the same ones a person starts with watch_page; this card only lists the ones for this rival's pages.
export function CompetitorNode({ id, data, selected }: NodeProps<CompetitorNodeType>) {
  const { updateNodeData } = useReactFlow();
  const flushStage = useFlushStage();
  const [view, setView] = useState<CompetitorView | null>(null);
  const [site, setSite] = useState(data.url ?? '');
  const [extra, setExtra] = useState('');
  const [busy, setBusy] = useState<string[]>([]);
  const [crawling, setCrawling] = useState(false);
  const [icon, setIcon] = useState('');
  const { problem, setProblem, attempt } = useAttempt();
  const follow = useRef<{ again(): void } | null>(null);
  const url = siteUrl(data.url);
  const host = hostOf(data.url);
  const pages = data.pages ?? [];

  useEffect(() => {
    let stop = () => {};
    let gone = false;
    // The server must know this card before it will say anything about it.
    void flushStage().then(() => {
      if (gone) return;
      const followed = followCompetitor(id, setView);
      follow.current = followed;
      stop = followed.stop;
    });
    return () => { gone = true; stop(); follow.current = null; };
  }, [id, flushStage]);
  useEffect(() => { setSite(data.url ?? ''); }, [data.url]);

  // The card's own words reach the saved stage before the server is asked about them.
  const saved = async () => { await new Promise((settle) => setTimeout(settle, 0)); await flushStage(); };
  const refresh = () => follow.current?.again();

  function setUrl(raw: string) {
    if (!raw.trim()) { updateNodeData(id, { url: '' }); return; }
    const whole = siteUrl(raw);
    if (!whole) { setProblem('That is not a web address. Try acme.com.'); return; }
    setProblem('');
    if (whole !== data.url) updateNodeData(id, { url: whole });
  }
  // Watching a page puts it on the card's list first, so the card remembers it even when the first read fails.
  function watch(raw: string) {
    const page = siteUrl(raw.startsWith('/') && url ? new URL(raw, url).href : raw);
    if (!page) { setProblem('Give a page\'s address, like /careers or acme.com/careers.'); return; }
    if (!pages.some((one) => samePage(one, page))) updateNodeData(id, { pages: [...pages, page] });
    setBusy((now) => [...now, page]);
    attempt(saved().then(() => watchCompetitorPage(id, page)).then(() => setExtra('')).finally(() => { setBusy((now) => now.filter((one) => one !== page)); refresh(); }));
  }
  function unwatch(page: string) {
    updateNodeData(id, { pages: pages.filter((one) => !samePage(one, page)) });
    attempt(saved().then(() => stopCompetitorPage(id, page)).finally(refresh));
  }
  function crawl() {
    setCrawling(true);
    attempt(saved().then(() => crawlCompetitor(id)).finally(() => { setCrawling(false); refresh(); }));
  }

  // The pages the card lists, then the three every rival has that are not listed yet.
  const listed = view?.pages ?? pages.map((page) => ({ url: page, label: '', watch: undefined }));
  const offered = suggestedPages(data.url ?? '').filter((one) => !listed.some((page) => samePage(page.url, one.url)));
  const rows = [...listed.map((page) => ({ ...page, suggested: false })), ...offered.map((page) => ({ ...page, watch: undefined, suggested: true }))];
  const now = Date.now();
  const month = localDay(now).slice(0, 7);
  const thisMonth = view?.changes.filter((change) => localDay(change.at).startsWith(month)).length ?? 0;

  return (
    <Frame selected={!!selected} minWidth={360} minHeight={380}>
      <header className="card__header card__header--doc">
        {/* Only the site's name goes out, to fetch its small icon; until it arrives, or when a site has none, a flag. */}
        <span className="source__icon" aria-hidden="true">
          {icon !== host && <svg viewBox="0 0 16 16"><path d="M3.500 14V2.500M3.500 3h8.300l-1.600 2.800 1.600 2.800H3.500" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg>}
          {host && <img key={host} src={`https://icons.duckduckgo.com/ip3/${host}.ico`} alt="" draggable={false} hidden={icon !== host} onLoad={() => setIcon(host)} onError={() => setIcon('')} />}
        </span>
        <input className="card__title-input nodrag" aria-label="Competitor name" placeholder="Competitor" value={data.name ?? ''} onChange={(event) => updateNodeData(id, { name: event.target.value })} />
        {host && <a className="rival__host nodrag" href={url ?? undefined} target="_blank" rel="noreferrer" title="Open in your browser">{host}</a>}
        <span className="rival__gap" />
        <CardActions id={id} what="this Competitor card (its watched pages keep being read until you stop them)" />
      </header>
      <div className="rival nodrag nowheel">
        <form className="rival__site" onSubmit={(event) => { event.preventDefault(); setUrl(site); }}>
          <input aria-label="Their website" placeholder="Their website, like acme.com, then Enter" spellCheck={false} value={site}
            onChange={(event) => setSite(event.target.value)} onBlur={() => { if (site.trim() !== (data.url ?? '')) setUrl(site); }} />
        </form>

        {url && (
          <div className="rival__status">
            {view?.lastRead
              ? <span className={view.overdue ? 'rival__read is-overdue' : 'rival__read'} title={view.overdue ? 'Pages are read every 6 hours, only while the app is open. Changes since then are not seen yet.' : 'Pages are read every 6 hours while the app is open.'}>
                  Last read {agoText(view.lastRead, now)}
                </span>
              : <span className="rival__read">No page read yet</span>}
            {view?.crawl && <a className="rival__crawl-file" href={fileUrl(view.crawl.file)} target="_blank" rel="noreferrer" title={view.crawl.file}>Site read {shortDay(new Date(`${view.crawl.day}T12:00:00`).getTime())} · {view.crawl.pages} pages</a>}
            <button type="button" className="rival__crawl" disabled={crawling} onClick={crawl}>{crawling ? 'Reading the site…' : 'Crawl now'}</button>
          </div>
        )}

        {url && (
          <section className="rival__pages" aria-label="Watched pages">
            <h3>Pages</h3>
            <ul>
              {rows.map((page) => {
                const waiting = busy.some((one) => samePage(one, page.url));
                return (
                  <li key={page.url} className={`rival__page${page.watch ? ' is-watched' : ''}${page.suggested ? ' is-suggested' : ''}`}>
                    <span className="rival__label">{page.label || pathOf(page.url)}</span>
                    <span className="rival__path" title={page.url}>{pathOf(page.url)}</span>
                    {page.watch
                      ? <>
                          <span className={`rival__seen${page.watch.fails ? ' is-failing' : ''}`} title={page.watch.fails ? `The last ${page.watch.fails} reads failed: ${page.watch.lastFail}` : `Watched by ${page.watch.owner}`}>
                            {page.watch.fails ? 'cannot read' : page.watch.readAt ? agoText(page.watch.readAt, now) : 'watching'}
                          </span>
                          <button type="button" className="rival__stop" aria-label={`Stop watching ${page.label}`} title="Stop watching" onClick={() => unwatch(page.url)}>
                            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.500 4.500l7 7M11.500 4.500l-7 7" /></svg>
                          </button>
                        </>
                      : <button type="button" className="rival__watch" disabled={waiting} aria-label={`Watch ${page.label || pathOf(page.url)}`} onClick={() => watch(page.url)}>{waiting ? 'Reading…' : 'Watch'}</button>}
                  </li>
                );
              })}
            </ul>
            <form className="rival__add" onSubmit={(event) => { event.preventDefault(); if (extra.trim()) watch(extra.trim()); }}>
              <input aria-label="Another page to watch" placeholder="Another page: /careers, /blog…" spellCheck={false} value={extra} onChange={(event) => setExtra(event.target.value)} />
            </form>
          </section>
        )}

        {problem && <p className="rival__problem" role="alert">{problem}</p>}

        {url ? (
          <section className="rival__changes" aria-label="Changes">
            <h3>Changes {thisMonth > 0 && <span>{thisMonth} this month</span>}</h3>
            {view && view.changes.length
              ? <ol className="rival__timeline">{view.changes.map((change) => <Change key={change.id} change={change} person={view.person} />)}</ol>
              : <p className="rival__quiet">No change seen yet. Watched pages are read every 6 hours while the app is open.</p>}
            {view && !view.person && view.changes.length > 0 && <p className="rival__quiet">Wire a person to this card to hear what each change means.</p>}
          </section>
        ) : (
          <p className="rival__teach">Name a rival and give their website. Then watch their home, pricing and changelog pages, and see every change here.</p>
        )}
      </div>
    </Frame>
  );
}
