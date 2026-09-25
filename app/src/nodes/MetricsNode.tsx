import { useReactFlow, type Node, type NodeProps } from '@xyflow/react';
import { useEffect, useRef, useState, type DragEvent } from 'react';
import { delta, formatChange, formatPct, formatValue, localDay, northStarOf, pace, series, SPARK, type Metric, type MetricPoint, type Metrics, type Period, type Unit } from '../../shared/metrics';
import { useFlushStage } from '../sync';
import { CardActions, Frame } from './Frame';
import { changeMetric, importMetrics, logMetric, removeMetric, watchMetrics } from './metricsApi';
import './metrics.css';

export type MetricsNodeType = Node<{ title?: string; period?: Period }, 'metrics'>;

const NEW = '__new';
const FILE = /\.(csv|tsv|txt|json)$/i;
const shortDay = (at: string) => new Date(`${at}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const longDay = (at: string) => new Date(`${at}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
// Whether a move is good news, by the number's own idea of better.
const tone = (metric: Metric, change?: number) => (!change ? 'flat' : (change > 0) === (metric.better === 'up') ? 'good' : 'bad');

// A line of the last dozen periods, drawn in plain SVG. Hovering shows each point's day, value and where it came from.
function Spark({ points, unit, label, big = false }: { points: MetricPoint[]; unit?: Unit; label: string; big?: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const shown = points.slice(-SPARK);
  if (shown.length < 2) return <div className={`spark spark--empty${big ? ' spark--big' : ''}`} aria-hidden="true" />;
  const values = shown.map((point) => point.value);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = high - low || 1;
  const x = (index: number) => (index / (shown.length - 1)) * 100;
  const y = (value: number) => 92 - ((value - low) / span) * 84;
  const line = shown.map((point, index) => `${index ? 'L' : 'M'}${x(index).toFixed(2)},${y(point.value).toFixed(2)}`).join(' ');
  const on = hover === null ? null : shown[hover];
  return (
    <div className={`spark${big ? ' spark--big' : ''}`} role="img" aria-label={`${label}: ${shown.map((point) => `${shortDay(point.at)} ${formatValue(point.value, unit)}`).join(', ')}`}
      onMouseMove={(event) => { const box = event.currentTarget.getBoundingClientRect(); setHover(Math.round(((event.clientX - box.left) / box.width) * (shown.length - 1))); }}
      onMouseLeave={() => setHover(null)}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        {big && <path className="spark__area" d={`${line} L100,100 L0,100 Z`} />}
        <path className="spark__line" d={line} vectorEffect="non-scaling-stroke" />
      </svg>
      <span className="spark__dot" style={{ left: `${x(shown.length - 1)}%`, top: `${y(shown.at(-1)!.value)}%` }} />
      {on && hover !== null && <>
        <span className="spark__dot spark__dot--hover" style={{ left: `${x(hover)}%`, top: `${y(on.value)}%` }} />
        <span className={`spark__tip${hover > shown.length / 2 ? ' is-left' : ''}`} role="tooltip" style={{ left: `${x(hover)}%` }}>
          <b>{formatValue(on.value, unit)}</b> {longDay(on.at)}<small>{on.from === 'founder, typed' ? 'You typed it' : on.from}</small>
        </span>
      </>}
    </div>
  );
}

// The founder's numbers: one north star, large, with how it moved and a line of the last dozen periods; up to six
// more beneath it. Paste a table, drop a file, or type today's value. Every sum is the server's, in TypeScript.
export function MetricsNode({ id, data, selected }: NodeProps<MetricsNodeType>) {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState('');
  const [said, setSaid] = useState<{ text: string; skipped: string[] } | null>(null);
  const [problem, setProblem] = useState('');
  const [over, setOver] = useState(false);
  const [which, setWhich] = useState('');
  const [newName, setNewName] = useState('');
  const [value, setValue] = useState('');
  const [aiming, setAiming] = useState(false);
  const [aim, setAim] = useState({ value: '', by: '' });
  const [removing, setRemoving] = useState('');
  const { updateNodeData } = useReactFlow();
  const flushStage = useFlushStage();
  const pasteBox = useRef<HTMLTextAreaElement>(null);
  const period: Period = data.period === 'month' ? 'month' : 'week';

  useEffect(() => {
    let stop = () => {};
    let gone = false;
    void flushStage().then(() => { if (!gone) stop = watchMetrics(id, (event) => setMetrics(event.data)); });
    return () => { gone = true; stop(); };
  }, [id, flushStage]);
  useEffect(() => { if (pasting) pasteBox.current?.focus(); }, [pasting]);

  const all = metrics?.metrics ?? [];
  const star = northStarOf(all);
  const rest = all.filter((metric) => metric !== star).slice(0, 6);
  const empty = !all.some((metric) => metric.points.length);
  const chosen = which || star?.key || NEW;
  const act = (job: Promise<unknown>) => { setProblem(''); job.catch((error: Error) => setProblem(error.message)); };

  function read(text: string, name: string) {
    const from = name === 'pasted' ? 'the pasted table' : name;
    act(importMetrics(id, text, name).then((result) => {
      const count = result.added + result.replaced;
      setSaid({ text: count ? `${count} reading${count === 1 ? '' : 's'} from ${from}${result.replaced ? `, ${result.replaced} replacing ones already there` : ''}.` : `Nothing could be read from ${from}.`, skipped: result.skipped });
      if (count) { setPasted(''); setPasting(false); }
    }));
  }
  function drop(event: DragEvent) {
    const file = event.dataTransfer.files[0];
    setOver(false);
    if (!file) return;
    event.preventDefault();
    event.stopPropagation();
    if (!FILE.test(file.name)) { setProblem('Drop a .csv or .json file.'); return; }
    void file.text().then((text) => read(text, file.name));
  }
  function log() {
    const number = Number(value.replace(/[,$€£%\s]/g, ''));
    const key = chosen === NEW ? newName.trim() : chosen;
    if (!key) { setProblem('Name the new number.'); return; }
    if (!value.trim() || !Number.isFinite(number)) { setProblem('Type a number.'); return; }
    act(logMetric(id, key, number).then((metric) => { setValue(''); setNewName(''); setWhich(metric.key); }));
  }
  function setTarget() {
    if (!star) return;
    const number = Number(aim.value.replace(/[,$€£%\s]/g, ''));
    if (!aim.value.trim() || !Number.isFinite(number) || !aim.by) { setProblem('A target needs a number and a day.'); return; }
    act(changeMetric(id, star.key, { target: { value: number, by: aim.by } }).then(() => setAiming(false)));
  }

  const moved = star ? delta(star, period) : null;
  const going = star ? pace(star, localDay(Date.now())) : null;
  const when = period === 'week' ? 'last week' : 'last month';

  return (
    <Frame selected={!!selected} minWidth={340} minHeight={300}>
      <header className="card__header card__header--doc">
        <svg className="doc-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.800 12.500l3.600-4.200 3 2.400 5.600-6.700" fill="none" stroke="currentColor" strokeWidth="1.300" strokeLinecap="round" strokeLinejoin="round" /><path d="M10.500 4h3.500v3.500" fill="none" stroke="currentColor" strokeWidth="1.300" strokeLinecap="round" strokeLinejoin="round" /></svg>
        <input className="card__title-input nodrag" aria-label="Metrics card name" placeholder="Metrics" value={data.title ?? ''} onChange={(event) => updateNodeData(id, { title: event.target.value || undefined })} />
        <span className="metrics__gap" />
        <div className="metrics__period nodrag" role="radiogroup" aria-label="Compare by">
          {(['week', 'month'] as const).map((one) => (
            <button key={one} type="button" role="radio" aria-checked={period === one} className={period === one ? 'is-on' : undefined} onClick={() => updateNodeData(id, { period: one === 'month' ? 'month' : undefined })}>{one === 'week' ? 'Week' : 'Month'}</button>
          ))}
        </div>
        {!empty && <button type="button" className="metrics__paste-open nodrag" aria-expanded={pasting} onClick={() => setPasting(!pasting)}>Paste</button>}
        <CardActions id={id} what="this Metrics card (its numbers stay in the workspace)" />
      </header>
      <div className={`metrics nodrag nowheel${over ? ' is-over' : ''}`}
        onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setOver(true); } }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as globalThis.Node | null)) setOver(false); }}
        onDrop={drop}>
        {empty && !metrics ? null : empty ? (
          <p className="metrics__teach">Paste a table or drop a CSV: a date, then one column for each number.</p>
        ) : star && (
          <section className="metrics__star" aria-label={`North star: ${star.label}`}>
            <h3>{star.label}</h3>
            <div className="metrics__big">
              <b>{formatValue(moved?.now ?? 0, star.unit)}</b>
              {moved?.abs !== undefined && (
                <span className={`metrics__delta is-${tone(star, moved.abs)}`}>{formatChange(moved.abs, star.unit)}{moved.pct !== null && moved.pct !== undefined ? ` · ${formatPct(moved.pct)}` : ''}<small> vs {when}</small></span>
              )}
            </div>
            <Spark points={series(star, period)} unit={star.unit} label={star.label} big />
            {star.target && going && going.state !== 'none' ? (
              <p className={`metrics__target is-${going.state}`}>
                Target {formatValue(star.target.value, star.unit)} by {longDay(star.target.by)}
                <span> · {going.state === 'met' ? 'reached' : going.state === 'on' ? 'on pace' : going.state === 'missed' ? 'date passed' : `behind by ${going.gap}%`}</span>
                <button type="button" aria-label="Remove target" title="Remove target" onClick={() => act(changeMetric(id, star.key, { target: null }))}>×</button>
              </p>
            ) : aiming ? (
              <form className="metrics__aim" onSubmit={(event) => { event.preventDefault(); setTarget(); }}>
                <input aria-label="Target value" inputMode="decimal" placeholder="Target" value={aim.value} onChange={(event) => setAim({ ...aim, value: event.target.value })} />
                <input aria-label="Target day" type="date" value={aim.by} onChange={(event) => setAim({ ...aim, by: event.target.value })} />
                <button type="submit">Set</button>
                <button type="button" className="quiet" onClick={() => setAiming(false)}>Cancel</button>
              </form>
            ) : (
              <button type="button" className="metrics__aim-open" onClick={() => { setAim({ value: '', by: '' }); setAiming(true); }}>Set a target</button>
            )}
          </section>
        )}
        {!empty && rest.length > 0 && (
          <ul className="metrics__rows" aria-label="Other numbers">
            {rest.map((metric) => {
              const change = delta(metric, period);
              return (
                <li key={metric.key} className="metrics__row">
                  <span className="metrics__label" title={metric.label}>{metric.label}</span>
                  <Spark points={series(metric, period)} unit={metric.unit} label={metric.label} />
                  <span className="metrics__value">{change ? formatValue(change.now, metric.unit) : '—'}</span>
                  <span className={`metrics__change is-${tone(metric, change?.abs)}`}>{change?.abs !== undefined ? formatChange(change.abs, metric.unit) : ''}</span>
                  <span className="metrics__acts">
                    <button type="button" aria-label={`Make ${metric.label} the north star`} title="Make this the north star" onClick={() => act(changeMetric(id, metric.key, { northStar: true }))}>
                      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.200l1.700 3.600 3.900.5-2.900 2.700.7 3.900L8 11l-3.400 1.900.7-3.900-2.900-2.700 3.900-.5z" /></svg>
                    </button>
                    {removing === metric.key
                      ? <button type="button" className="is-danger" onClick={() => { setRemoving(''); act(removeMetric(id, metric.key)); }}>Remove</button>
                      : <button type="button" aria-label={`Remove ${metric.label}`} title="Remove" onClick={() => setRemoving(metric.key)}>
                          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.500 4.500l7 7M11.500 4.500l-7 7" /></svg>
                        </button>}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {(pasting || empty) && metrics && (
          <form className="metrics__pastebox" onSubmit={(event) => { event.preventDefault(); if (pasted.trim()) read(pasted, 'pasted'); }}>
            <textarea ref={pasteBox} aria-label="Paste numbers" rows={empty ? 5 : 4} spellCheck={false} placeholder={'date,Weekly active teams,MRR\n2026-09-14,34,$3000\n2026-09-21,42,$3120'} value={pasted} onChange={(event) => setPasted(event.target.value)} />
            <div className="metrics__pasteend">
              <small>CSV or JSON, one row a day. Or drop a file on the card.</small>
              <button type="submit" disabled={!pasted.trim()}>Read</button>
            </div>
          </form>
        )}
        {said && (
          <div className="metrics__said" role="status">
            <p>{said.text}{said.skipped.length > 0 && ` Skipped ${said.skipped.length}:`}</p>
            {said.skipped.length > 0 && <ul>{said.skipped.slice(0, 4).map((one) => <li key={one}>{one}</li>)}{said.skipped.length > 4 && <li>and {said.skipped.length - 4} more</li>}</ul>}
            <button type="button" aria-label="Close" onClick={() => setSaid(null)}>×</button>
          </div>
        )}
        {problem && <p className="metrics__problem" role="alert">{problem}</p>}
        {!empty && (
          <form className="metrics__log" onSubmit={(event) => { event.preventDefault(); log(); }}>
            <select aria-label="Which number" value={chosen} onChange={(event) => setWhich(event.target.value)}>
              {all.map((metric) => <option key={metric.key} value={metric.key}>{metric.label}</option>)}
              <option value={NEW}>New number…</option>
            </select>
            {chosen === NEW && <input aria-label="New number's name" placeholder="Name" value={newName} onChange={(event) => setNewName(event.target.value)} />}
            <input aria-label="Today's value" inputMode="decimal" placeholder="Today's value" value={value} onChange={(event) => setValue(event.target.value)} />
            <button type="submit" disabled={!value.trim()}>Log</button>
          </form>
        )}
        {over && <div className="metrics__drop" aria-hidden="true">Drop a CSV or JSON file</div>}
      </div>
    </Frame>
  );
}
