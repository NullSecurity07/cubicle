import { useReactFlow, useStore, type Node, type NodeProps } from '@xyflow/react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  alertLevel, BASE, CATEGORIES, categoryOf, guessCategory, isDay, MAX_SCENARIOS, money, monthOf, newRunwayId, parseAmount, planOf, project, proposalTitle,
  readBank, readMonth, runwayCsv, todayOf, type Candidate, type Category, type Flow, type Projection, type Runway, type RunwayAlert, type RunwayProposal, type Scenario,
} from '../../shared/runway';
import { getModels } from '../api';
import { pressed } from '../keys';
import { useFlushStage } from '../sync';
import { CardActions, Frame } from './Frame';
import { acceptProposal, declineProposal, putRunway, seenAlert, watchRunway } from './runwayApi';
import './runway.css';

export type RunwayNodeType = Node<{ currency?: string }, 'runway'>;

const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'INR', 'SGD', 'CHF', 'JPY'];
// One colour a plan: Base in the app's blue, then the three a scenario may take.
const PLAN_COLOURS = ['#4e8cff', '#6fcf97', '#f0b35a', '#b58cff'];
const LOCAL = 'ollama';
const CATEGORY_NAMES: Record<Category, string> = { people: 'People', tools: 'Tools', rent: 'Rent', revenue: 'Revenue', other: 'Other' };

const monthName = (month: string, year: 'numeric' | '2-digit' = 'numeric') => new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', year, timeZone: 'UTC' });
const dayName = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
function short(amount: number, currency: string) {
  const abs = Math.abs(amount);
  const unit = abs >= 1e6 ? [1e6, 'M'] as const : abs >= 1e3 ? [1e3, 'k'] as const : [1, ''] as const;
  const number = abs / unit[0];
  const text = money(Math.sign(amount) * Number(number.toFixed(number < 10 && unit[1] ? 1 : 0)), currency);
  return unit[1] ? text.replace(/(\d)(\D*)$/, `$1${unit[1]}$2`) : text;
}
// What the founder types for an amount: "-2,000", "3000", "(120)".
const amountOf = (text: string) => parseAmount(text.replace(/\s/g, ''));

// One editable value that saves when the founder leaves it or presses Enter, and puts itself back on Escape or a value
// that does not read. Keyed by what is saved, so news from the server replaces what is shown.
function Field({ value, label, onCommit, className, placeholder, type = 'text', show, fit }: {
  value: string; label: string; onCommit: (text: string) => boolean | void; className?: string; placeholder?: string; type?: string; show?: (value: string) => string; fit?: boolean;
}) {
  const shown = show ? show(value) : value;
  // `fit`: as wide as what it holds, so the words after it sit beside the number instead of a column's width away.
  const width = fit ? `calc(${Math.max(shown.length, placeholder?.length ?? 0, 4)}ch + 16px)` : undefined;
  return (
    <input key={shown} type={type} className={className} aria-label={label} placeholder={placeholder} defaultValue={shown} style={width ? { width } : undefined}
      onBlur={(event) => { const text = event.currentTarget.value.trim(); if (text === shown) return; if (onCommit(text) === false) event.currentTarget.value = shown; }}
      onKeyDown={(event) => { if (pressed(event, 'send')) event.currentTarget.blur(); if (pressed(event, 'cancel')) { event.currentTarget.value = shown; event.currentTarget.blur(); } }} />
  );
}

// Cash over 24 months, one line a plan. The plan in front is drawn full; the others stay behind it, faint, so the
// difference a scenario makes is the gap between two lines.
function Chart({ lines, active, currency }: { lines: { id: string; name: string; colour: string; projection: Projection; start: number }[]; active: string; currency: string }) {
  const [W, H, top, bottom, left] = [340, 150, 10, 20, 44];
  const values = lines.flatMap((line) => [line.start, ...line.projection.series.map((point) => point.cash)]);
  const high = Math.max(0, ...values);
  const low = Math.min(0, ...values);
  const span = high - low || 1;
  const x = (index: number) => left + (index / 24) * (W - left - 6);
  const y = (value: number) => top + ((high - value) / span) * (H - top - bottom);
  const path = (line: (typeof lines)[number]) => [line.start, ...line.projection.series.map((point) => point.cash)].map((value, index) => `${index ? 'L' : 'M'}${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(' ');
  const first = lines[0]?.projection.start;
  const ordered = [...lines.filter((line) => line.id !== active), ...lines.filter((line) => line.id === active)];
  const front = lines.find((line) => line.id === active);
  return (
    <svg className="runway__chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Cash over the next 24 months, ${lines.length} plan${lines.length === 1 ? '' : 's'}`}>
      <defs>
        <linearGradient id="runway-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor={front?.colour} stopOpacity="0.22" /><stop offset="1" stopColor={front?.colour} stopOpacity="0" /></linearGradient>
      </defs>
      <line className="runway__axis" x1={left} x2={W - 6} y1={y(0)} y2={y(0)} />
      <text className="runway__tick" x={left - 6} y={y(high) + 4} textAnchor="end">{short(high, currency)}</text>
      {y(0) - y(high) > 10 && <text className="runway__tick" x={left - 6} y={y(0) + 4} textAnchor="end">0</text>}
      {low < 0 && <text className="runway__tick" x={left - 6} y={y(low) + 4} textAnchor="end">{short(low, currency)}</text>}
      {first && [0, 12, 24].map((index) => <text key={index} className="runway__tick" x={x(index)} y={H - 4} textAnchor={index === 0 ? 'start' : index === 24 ? 'end' : 'middle'}>{monthName(`${Number(first.slice(0, 4)) + index / 12}${first.slice(4)}`, '2-digit')}</text>)}
      {front && <path d={`${path(front)} L${x(24).toFixed(1)},${y(0).toFixed(1)} L${x(0).toFixed(1)},${y(0).toFixed(1)} Z`} fill="url(#runway-fill)" className="runway__area" />}
      {ordered.map((line) => (
        <path key={line.id} data-plan={line.name} className={`runway__line${line.id === active ? ' is-active' : ''}`} d={path(line)} stroke={line.colour} />
      ))}
      {front?.projection.zero && (() => {
        const index = front.projection.series.findIndex((point) => point.cash <= 0);
        return index >= 0 ? <circle className="runway__zero" cx={x(index + 1)} cy={y(0)} r="3" fill={front.colour} /> : null;
      })()}
    </svg>
  );
}

// The founder's runway: cash, what goes out and comes in, months left and the day it runs out, with up to three
// what-if plans beside Base. The numbers are worked out here and on the server by the same TypeScript; a wired person
// reads them and may only suggest, and a suggestion counts once the founder accepts it here.
export function RunwayNode({ id, data, selected }: NodeProps<RunwayNodeType>) {
  const currency = data.currency || 'USD';
  const [runway, setRunway] = useState<Runway | null>(null);
  const [proposals, setProposals] = useState<RunwayProposal[]>([]);
  const [alert, setAlert] = useState<RunwayAlert | undefined>();
  const [tab, setTab] = useState(BASE);
  const [naming, setNaming] = useState<string | null>(null);
  const [problem, setProblem] = useState('');
  const [bank, setBank] = useState<string | null>(null);
  const [local, setLocal] = useState(false);
  const { updateNodeData } = useReactFlow();
  const flushStage = useFlushStage();
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const today = todayOf(Date.now());

  useEffect(() => {
    let stop = () => {};
    let gone = false;
    void flushStage().then(() => {
      if (gone) return;
      stop = watchRunway(id, (event) => { setRunway(event.runway); setProposals(event.proposals); setAlert(event.alert); });
    });
    return () => { gone = true; stop(); };
  }, [id, flushStage]);
  useEffect(() => { getModels().then((models) => setLocal(models.some((model) => model.name === LOCAL))).catch(() => {}); }, []);

  // The people wired to this card and the model each one uses, as one string so the card redraws only when it changes.
  const wiredKey = useStore((state) => {
    const ends = new Set(state.edges.flatMap((edge) => (edge.source === id ? [edge.target] : edge.target === id ? [edge.source] : [])));
    return JSON.stringify(state.nodes.filter((node) => node.type === 'room' && ends.has(node.id) && (node.data as { name?: string }).name)
      .map((node) => ({ id: node.id, name: (node.data as { name: string }).name, model: (node.data as { model?: string }).model ?? 'auto' })));
  });
  const people = useMemo(() => JSON.parse(wiredKey) as { id: string; name: string; model: string }[], [wiredKey]);

  const scenarios = runway?.scenarios ?? [];
  const active = scenarios.some((one) => one.id === tab) ? tab : BASE;
  const scenario = scenarios.find((one) => one.id === active);
  const lines = useMemo(() => (runway ? [
    { id: BASE, name: 'Base', colour: PLAN_COLOURS[0], projection: project(runway, undefined, today), start: runway.cash.amount },
    ...runway.scenarios.map((one, index) => {
      const projection = project(runway, one.id, today);
      // A one-off in the first month is already in the first point; the line starts where Base does.
      return { id: one.id, name: one.name, colour: PLAN_COLOURS[index + 1], projection, start: runway.cash.amount };
    }),
  ] : []), [runway, today]);
  const shown = lines.find((line) => line.id === active)?.projection;
  const empty = !runway || (!runway.cash.amount && !runway.flows.length);
  const level = empty ? null : alertLevel(shown?.monthsLeft ?? null);

  const attempt = (work: Promise<unknown>) => { setProblem(''); work.catch((error: Error) => setProblem(error.message)); };
  // Every change is the whole runway, saved in order, shown at once.
  function change(edit: (current: Runway) => Runway) {
    if (!runway) return;
    const next = edit(runway);
    setRunway(next);
    setProblem('');
    queue.current = queue.current.then(() => putRunway(id, next)).catch((error: Error) => setProblem(error.message));
  }
  const month = runway ? monthOf(isDay(runway.cash.asOf) ? runway.cash.asOf : today) : monthOf(today);
  const editFlow = (flowId: string, patch: Partial<Flow>) => change((current) => ({
    ...current,
    flows: current.flows.map((flow) => (flow.id === flowId ? tidy({ ...flow, ...patch }) : flow)),
    scenarios: current.scenarios.map((one) => ({ ...one, changes: one.changes.map((each) => ('add' in each && each.add.id === flowId ? { add: tidy({ ...each.add, ...patch }) } : each)) })),
  }));
  const removeFlow = (flowId: string) => change((current) => ({
    ...current,
    flows: current.flows.filter((flow) => flow.id !== flowId),
    scenarios: current.scenarios.map((one) => ({ ...one, changes: one.changes.filter((each) => !('add' in each && each.add.id === flowId) && !('drop' in each && each.drop === flowId)) })),
  }));
  const editScenario = (scenarioId: string, edit: (one: Scenario) => Scenario) => change((current) => ({ ...current, scenarios: current.scenarios.map((one) => (one.id === scenarioId ? edit(one) : one)) }));
  function addFlow(flow: Flow) {
    if (scenario) editScenario(scenario.id, (one) => ({ ...one, changes: [...one.changes, { add: flow }] }));
    else change((current) => ({ ...current, flows: [...current.flows, flow] }));
  }
  function addScenario(name: string) {
    const clean = name.trim().replace(/\s+/g, ' ').slice(0, 60);
    setNaming(null);
    if (!clean || !runway) return;
    const made: Scenario = { id: newRunwayId('plan'), name: clean, changes: [] };
    change((current) => ({ ...current, scenarios: [...current.scenarios, made] }));
    setTab(made.id);
  }
  function exportCsv() {
    if (!runway) return;
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([runwayCsv(runway, today)], { type: 'text/csv' }));
    link.download = `runway-${today}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }
  function addCandidates(ticked: Candidate[]) {
    change((current) => ({ ...current, flows: [...current.flows, ...ticked.map((one): Flow => ({ id: newRunwayId('flow'), label: one.label, monthly: one.monthly, from: month, category: one.category }))] }));
    setBank(null);
    setTab(BASE);
  }

  const flowsHere = scenario ? scenario.changes.flatMap((each) => ('add' in each ? [each.add] : [])) : runway?.flows ?? [];
  const dropped = new Set(scenario?.changes.flatMap((each) => ('drop' in each ? [each.drop] : [])) ?? []);
  const oneOffs = scenario?.changes.flatMap((each, index) => ('cash' in each ? [{ ...each, index }] : [])) ?? [];
  const plan = runway ? planOf(runway, scenario?.id) : null;

  return (
    <Frame selected={!!selected} minWidth={640} minHeight={440}>
      <header className="card__header card__header--doc">
        <svg className="doc-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 3.5v10h13" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /><path d="M3.5 5.5l3 2.5 2.5-2 4.5 5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
        <div className="card__name">Runway</div>
        <select className="runway__currency nodrag" aria-label="Currency" value={currency} onChange={(event) => updateNodeData(id, { currency: event.target.value })}>
          {[...new Set([currency, ...CURRENCIES])].map((code) => <option key={code} value={code}>{code}</option>)}
        </select>
        <button type="button" className="runway__quiet nodrag" onClick={() => setBank('')}>Paste bank CSV</button>
        <button type="button" className="runway__quiet nodrag" disabled={empty} onClick={exportCsv}>Export CSV</button>
        <CardActions id={id} what="this Runway card (its numbers stay in the workspace)" />
      </header>

      <div className="runway nodrag nowheel">
        {!runway ? <p className="runway__empty">Reading the numbers…</p> : <>
          <section className="runway__top">
            <dl className="runway__facts">
              <div>
                <dt>Cash today</dt>
                <dd className="runway__cash">
                  <Field fit label="Cash in the bank" className="runway__amount" placeholder="Enter cash" value={runway.cash.amount ? money(runway.cash.amount, currency) : ''}
                    onCommit={(text) => { const amount = amountOf(text); if (text && !Number.isFinite(amount)) return false; change((current) => ({ ...current, cash: { ...current.cash, amount: Number.isFinite(amount) ? Math.round(amount) : 0 } })); }} />
                  <small className="runway__asof">counted on
                    <Field label="Counted on" type="date" className="runway__date" value={runway.cash.asOf}
                      onCommit={(text) => { if (!isDay(text)) return false; change((current) => ({ ...current, cash: { ...current.cash, asOf: text } })); }} />
                  </small>
                </dd>
              </div>
              <div>
                <dt>Burn</dt>
                <dd>{shown && shown.burn ? <>{money(shown.burn, currency)} <small>a month</small>{shown.revenue > 0 && <small className="runway__sub">{money(shown.revenue, currency)} in, so {shown.net > 0 ? `${money(shown.net, currency)} net out` : `${money(-shown.net, currency)} net in`}</small>}</> : <span className="runway__none">—</span>}</dd>
              </div>
              <div>
                <dt>Months left</dt>
                <dd aria-label="Months left" className={level ? `is-${level === 3 ? 'red' : 'amber'}` : undefined}>
                  {empty || !shown ? <span className="runway__none">—</span> : shown.monthsLeft !== null ? shown.monthsLeft.toFixed(1) : <span className="runway__fine">Not running out</span>}
                </dd>
              </div>
              <div>
                <dt>Cash out</dt>
                <dd aria-label="Cash out">{empty || !shown ? <span className="runway__none">—</span> : shown.zero ? dayName(shown.zero) : <small>{shown.net <= 0 ? 'More comes in than goes out' : 'Not within ten years'}</small>}</dd>
              </div>
            </dl>
            <div className="runway__plot">
              {empty ? <p className="runway__empty">Enter the cash in the bank, then what goes out and comes in each month.</p> : <Chart lines={lines} active={active} currency={currency} />}
            </div>
          </section>

          {shown && !empty && CATEGORIES.filter((one) => one !== 'revenue' && shown.byCategory[one]).length > 1 && (
            <p className="runway__split">{CATEGORIES.filter((one) => one !== 'revenue' && shown.byCategory[one]).map((one) => <span key={one}>{CATEGORY_NAMES[one]} {money(shown.byCategory[one]!, currency)}</span>)}</p>
          )}

          {level && (
            <p className={`runway__alert is-${level === 3 ? 'red' : 'amber'}`} role="status">
              <span>{level === 3 ? 'Under three months of cash' : 'Under six months of cash'}{scenario ? ` in "${scenario.name}"` : ''}. {shown?.zero ? `It runs out on ${dayName(shown.zero)}.` : ''}</span>
              {alert && !alert.seen && !scenario && <button type="button" onClick={() => attempt(seenAlert(id))}>Seen</button>}
            </p>
          )}

          {proposals.length > 0 && (
            <ul className="runway__asks" aria-label="Suggestions waiting for you">
              {proposals.map((one) => (
                <li key={one.id}>
                  <p><b>{one.by}</b> suggests {proposalTitle(one, runway.flows, currency)}{one.kind === 'flow' && one.into ? `, in "${scenarios.find((each) => each.id === one.into)?.name ?? 'a scenario'}"` : ''}.{one.why && <small>{one.why}</small>}</p>
                  <button type="button" onClick={() => attempt(declineProposal(id, one.id))}>Decline</button>
                  <button type="button" className="primary" disabled={one.kind === 'scenario' && scenarios.length >= MAX_SCENARIOS} title={one.kind === 'scenario' && scenarios.length >= MAX_SCENARIOS ? 'Remove a scenario first' : undefined} onClick={() => attempt(acceptProposal(id, one.id))}>Accept</button>
                </li>
              ))}
            </ul>
          )}

          <nav className="runway__tabs" role="tablist" aria-label="Plans">
            {lines.map((line) => (
              <button key={line.id} type="button" role="tab" aria-selected={line.id === active} className={line.id === active ? 'is-on' : undefined} onClick={() => setTab(line.id)}>
                <i style={{ background: line.colour }} />{line.name}
              </button>
            ))}
            {naming !== null
              ? <input autoFocus className="runway__naming" aria-label="Scenario name" placeholder="Hire in January" value={naming} onChange={(event) => setNaming(event.target.value)}
                  onBlur={() => addScenario(naming)} onKeyDown={(event) => { if (pressed(event, 'send')) addScenario(naming); if (pressed(event, 'cancel')) setNaming(null); }} />
              : scenarios.length < MAX_SCENARIOS && <button type="button" className="runway__plus" aria-label="Add scenario" title="A what-if plan beside Base" onClick={() => setNaming('')}>+ Scenario</button>}
          </nav>

          {scenario && (
            <div className="runway__plan">
              <Field label="Scenario name" className="runway__plan-name" value={scenario.name} onCommit={(text) => { if (!text) return false; editScenario(scenario.id, (one) => ({ ...one, name: text.slice(0, 60) })); }} />
              <button type="button" className="runway__remove-plan" onClick={() => { change((current) => ({ ...current, scenarios: current.scenarios.filter((one) => one.id !== scenario.id) })); setTab(BASE); }}>Remove scenario</button>
              {runway.flows.length > 0 && (
                <div className="runway__keeps" aria-label="Base flows in this plan">
                  <span>From Base</span>
                  {runway.flows.map((flow) => (
                    <label key={flow.id} className={dropped.has(flow.id) ? 'is-dropped' : undefined}>
                      <input type="checkbox" checked={!dropped.has(flow.id)} onChange={(event) => editScenario(scenario.id, (one) => ({
                        ...one, changes: event.target.checked ? one.changes.filter((each) => !('drop' in each && each.drop === flow.id)) : [...one.changes, { drop: flow.id }],
                      }))} />
                      {flow.label}
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}

          <table className="runway__table">
            <thead>
              <tr><th>{scenario ? 'This plan adds' : 'Each month'}</th><th>Kind</th><th className="is-num">In / out</th><th>From</th><th>To</th><th className="is-num">Grows</th><th aria-label="Remove" /></tr>
            </thead>
            <tbody>
              {flowsHere.map((flow) => (
                <tr key={flow.id}>
                  <td><Field label="Label" value={flow.label} onCommit={(text) => { if (!text) return false; editFlow(flow.id, { label: text.slice(0, 80) }); }} /></td>
                  <td>
                    <select aria-label={`Kind of ${flow.label}`} value={categoryOf(flow)} onChange={(event) => editFlow(flow.id, { category: event.target.value as Category })}>
                      {CATEGORIES.map((one) => <option key={one} value={one}>{CATEGORY_NAMES[one]}</option>)}
                    </select>
                  </td>
                  <td className="is-num"><Field label={`${flow.label} a month`} className={flow.monthly > 0 ? 'is-in' : undefined} value={String(flow.monthly)} show={(value) => money(Number(value), currency)}
                    onCommit={(text) => { const amount = amountOf(text); if (!Number.isFinite(amount) || !amount) return false; editFlow(flow.id, { monthly: amount }); }} /></td>
                  <td><Field label={`${flow.label} from`} value={flow.from} show={monthName} onCommit={(text) => { const from = readMonth(text); if (!from || (flow.to && from > flow.to)) return false; editFlow(flow.id, { from }); }} /></td>
                  <td><Field label={`${flow.label} to`} value={flow.to ?? ''} show={(value) => (value ? monthName(value) : '')} placeholder="Ongoing" onCommit={(text) => { const to = text ? readMonth(text) : null; if ((text && !to) || (to && to < flow.from)) return false; editFlow(flow.id, { to: to ?? undefined }); }} /></td>
                  <td className="is-num"><Field label={`${flow.label} grows`} value={flow.grows ? `${flow.grows}%` : ''} placeholder="—"
                    onCommit={(text) => { const grows = text ? Number(text.replace('%', '')) : 0; if (!Number.isFinite(grows)) return false; editFlow(flow.id, { grows: grows || undefined }); }} /></td>
                  <td><button type="button" className="runway__x" aria-label={`Remove ${flow.label}`} onClick={() => removeFlow(flow.id)}>×</button></td>
                </tr>
              ))}
              {oneOffs.map((one) => (
                <tr key={`once-${one.index}`} className="runway__once">
                  <td>One-off</td><td />
                  <td className="is-num"><Field label="One-off amount" className={one.cash > 0 ? 'is-in' : undefined} value={String(one.cash)} show={(value) => money(Number(value), currency)}
                    onCommit={(text) => { const amount = amountOf(text); if (!Number.isFinite(amount) || !amount) return false; editScenario(scenario!.id, (plan) => ({ ...plan, changes: plan.changes.map((each, index) => (index === one.index ? { cash: Math.round(amount), at: one.at } : each)) })); }} /></td>
                  <td><Field label="One-off month" value={one.at} show={monthName} onCommit={(text) => { const at = readMonth(text); if (!at) return false; editScenario(scenario!.id, (plan) => ({ ...plan, changes: plan.changes.map((each, index) => (index === one.index ? { cash: one.cash, at } : each)) })); }} /></td>
                  <td /><td />
                  <td><button type="button" className="runway__x" aria-label="Remove one-off" onClick={() => editScenario(scenario!.id, (plan) => ({ ...plan, changes: plan.changes.filter((_, index) => index !== one.index) }))}>×</button></td>
                </tr>
              ))}
              <AddRow month={month} onAdd={addFlow} key={`${active}-${flowsHere.length}`} />
            </tbody>
          </table>
          {scenario && <OneOff month={month} onAdd={(cash, at) => editScenario(scenario.id, (one) => ({ ...one, changes: [...one.changes, { cash, at }] }))} currency={currency} />}
          {!scenario && !flowsHere.length && <p className="runway__hint">Add what goes out (rent, salaries, tools) as a negative number and what comes in as a positive one, or paste a bank statement.</p>}
          {plan && scenario && !plan.flows.length && !plan.oneOffs.length && <p className="runway__hint">This plan is empty so far.</p>}
        </>}
        {problem && <p className="runway__problem" role="alert">{problem}</p>}
      </div>

      <footer className="runway__foot nodrag">
        <Privacy people={people} local={local} onLocal={(roomId) => updateNodeData(roomId, { model: LOCAL })} />
        <span>Not accounting: no taxes or accruals.</span>
      </footer>

      {bank !== null && <BankPaste text={bank} setText={setBank} currency={currency} onAdd={addCandidates} onClose={() => setBank(null)} />}
    </Frame>
  );
}

// A flow typed without a label or with a zero amount does not reach the server.
function tidy(flow: Flow): Flow {
  const { to, grows, ...rest } = flow;
  return { ...rest, ...(to ? { to } : {}), ...(grows ? { grows } : {}) };
}

function AddRow({ month, onAdd }: { month: string; onAdd: (flow: Flow) => void }) {
  const [draft, setDraft] = useState({ label: '', monthly: '', from: monthName(month), to: '', grows: '' });
  const amount = amountOf(draft.monthly);
  const from = readMonth(draft.from);
  const to = draft.to.trim() ? readMonth(draft.to) : null;
  const ready = !!draft.label.trim() && Number.isFinite(amount) && amount !== 0 && !!from && (!draft.to.trim() || (!!to && to >= from));
  function add() {
    if (!ready || !from) return;
    const grows = Number(draft.grows.replace('%', ''));
    const label = draft.label.trim().slice(0, 80);
    onAdd({ id: newRunwayId('flow'), label, monthly: amount, from, ...(to ? { to } : {}), ...(Number.isFinite(grows) && grows ? { grows } : {}), category: guessCategory(label, amount) });
  }
  const enter = (event: KeyboardEvent) => { if (pressed(event, 'send')) { event.preventDefault(); add(); } };
  return (
    <tr className="runway__add">
      <td><input aria-label="New flow label" placeholder="Rent, salaries, revenue…" value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })} onKeyDown={enter} /></td>
      <td />
      <td className="is-num"><input aria-label="New flow a month" placeholder="-2,000" value={draft.monthly} onChange={(event) => setDraft({ ...draft, monthly: event.target.value })} onKeyDown={enter} /></td>
      <td><input aria-label="New flow from" className={draft.from && !from ? 'is-wrong' : undefined} value={draft.from} onChange={(event) => setDraft({ ...draft, from: event.target.value })} onKeyDown={enter} /></td>
      <td><input aria-label="New flow to" className={draft.to.trim() && !to ? 'is-wrong' : undefined} placeholder="Ongoing" value={draft.to} onChange={(event) => setDraft({ ...draft, to: event.target.value })} onKeyDown={enter} /></td>
      <td className="is-num"><input aria-label="New flow grows" placeholder="%" value={draft.grows} onChange={(event) => setDraft({ ...draft, grows: event.target.value })} onKeyDown={enter} /></td>
      <td><button type="button" className="runway__addbtn" aria-label="Add flow" disabled={!ready} onClick={add}>Add</button></td>
    </tr>
  );
}

function OneOff({ month, onAdd, currency }: { month: string; onAdd: (cash: number, at: string) => void; currency: string }) {
  const [draft, setDraft] = useState({ cash: '', at: monthName(month) });
  const amount = amountOf(draft.cash);
  const at = readMonth(draft.at);
  const ready = Number.isFinite(amount) && amount !== 0 && !!at;
  return (
    <form className="runway__oneoff" onSubmit={(event) => { event.preventDefault(); if (ready && at) { onAdd(Math.round(amount), at); setDraft({ cash: '', at: monthName(month) }); } }}>
      <span>One-off sum</span>
      <input aria-label="One-off sum" placeholder={`${money(500000, currency)} raised, or -${money(8000, currency).replace('-', '')} bill`} value={draft.cash} onChange={(event) => setDraft({ ...draft, cash: event.target.value })} />
      <span>in</span>
      <input aria-label="One-off month" className={`runway__oneoff-month${draft.at && !at ? ' is-wrong' : ''}`} value={draft.at} onChange={(event) => setDraft({ ...draft, at: event.target.value })} />
      <button type="submit" disabled={!ready}>Add</button>
    </form>
  );
}

// Who reads these numbers, and through what. A hosted model is somebody else's computer; one click keeps a person on
// this machine's model instead. Even then, if the local model fails, a hosted one may answer: said plainly.
function Privacy({ people, local, onLocal }: { people: { id: string; name: string; model: string }[]; local: boolean; onLocal: (roomId: string) => void }) {
  if (!people.length) return <span>Nobody reads these yet. A person you wire here reads them through the model they use.</span>;
  const hosted = people.filter((person) => person.model !== LOCAL);
  if (!hosted.length) return <span>{names(people)} read{people.length === 1 ? 's' : ''} these on this machine's model. If it fails, a hosted model may answer.</span>;
  return (
    <span className="runway__privacy">
      These numbers reach whichever model {names(hosted)} use{hosted.length === 1 ? 's' : ''}, hosted ones included.
      {local
        ? hosted.map((person) => <button key={person.id} type="button" onClick={() => onLocal(person.id)}>Keep {person.name} on this machine</button>)
        : <em> No model on this machine is set up.</em>}
    </span>
  );
}
const names = (people: { name: string }[]) => (people.length <= 2 ? people.map((person) => person.name).join(' and ') : `${people.slice(0, -1).map((person) => person.name).join(', ')} and ${people.at(-1)!.name}`);

// A bank statement pasted as it came out of the bank. Rows are grouped by who was paid, a month's worth each, and
// nothing counts until the founder ticks it.
function BankPaste({ text, setText, currency, onAdd, onClose }: { text: string; setText: (text: string) => void; currency: string; onAdd: (ticked: Candidate[]) => void; onClose: () => void }) {
  const read = useMemo(() => readBank(text), [text]);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const chosen = read.candidates.filter((one) => ticked.has(one.key));
  return (
    <aside className="runway__bank nodrag nowheel" role="dialog" aria-label="Paste a bank statement">
      <div className="runway__bank-head">
        <h3>Paste a bank statement</h3>
        <button type="button" aria-label="Close" onClick={onClose}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg></button>
      </div>
      <textarea autoFocus aria-label="Bank CSV" rows={5} placeholder={'Date,Description,Amount\n2026-08-01,Office rent,-2000'} value={text} onChange={(event) => { setText(event.target.value); setTicked(new Set()); }} />
      {text.trim() && <p className="runway__quiet-line">{read.rows} row{read.rows === 1 ? '' : 's'} over {read.months} month{read.months === 1 ? '' : 's'}{read.skipped ? `, ${read.skipped} skipped (no date, words or amount)` : ''}. Read on this machine; nothing is sent anywhere.</p>}
      <ul className="runway__candidates" aria-label="Lines found">
        {read.candidates.map((one) => (
          <li key={one.key}>
            <label>
              <input type="checkbox" checked={ticked.has(one.key)} onChange={(event) => { const next = new Set(ticked); if (event.target.checked) next.add(one.key); else next.delete(one.key); setTicked(next); }} />
              <span className="runway__cand-label">{one.label}</span>
              <small>{CATEGORY_NAMES[one.category]} · {one.count} payment{one.count === 1 ? '' : 's'} in {one.months} of {read.months} month{read.months === 1 ? '' : 's'}</small>
              <b className={one.monthly > 0 ? 'is-in' : undefined}>{money(one.monthly, currency)}</b>
            </label>
          </li>
        ))}
      </ul>
      <div className="runway__bank-end">
        <span>Nothing counts until you tick it.</span>
        <button type="button" className="primary" disabled={!chosen.length} onClick={() => onAdd(chosen)}>{chosen.length ? `Add ${chosen.length} to Base` : 'Tick what repeats'}</button>
      </div>
    </aside>
  );
}
