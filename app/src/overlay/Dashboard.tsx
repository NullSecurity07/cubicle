import { useJumpTo } from '../flow';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { backupLate, type DashMedia, type DashNeed, type DashTask, type DashTeam, type Dashboard as Board } from '../../shared/dashboard';
import { LEAD_STAGES, STAGE_NAMES } from '../../shared/leads';
import type { TodayItem } from '../../shared/today';
import { fileUrl, getDashboard, watchDashboard } from '../api';
import { emit } from '../bus';
import { openFrameworks, useFrameworks, usePlaceFramework } from '../frameworks';
import { BlocksIcon } from '../nodes/FrameworksPanel';
import { since, WHAT } from './attention';
import { compact } from '../numbers';
import { providerLine } from './providerLine';
import { overlay, showDecision, showPlaybook } from './store';
import './dashboard.css';
import { PanelShell } from './PanelShell';
import { firstPlace } from './firstPlace';
import { TodayFive } from './TodayFive';

// The founder's one screen: what today holds, what the work has cost, how the teams are doing and what was made.
// Nothing here is kept by the dashboard. Every row is a door to the place it came from, and going through one closes
// this view, so the founder lands where the thing is rather than on a copy of it.

const SECTIONS = [
  { id: 'today', label: 'Today' },
  { id: 'tokens', label: 'Tokens and health' },
  { id: 'teams', label: 'Teams' },
  { id: 'made', label: 'Made this week' },
] as const;
type SectionId = (typeof SECTIONS)[number]['id'];

const until = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
// A plan's step has a day and no time: today's says so, an earlier day's says it is still open.
const planned = (day: string) => {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return day >= today ? 'Planned for today' : `Planned for ${new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}, not done yet`;
};
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const KIND_WORD: Record<DashMedia['kind'], string> = { picture: 'Picture', voice: 'Voice', film: 'Film' };

const Chevron = () => <svg className="dash__chev" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.500 2.500L8 6l-3.500 3.500" /></svg>;

// One row that goes somewhere. The whole row is the button: the founder never has to aim at a small link.
function Row({ tone, title, meta, onGo, label }: { tone?: 'needs' | 'run' | 'calm'; title: ReactNode; meta?: ReactNode; onGo: () => void; label?: string }) {
  return (
    <li>
      <button type="button" className={`dash__row${tone ? ` dash__row--${tone}` : ''}`} onClick={onGo} aria-label={label}>
        {tone && <span className="dash__dot" aria-hidden="true" />}
        <span className="dash__text"><b>{title}</b>{meta && <small>{meta}</small>}</span>
        <Chevron />
      </button>
    </li>
  );
}

function Group({ title, count, children, empty }: { title: string; count?: number; children: ReactNode; empty?: string }) {
  return (
    <div className="dash__group">
      <h4>{title}{count !== undefined && count > 0 && <span>{count}</span>}</h4>
      {empty ? <p className="dash__empty">{empty}</p> : <ul className="dash__rows">{children}</ul>}
    </div>
  );
}

// Fourteen days of tokens, today on the right and in the accent. Plain SVG, drawn at the width it is given so the
// bars keep their shape at any window size: a bar a day, a hairline under them, the first day and today named.
function Chart({ days }: { days: Board['tokens']['byDay'] }) {
  const box = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(560);
  useEffect(() => {
    if (!box.current) return;
    const seen = new ResizeObserver(([entry]) => setWidth(Math.max(200, Math.round(entry.contentRect.width))));
    seen.observe(box.current);
    return () => seen.disconnect();
  }, []);
  const most = Math.max(1, ...days.map((one) => one.tokens));
  const [height, gap] = [132, width < 480 ? 5 : 8];
  const bar = (width - gap * (days.length - 1)) / days.length;
  const label = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return (
    <figure className="dash__chart" ref={box}>
      <svg width={width} height={height + 1} viewBox={`0 0 ${width} ${height + 1}`} role="img" aria-label={`Tokens a day for the last ${days.length} days`}>
        {days.map((one, index) => {
          const tall = one.tokens ? Math.max(3, (one.tokens / most) * (height - 6)) : 0;
          const x = index * (bar + gap);
          return (
            <g key={one.day}>
              <title>{`${label(one.day)}: ${one.tokens.toLocaleString()} tokens`}</title>
              <rect x={x} y={0} width={bar} height={height} className="dash__hit" />
              {tall > 0 && <rect x={x} y={height - tall} width={bar} height={tall} rx={Math.min(5, bar / 4)} className={index === days.length - 1 ? 'dash__bar is-today' : 'dash__bar'} />}
            </g>
          );
        })}
        <line x1="0" x2={width} y1={height + 0.5} y2={height + 0.5} className="dash__axis" />
      </svg>
      <figcaption><span>{label(days[0].day)}</span><span>Today</span></figcaption>
    </figure>
  );
}

function Tile({ one }: { one: DashMedia }) {
  const picture = one.kind === 'picture' ? one.file : one.poster;
  return (
    <li className="dash__tile">
      <a href={fileUrl(one.file)} target="_blank" rel="noreferrer" aria-label={`${KIND_WORD[one.kind]}: ${one.title}`}>
        <span className={`dash__thumb dash__thumb--${one.kind}`}>
          {picture && <img src={fileUrl(picture)} alt="" loading="lazy" draggable={false} />}
          {one.kind !== 'picture' && (
            <span className="dash__play" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M5.500 3.800v8.400L12.200 8z" /></svg></span>
          )}
          {one.kind === 'voice' && <span className="dash__wave" aria-hidden="true">{[5, 9, 14, 8, 12, 6, 10, 4].map((tall, index) => <i key={index} style={{ height: `${tall * 2}px` }} />)}</span>}
        </span>
        <span className="dash__caption">
          <b>{one.title}</b>
          <small>{KIND_WORD[one.kind]} · {since(one.at)}{one.nonCommercial && <em className="dash__nc">Non-commercial</em>}</small>
        </span>
      </a>
      {(one.credits || one.creditsFile) && (
        <p className="dash__credits">{one.credits}{one.creditsFile && <> <a href={fileUrl(one.creditsFile)} target="_blank" rel="noreferrer">Credits</a></>}</p>
      )}
    </li>
  );
}

export function Dashboard() {
  const [board, setBoard] = useState<Board | null>(null);
  const [problem, setProblem] = useState('');
  const [shown, setShown] = useState<SectionId>('today');
  const [busy, setBusy] = useState('');
  const [five, setFive] = useState<TodayItem[] | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const frameworks = useFrameworks();
  const place = usePlaceFramework();

  // Read once on opening, and again whenever the server says something under the dashboard moved.
  useEffect(() => {
    let live = true;
    const load = () => { getDashboard().then((next) => { if (live) { setBoard(next); setProblem(''); } }).catch((error: Error) => { if (live) setProblem(error.message); }); };
    load();
    const stop = watchDashboard(load);
    return () => { live = false; stop(); };
  }, []);

  // The rail follows the reading: the section nearest the top of the view is the one it marks.
  useEffect(() => {
    const root = scroller.current;
    if (!root || !board) return;
    const onScroll = () => {
      const top = root.getBoundingClientRect().top;
      let current: SectionId = 'today';
      for (const section of SECTIONS) {
        const element = root.querySelector(`#dash-${section.id}`);
        if (element && element.getBoundingClientRect().top - top < 120) current = section.id;
      }
      if (root.scrollTop + root.clientHeight >= root.scrollHeight - 4) current = SECTIONS.at(-1)!.id;
      setShown(current);
    };
    root.addEventListener('scroll', onScroll, { passive: true });
    return () => root.removeEventListener('scroll', onScroll);
  }, [board]);

  const close = () => overlay.close({ kind: 'panel', name: 'dashboard' });
  const jumpTo = useJumpTo();
  const jump = (id: string) => { close(); jumpTo(id); };
  const room = (id: string) => { close(); overlay.open({ kind: 'focus', id }); };
  const panel = (name: string) => { close(); overlay.open({ kind: 'panel', name }); };
  const decision = (id: string) => { close(); showDecision(id); overlay.open({ kind: 'panel', name: 'decisions' }); };
  const memory = (roomId: string) => { room(roomId); emit('memory', { roomId }); };
  const skill = (id: string) => { close(); showPlaybook({ skill: id }); overlay.open({ kind: 'panel', name: 'playbook' }); };
  // Where a thing that waits for the founder lives: the decision it asks about, the person who asked, the card it is
  // on; and when it has none of those (a website suggested), the needs-you list where it can be answered.
  const need = (one: DashNeed) => (one.decisionId ? decision(one.decisionId) : one.roomId && (one.kind === 'approval' || !one.cardId) ? room(one.roomId) : one.cardId ? jump(one.cardId) : panel('needs'));
  const task = (one: DashTask) => jump(one.cardId);
  const go = (id: SectionId) => { scroller.current?.querySelector(`#dash-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); setShown(id); };

  async function team(one: DashTeam) {
    if (one.placedRoomId) return jump(one.placedRoomId);
    const framework = frameworks.find((held) => held.id === one.id);
    if (!framework) return openFrameworks();
    setBusy(one.id);
    try { await place(framework, close); } catch (error) { setProblem((error as Error).message); } finally { setBusy(''); }
  }

  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  const day = board?.day;
  // What each list below Today's five still has to say: a thing shows once, in the first section it belongs to.
  const rest = day ? firstPlace(five, day) : null;
  const above = (all: number, left: number, none: string) => (left ? undefined : all ? "Already in Today's five." : none);
  const tokens = board?.tokens;
  const week = tokens ? tokens.byDay.slice(-7).reduce((sum, one) => sum + one.tokens, 0) : 0;
  const leads = day ? LEAD_STAGES.reduce((sum, stage) => sum + day.leadsByStage[stage], 0) : 0;
  const badge: Record<SectionId, string> = {
    today: day?.needsYou.length ? String(day.needsYou.length) : '',
    tokens: board && board.health.some((one) => !one.ok) ? '!' : '',
    teams: '', made: board?.media.length ? String(board.media.length) : '',
  };

  return (
    <PanelShell name="dashboard" title="Dashboard" note={today} side className="dash" onClose={close}>
      <div className="dash__frame">
        <nav className="dash__rail" aria-label="Sections">
          {SECTIONS.map((section) => (
            <button key={section.id} type="button" aria-current={shown === section.id ? 'true' : undefined} onClick={() => go(section.id)}>
              <span>{section.label}</span>
              {badge[section.id] && <i className={section.id === 'today' || section.id === 'tokens' ? 'is-needs' : undefined}>{badge[section.id]}</i>}
            </button>
          ))}
        </nav>
        <div className="dash__scroll" ref={scroller}>
          {problem && <p className="msg--problem">{problem}</p>}
          {!board && !problem && <p className="dash__loading">Reading your day…</p>}
          {board && day && rest && tokens && <>
            <section id="dash-today" className="dash__section" aria-labelledby="dash-today-title">
              <h3 id="dash-today-title">Today</h3>
              <TodayFive stamp={board.at} onItems={setFive} />
              <div className="dash__stats">
                <button type="button" className={`dash__stat${day.needsYou.length ? ' is-needs' : ''}`} onClick={() => panel('needs')}><b>{day.needsYou.length}</b><span>Need you</span></button>
                <div className="dash__stat"><b>{day.tasksDue.length}</b><span>Due today</span></div>
                <div className="dash__stat"><b>{day.tasksRunning.length}</b><span>Running</span></div>
                <button type="button" className="dash__stat" onClick={() => panel('messages')}><b>{day.unreadMessages}</b><span>{day.unreadMessages === 1 ? 'Reply to read' : 'Replies to read'}</span></button>
              </div>

              <Group title="Needs you" count={rest.needsYou.length} empty={above(day.needsYou.length, rest.needsYou.length, 'Nothing is waiting for you.')}>
                {rest.needsYou.slice(0, 8).map((one) => <Row key={one.id} tone="needs" title={one.title} meta={`${one.who ? `${one.who} ${WHAT[one.kind]}` : WHAT[one.kind]} · ${since(one.at)}`} onGo={() => need(one)} />)}
                {rest.needsYou.length > 8 && <Row title={`${rest.needsYou.length - 8} more`} meta="Open the needs-you list" onGo={() => panel('needs')} />}
              </Group>

              <Group title="Tasks" count={rest.tasksDue.length + rest.tasksRunning.length} empty={above(day.tasksDue.length + day.tasksRunning.length, rest.tasksDue.length + rest.tasksRunning.length, 'No task is running or due today.')}>
                {rest.tasksRunning.map((one) => <Row key={one.id} tone="run" title={one.title} meta={`${one.state === 'waiting' ? 'Waiting for your OK' : 'Running'}${one.who ? ` · ${one.who}` : ''} · started ${since(one.at)}`} onGo={() => task(one)} />)}
                {rest.tasksDue.map((one) => <Row key={one.id} tone="calm" title={one.title} meta={`${one.missed ? 'Missed while the app was closed' : one.day ? planned(one.day) : `Due at ${until(one.at)}`}${one.who ? ` · ${one.who}` : ''}`} onGo={() => task(one)} />)}
              </Group>

              <div className="dash__pair">
                <Group title="Pages that changed" count={day.watchesChanged.length} empty={day.watchesChanged.length ? undefined : 'No watched page has changed.'}>
                  {day.watchesChanged.slice(0, 5).map((one) => <Row key={`${one.roomId}-${one.id}`} title={one.title} meta={`${one.diff ?? one.url} · ${since(one.at)}`} onGo={() => room(one.roomId)} />)}
                </Group>
                <Group title="Decisions to make" count={rest.decisionsPending.length} empty={above(day.decisionsPending.length, rest.decisionsPending.length, 'No decision is waiting on you.')}>
                  {rest.decisionsPending.slice(0, 5).map((one) => <Row key={one.id} title={one.title} meta={`${one.who ? `${one.who} · ` : ''}${since(one.at)}`} onGo={() => decision(one.id)} />)}
                </Group>
              </div>

              {day.replies.length > 0 && (
                <Group title="Replies to read" count={day.replies.length}>
                  {day.replies.slice(0, 5).map((one) => <Row key={one.roomId} title={one.name} meta={`Answered ${since(one.at)}`} onGo={() => room(one.roomId)} />)}
                </Group>
              )}

              <div className="dash__group">
                <h4>Leads{day.leadsChangedToday > 0 && <span>{plural(day.leadsChangedToday, 'changed today', 'changed today')}</span>}</h4>
                {leads === 0 ? <p className="dash__empty">{day.leadsCardId ? 'Your leads card is empty.' : 'Add a leads card to see your pipeline here.'}</p> : (
                  <ol className="dash__leads" aria-label="Leads by stage">
                    {LEAD_STAGES.map((stage) => (
                      <li key={stage}>
                        <button type="button" className={day.leadsByStage[stage] ? undefined : 'is-none'} onClick={() => day.leadsCardId && jump(day.leadsCardId)} aria-label={`${STAGE_NAMES[stage]}: ${day.leadsByStage[stage]}`}>
                          <b>{day.leadsByStage[stage]}</b><span>{STAGE_NAMES[stage]}</span>
                        </button>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </section>

            <section id="dash-tokens" className="dash__section" aria-labelledby="dash-tokens-title">
              <div className="dash__head"><h3 id="dash-tokens-title">Tokens and health</h3><button type="button" className="dash__link" onClick={() => panel('insights')}>Insights</button></div>
              <div className="dash__headline"><b>{compact(week)}</b><span>tokens in the last 7 days</span></div>
              <Chart days={tokens.byDay} />

              <Group title="Providers today" empty={tokens.byProvider.length ? undefined : 'No model is set up yet.'}>
                {tokens.byProvider.map((one) => (
                  <li key={one.name} className="dash__provider">
                    <div className="dash__provider-head">
                      <b>{one.name}<small>{one.model}</small></b>
                      <span>{one.limits.rpd || one.limits.tpd ? `${one.leftPct}% left` : 'No daily limit'}</span>
                    </div>
                    {(one.limits.rpd || one.limits.tpd) ? (
                      <div className={`dash__meter${one.leftPct <= 5 ? ' is-out' : one.leftPct < 20 ? ' is-low' : ''}`} role="meter" aria-label={`${one.name}: ${one.leftPct}% left`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={one.leftPct}><i style={{ width: `${one.leftPct}%` }} /></div>
                    ) : null}
                    <small>{providerLine(one)}</small>
                  </li>
                ))}
              </Group>

              <div className="dash__pair">
                <div className="dash__group">
                  <h4>People, 7 days</h4>
                  {tokens.byPerson.length ? (
                    <table className="dash__table">
                      <thead><tr><th scope="col">Person</th><th scope="col">Turns</th><th scope="col">Tokens</th></tr></thead>
                      <tbody>{tokens.byPerson.map((one) => (
                        <tr key={one.name} className={one.roomId ? 'is-link' : undefined} onClick={() => one.roomId && room(one.roomId)}>
                          <th scope="row">{one.roomId ? <button type="button" onClick={(event) => { event.stopPropagation(); room(one.roomId!); }}>{one.name}</button> : one.name}</th><td>{one.turns7d}</td><td>{compact(one.tokens7d)}</td>
                        </tr>
                      ))}</tbody>
                    </table>
                  ) : <p className="dash__empty">Nobody has worked this week.</p>}
                </div>
                <div className="dash__group">
                  <h4>Tools, 7 days</h4>
                  {tokens.byTool.length ? (
                    <table className="dash__table">
                      <thead><tr><th scope="col">Tool</th><th scope="col">Calls</th><th scope="col" title="What the turns that used it came to, shared between the tools they called">Tokens</th></tr></thead>
                      <tbody>{tokens.byTool.map((one) => <tr key={one.name}><th scope="row">{one.name.replace(/_/g, ' ')}</th><td>{one.calls7d}</td><td>{compact(one.tokens7d)}</td></tr>)}</tbody>
                    </table>
                  ) : <p className="dash__empty">No tool was used this week.</p>}
                </div>
              </div>

              <div className="dash__group">
                <div className="dash__head"><h4>Health</h4><button type="button" className="dash__link" onClick={() => panel('health')}>Open Health</button></div>
                {board.backup && (
                  <p className={`dash__backup${backupLate(board.backup, Date.now()) ? ' is-late' : ''}`} title={board.backup.dir}>
                    {board.backup.at ? `Last backup ${new Date(board.backup.at).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : 'Nothing backed up yet'}
                    <span> · {board.backup.writable === false ? `cannot write to ${board.backup.dir}` : `to ${board.backup.dir}`}</span>
                  </p>
                )}
                {board.health.length ? (
                  <ul className="dash__health">
                    {board.health.map((one) => (
                      <li key={one.name} className={one.ok ? (one.warn ? 'is-warn' : undefined) : 'is-bad'}>
                        <span className="dash__mark" aria-label={one.ok ? (one.warn ? 'Worth a look' : 'Working') : 'Not working'}>{one.ok ? (one.warn ? '!' : '✓') : '✗'}</span>
                        {/* What is so, then where (a folder) on its own line, cut short if it must be: the sentence stays whole. */}
                        <span className="dash__text"><b>{one.name}</b><small>{one.detail.split('\n')[0]}</small>{one.detail.split('\n').slice(1).map((line, index) => <small key={index} className="dash__where" title={line}>{line}</small>)}</span>
                      </li>
                    ))}
                  </ul>
                ) : <p className="dash__empty">Checking what is working…</p>}
              </div>
            </section>

            <section id="dash-teams" className="dash__section" aria-labelledby="dash-teams-title">
              <div className="dash__head"><h3 id="dash-teams-title">Teams</h3><button type="button" className="dash__link" onClick={() => panel('frameworks')}>All frameworks</button></div>
              {board.teams.length ? (
                <ul className="dash__teams">
                  {board.teams.map((one) => (
                    <li key={one.id} className="dash__team">
                      <span className="dash__team-icon"><BlocksIcon /></span>
                      <span className="dash__text">
                        <b>{one.name}<em>{one.builtIn ? 'Built in' : 'Yours'}</em></b>
                        <small>
                          {one.placed ? 'On the stage' : 'Not placed'}
                          {' · '}
                          {one.lastEval ? <>Scored {one.lastEval.mean.toFixed(2)}, judged {one.lastEval.judged} of {one.lastEval.of} · {since(one.lastEval.at)}</> : 'Not measured yet'}
                        </small>
                      </span>
                      <button type="button" className={one.placed ? 'dash__act' : 'dash__act primary'} disabled={busy === one.id} onClick={() => void team(one)}>{one.placed ? 'Open' : busy === one.id ? 'Placing…' : 'Place'}</button>
                    </li>
                  ))}
                </ul>
              ) : <p className="dash__empty">No team is saved yet. Forge one from your notes in Frameworks.</p>}

              <div className="dash__pair">
                <div className="dash__group">
                  <h4>Skills used this week<span>{plural(board.skills.count, 'in the playbook', 'in the playbook')}</span></h4>
                  {board.skills.usedThisWeek.length ? (
                    <ul className="dash__chips">
                      {board.skills.usedThisWeek.map((one) => <li key={one.id}><button type="button" onClick={() => skill(one.id)}>{one.name}<i>{one.uses}</i></button></li>)}
                    </ul>
                  ) : <p className="dash__empty">No skill was used this week.</p>}
                </div>
                <div className="dash__group">
                  <h4>Kept on their own<span>{board.skills.keptOnItsOwn ? plural(board.skills.keptOnItsOwn, 'line') : ''}</span></h4>
                  {board.skills.keptBy.length ? (
                    <ul className="dash__rows">
                      {board.skills.keptBy.map((one) => <Row key={one.roomId} title={one.name} meta={`${plural(one.count, 'line')} kept without being asked · Open their memory`} onGo={() => memory(one.roomId)} />)}
                    </ul>
                  ) : <p className="dash__empty">Nobody has kept a note unasked.</p>}
                </div>
              </div>
            </section>

            <section id="dash-made" className="dash__section" aria-labelledby="dash-made-title">
              <h3 id="dash-made-title">Made this week</h3>
              {board.media.length ? <ul className="dash__tiles">{board.media.map((one) => <Tile key={`${one.cardId}-${one.file}`} one={one} />)}</ul>
                : <p className="dash__empty">Nothing was made this week. The image, voice and video studios keep what they make here.</p>}
            </section>
          </>}
        </div>
      </div>
    </PanelShell>
  );
}
