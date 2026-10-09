import type { ToolEvent } from '../../shared/model.ts';
import { calculate as calc } from '../tools/calc.ts';

// Journey 13: asked "keep going, pivot or stop?", the partner said "keep going" for a goal of 10 paying offices while
// the brief's own numbers (price €240, cost €178 an office, burn €2,100) put break-even at 34. It saw it only when the
// founder pushed. Before the partner judges, the brief's Numbers are worked out here with the calc tool: break-even
// (fixed costs over what each paying unit leaves) and runway (cash over net burn). The working goes into the verdict's
// reason as calc results, so the truth guard backs every figure, and a "keep going" far below break-even has to say
// how the gap closes.

// Journey 16: four rounds of fixes each read the brief their own way, and they did not agree. The price was "€59 per
// week per subscriber" and every unasked path read it as a month; the brief had 14 subscribers of whom 11 pay and the
// working counted 14; the founder put both right in chat and the stored call, the refresh and the review never heard
// it. So there is one picture of the company's numbers now, `EconomicsState`: the inputs as the brief gives them, each
// with its period, the founder's corrections over them (latest wins, their words kept) and a later reading of the
// paying count over both; every derived figure (MRR, net burn, runway, break-even, the gap, the distance to a kill
// line) is worked out with calc from those inputs on every read and never stored. The call, the pushback, the refresh,
// the review, the watch, the morning note and the brief's own rows all read this one.

export type Period = 'week' | 'month' | 'year' | 'day';
// `volume`: the count a per-job price is paid on ("Bookings last month: 310" beside "€4 per booking"); `plan`: what
// each paying customer pays when the paying row carries its own price ("Paying cafés: 6 at €39 a month").
export type Field = 'price' | 'cost' | 'burn' | 'net' | 'cash' | 'subscribers' | 'paying' | 'volume' | 'plan';
// Where an input came from: the Company brief, the founder in chat, or a Metrics reading.
export type Source = 'brief' | 'founder' | 'reading';
// `per`: the one thing a price is paid for, when it is not a period ("booking" for "€4 per booking").
export type Input = { value: number; period?: Period; per?: string; label: string; source: Source; said: string; day?: string };
// A founder's correction of one input: a value, a period or both. `over`: what the brief said when they corrected it,
// so a brief edited since (a new figure) stands over the older correction.
export type InputFix = { field: Field; value?: number; period?: Period; said: string; day: string; over?: { value?: number; period?: Period } };
// A Metrics card's latest number for a row, by its label.
export type Reading = { label: string; value: number; day: string };
// The inputs as they stood, for the stored call: never a derived figure.
export type Snapshot = Partial<Record<Field, { value: number; period?: Period }>>;

const FACTOR: Record<Period, number> = { week: 52 / 12, month: 1, year: 1 / 12, day: 365 / 12 };
// The same conversion written into a calc expression, so the working shows it.
const TO_MONTH: Record<Period, string> = { week: ' * 52 / 12', month: '', year: ' / 12', day: ' * 365 / 12' };
const PERIOD_NAME: Record<Period, string> = { week: 'a week', month: 'a month', year: 'a year', day: 'a day' };
export const periodName = (period?: Period) => PERIOD_NAME[period ?? 'month'];

type Amount = { value: number; at: number; period?: Period; money?: boolean };
type Row = { label: string; line: string; amounts: Amount[] };
export type Working = { label: 'Break-even' | 'Runway' | 'MRR' | 'Net burn'; expression: string; values: string; result: string; line: string };
// `inputs`: the monthly figures, for a review that works a colleague's sums out again.
export type Inputs = { price?: number; cost?: number; fixed?: number; net?: number; cash?: number; paying?: number };
// `runway`: the months the working gives; Infinity when the company is cash-positive, with the months at the gross burn.
export type Economics = { working: Working[]; breakEven?: number; current?: number; unit?: string; inputs?: Inputs; currency?: string; runway?: { value: number; display: string; gross?: { value: number; display: string } } };

const PERIOD_SAID = /\b(?:(?:a|an|per|each|every)\s+|\/\s*)(week|wk|month|mo|year|yr|annum|day)\b|\b(weekly|monthly|yearly|annually|annual|daily)\b/i;
export function periodIn(text: string): Period | undefined {
  const found = PERIOD_SAID.exec(text);
  const word = (found?.[1] ?? found?.[2] ?? '').toLowerCase();
  return /^(?:week|wk|weekly)$/.test(word) ? 'week' : /^(?:month|mo|monthly)$/.test(word) ? 'month' : /^(?:year|yr|annum|yearly|annually|annual)$/.test(word) ? 'year' : /^(?:day|daily)$/.test(word) ? 'day' : undefined;
}
const AMOUNT = /[$€£]?\s?(\d[\d,]*(?:\.\d+)?)\s*(k\b)?/gi;
function rowsOf(numbers: string): Row[] {
  return numbers.split('\n').flatMap((line): Row[] => {
    const found = /^\s*[-*]\s+([^:]{1,60}):\s*(.+)$/.exec(line);
    if (!found) return [];
    const hits = [...found[2].matchAll(AMOUNT)];
    const amounts = hits.map((hit, index) => {
      const from = (hit.index ?? 0) + hit[0].length;
      // What follows this amount up to the next one, without asides: "€240 a month per office (one box a week)".
      const after = found[2].slice(from, hits[index + 1]?.index ?? found[2].length).replace(/\([^)]*\)?/g, ' ');
      const period = periodIn(after);
      return { value: Number(hit[1].replace(/,/g, '')) * (hit[2] ? 1000 : 1), at: hit.index ?? 0, ...(period ? { period } : {}), ...(/[$€£]/.test(hit[0]) ? { money: true } : {}) };
    });
    return amounts.length ? [{ label: found[1].trim(), line: found[2], amounts }] : [];
  });
}
const find = (rows: Row[], label: RegExp, not?: RegExp) => rows.find((row) => label.test(row.label) && !(not && not.test(row.label)));
// A row's figure and its period: the amount said "a month" when the row gives more than one ("€41 per box, about €178 a
// month per office"), else the first with a period, else the first; a label may give the period ("Monthly burn").
function valueOf(row: Row): { value: number; period?: Period } {
  const one = row.amounts.find((each) => each.period === 'month') ?? row.amounts.find((each) => each.period) ?? row.amounts[0];
  const period = one.period ?? (/\bmrr\b|\bmonthly\b|\bper month\b/i.test(row.label) ? 'month' : /\bweekly\b/i.test(row.label) ? 'week' : /\barr\b|\bannual\b|\byearly\b/i.test(row.label) ? 'year' : undefined);
  return { value: one.value, ...(period ? { period } : {}) };
}
const unitOf = (label: string) => label.toLowerCase().replace(/\s*\(.*\)$/, '').trim();
// What one price is paid for, when the brief says: "€12 per print job" is paid per print job, so break-even counts print
// jobs a month, not the paying hosts beside it (journey 15 said "50 paying hosts" three times after the founder said
// otherwise). A price a month, a year or per user, seat or customer is the paying row's own.
const PERIOD_OR_PAYER = /^(?:month|mo|year|yr|week|day|user|seat|customer|client|subscriber|member|account|licen[cs]e|head)s?$/i;
export function perUnit(line: string): string | undefined {
  const found = /^(?:[$€£]\s?)?\d[\d,]*(?:\.\d+)?\s*k?\s*(?:[$€£])?\s*(?:(?:per|a|an|each)\s+|\/\s*)((?:[a-z][a-z-]*\s+){0,2}?[a-z][a-z-]*)(?=\s*(?:,|;|\.|$|\bpaid\b|\bfrom\b|\bto\b|\bfor\b))/i.exec(line.replace(/\(.*?\)/g, ' ').trim());
  const words = found?.[1].trim().toLowerCase();
  // "€240 per office a month" is a subscription per paying office, not a price per job; "€59 per week per subscriber" too.
  if (!words || words.split(/\s+/).some((word) => PERIOD_OR_PAYER.test(word)) || /^\s*(?:a|per|each|\/)\s*(?:month|mo|year|yr|week)\b/i.test(line.replace(/\(.*?\)/g, ' ').slice((found!.index ?? 0) + found![0].length))) return undefined;
  return words.endsWith('s') ? words : /(?:x|ch|sh)$/.test(words) ? `${words}es` : /[^aeiou]y$/.test(words) ? `${words.slice(0, -1)}ies` : `${words}s`;
}
const stem = (word: string) => word.replace(/(?:es|s)$/, '');
const words = (text: string) => (text.toLowerCase().match(/[a-z]{3,}/g) ?? []).map((one) => one.replace(/s$/, ''));
// A Metrics row and a brief row are the same number when one's words hold the other's ("Paying subscribers", "paying").
export const sameMetric = (a: string, b: string) => { const x = words(a); const y = words(b); return !!x.length && !!y.length && (x.every((one) => y.includes(one)) || y.every((one) => x.includes(one))); };

const LABELS: Record<Field, string> = { price: 'price', cost: 'cost per unit', burn: 'burn', net: 'net burn', cash: 'cash', subscribers: 'subscribers', paying: 'paying', volume: 'volume', plan: 'price per paying customer' };
const isMoney = (field: Field) => field === 'price' || field === 'cost' || field === 'burn' || field === 'net' || field === 'plan';
const singular = (word: string) => word.replace(/ies$/, 'y').replace(/(?<=(?:x|ch|sh))es$/, '').replace(/s$/, '');
// The period a count is had in: "Bookings last month", "Bookings a week"; a month when it does not say.
const countPeriod = (text: string): Period => { const found = /\b(?:last|this|per|a|an|each|every)\s+(week|month|year|day)\b|\b(weekly|monthly|yearly|daily)\b/i.exec(text); const word = (found?.[1] ?? found?.[2] ?? 'month').toLowerCase(); return /^week/.test(word) ? 'week' : /^year/.test(word) ? 'year' : /^(?:day|daily)/.test(word) ? 'day' : 'month'; };

export type EconomicsState = {
  inputs: Partial<Record<Field, Input>>;
  // The count break-even is said in ("paying subscribers", "print jobs a month").
  unit: string;
  currency?: string;
  // A price per job: what is counted is that thing, never the paying people beside it.
  perJob: boolean;
  // Journey 20: more than one revenue stream (€4 per booking on 310 bookings, and 6 cafés paying €39 a month). The
  // paying count is the customers', the jobs are volume, MRR is both, and break-even is said in paying customers with
  // the other stream held where it is: `held` says so ("at 310 bookings a month").
  streams: number;
  held?: string;
  monthly(field: Field): number | undefined;
  snapshot(): Snapshot;
  // Derived, worked with calc on every call.
  mrr(): number | undefined;
  net(): number | undefined;
  cashPositive(): boolean;
  runway(): { value: number; display: string; gross?: { value: number; display: string } } | undefined;
  breakEven(): number | undefined;
  current(): number | undefined;
  gap(): number | undefined;
  // How far a reading sits from a kill line on its safe side: under zero once it is past the line.
  killDistance(line: number, below: boolean, value?: number): number | undefined;
  // "above break-even (11 against 8)", from the numbers alone.
  side(value?: number): 'above' | 'below' | 'at' | undefined;
  explain(): string[];
  economics(): Economics | null;
  // The founder's own words behind each input they put right, newest first.
  founderLines(): string[];
};

// The brief's inputs, the founder's corrections over them and a later paying reading over both.
export function stateOf(numbers: string, given: { fixes?: InputFix[]; readings?: Reading[]; unitFixes?: { wrong: string; right: string }[] } = {}): EconomicsState {
  // A row someone worked out ("Net burn: €-912.33 a month (calc: …)") is a derived figure, never an input: journey 16's
  // live check had one written into the brief and read back as a positive net burn.
  const rows = rowsOf(numbers).filter((row) => !/\bcalc\b|(?:^|\s)=\s/i.test(row.line));
  const priceRow = find(rows, /\b(?:price|fee|arpu|revenue per|charge)\b/i);
  const costRow = find(rows, /\bcost\b/i, /\bfixed\b|\bburn\b|\bacquisition\b|\bcac\b/i);
  const burnRow = find(rows, /\bfixed costs?\b|\boverheads?\b|\bburn\b|\boperating costs?\b|\bexpenses\b/i, /\bnet\b/i);
  const netRow = find(rows, /\bnet burn\b/i);
  const cashRow = find(rows, /\bcash\b|\bin the bank\b|\bbank balance\b/i);
  // Paying is its own row when the brief gives one ("Subscribers: 14", "Paying subscribers: 11").
  const payersRow = find(rows, /\bpaying\b|\bpaid\b/i, /\bprice\b|\bcost\b/i) ?? find(rows, /\bcustomers\b|\bsubscribers\b|\bclients\b/i, /\bprice\b|\bcost\b/i);
  const subsRow = find(rows, /\bsubscribers\b|\bcustomers\b|\busers\b|\bmembers\b/i, /\bpaying\b|\bpaid\b|\bprice\b|\bcost\b|\bper\b/i);
  const said = priceRow ? perUnit(priceRow.line) : undefined;
  const per = said && !(payersRow && new RegExp(`\\b${stem(said.split(' ').at(-1)!)}`, 'i').test(payersRow.label)) ? said : undefined;
  const counted = per ? find(rows, new RegExp(`\\b${stem(per.split(' ').at(-1)!)}`, 'i'), /\bprice\b|\bcost\b/i) : undefined;
  // The paying row's own price ("Paying cafés: 6 at €39 a month"): beside a price per job, a second stream.
  const planAt = payersRow?.amounts.find((one) => one.money && one.period);
  const countAt = payersRow?.amounts.find((one) => !one.money);
  const mixed = !!(per && payersRow && planAt && countAt);
  const payingRow = mixed ? payersRow : per ? counted : payersRow;
  const currency = /[$€£]/.exec(numbers)?.[0];
  const inputs: Partial<Record<Field, Input>> = {};
  const fromRow = (field: Field, row: Row | undefined, money = true) => {
    if (!row) return;
    const one = money ? valueOf(row) : { value: row.amounts[0].value };
    inputs[field] = { value: one.value, ...('period' in one && one.period ? { period: one.period } : {}), label: row.label, source: 'brief', said: `${row.label}: ${row.line}` };
  };
  fromRow('price', priceRow); fromRow('cost', costRow); fromRow('burn', burnRow); fromRow('net', netRow);
  fromRow('cash', cashRow, false);
  if (mixed) {
    const said = `${payersRow!.label}: ${payersRow!.line}`;
    inputs.paying = { value: countAt!.value, label: payersRow!.label, source: 'brief', said };
    inputs.plan = { value: planAt!.value, period: planAt!.period, label: `price per ${singular(unitOf(payersRow!.label))}`, source: 'brief', said };
    if (counted) inputs.volume = { value: counted.amounts[0].value, period: countPeriod(`${counted.label} ${counted.line}`), label: counted.label, source: 'brief', said: `${counted.label}: ${counted.line}` };
  } else fromRow('paying', payingRow, false);
  if (per && inputs.price) inputs.price = { ...inputs.price, per: singular(per.split(' ').at(-1)!) };
  if (subsRow && subsRow !== payingRow && subsRow !== counted) fromRow('subscribers', subsRow, false);
  // The founder's corrections, latest last: each stands unless the brief changed that figure since.
  for (const fix of given.fixes ?? []) {
    const had = inputs[fix.field];
    if (fix.over && had && ((fix.over.value !== undefined && fix.over.value !== had.value) || (fix.over.period !== undefined && had.period !== undefined && fix.over.period !== had.period))) continue;
    const base = had ?? { value: fix.value ?? NaN, label: LABELS[fix.field], source: 'founder' as const, said: '' };
    const next: Input = { ...base, ...(fix.value !== undefined ? { value: fix.value } : {}), ...(fix.period ? { period: fix.period } : {}), source: 'founder', said: fix.said, day: fix.day };
    if (Number.isFinite(next.value)) inputs[fix.field] = next;
  }
  // A later reading of the paying count on a Metrics card stands over the brief, and over a correction made before it.
  const paying = inputs.paying;
  if (paying) {
    const reading = (given.readings ?? []).filter((one) => sameMetric(one.label, paying.label) && Number.isFinite(one.value)).sort((a, b) => a.day.localeCompare(b.day)).at(-1);
    if (reading && !(paying.source === 'founder' && paying.day && paying.day > reading.day)) inputs.paying = { ...paying, value: reading.value, source: 'reading', said: `${reading.label}: ${reading.value} on ${reading.day} (Metrics)`, day: reading.day };
  }
  let unit = mixed ? unitOf(payersRow!.label) : per ? `${per} a month` : payingRow ? unitOf(payingRow.label) : 'paying customers';
  for (const fix of given.unitFixes ?? []) if (unit.toLowerCase().includes(fix.wrong)) unit = unit.toLowerCase().replace(fix.wrong, fix.right);
  const nets = !per || mixed;
  // The jobs' stream, in calc words and in the founder's: "volume * price" on "310 bookings a month at €4".
  const volumeTerm = () => `volume${TO_MONTH[inputs.volume?.period ?? 'month']} * price`;
  const heldSaid = () => (inputs.volume && inputs.price ? `${inputs.volume.value.toLocaleString('en-US')} ${per} ${periodName(inputs.volume.period)}` : undefined);

  const monthly = (field: Field) => { const one = inputs[field]; return one ? one.value * (isMoney(field) ? FACTOR[one.period ?? 'month'] : 1) : undefined; };
  const priceTerm = () => `price${TO_MONTH[inputs.price?.period ?? 'month']}`;
  const costTerm = () => `cost${TO_MONTH[inputs.cost?.period ?? 'month']}`;
  const burnTerm = (name: string) => `${name}${TO_MONTH[inputs.burn?.period ?? 'month']}`;
  const v = (field: Field) => inputs[field]!.value;
  const wrap = (term: string) => (term.includes(' ') ? `(${term})` : term);
  // A sum with a week or a year turned into a month is rounded to the cent; a plain month's sum is shown as it is.
  const cents = (expression: string) => (/ \* 52 \/ 12| \/ 12| \* 365 \/ 12/.test(expression) ? `round(${expression}, 2)` : expression);
  const burnName = () => (inputs.cost ? 'fixed' : 'burn');
  // Every stream's monthly revenue as one sum, with its values: the jobs' (when the brief counts them) and the plan's.
  const revenue = () => {
    const terms = [...(inputs.volume && inputs.price ? [volumeTerm()] : []), `paying * plan${TO_MONTH[inputs.plan?.period ?? 'month']}`];
    const values = [...(inputs.volume && inputs.price ? [`volume=${v('volume')}`, `price=${v('price')}`] : []), `paying=${v('paying')}`, `plan=${v('plan')}`];
    return { expression: terms.join(' + '), values: values.join(', ') };
  };
  // Each derived figure with its calc working, worked again on every call.
  const work = {
    mrr() {
      if (mixed) { const r = revenue(); return calculate(cents(r.expression), r.values); }
      if (!inputs.price || !inputs.paying || !nets) return undefined;
      return calculate(cents(`paying * ${priceTerm()}`), `paying=${v('paying')}, price=${v('price')}`);
    },
    net() {
      if (inputs.net) return calculate(`net${TO_MONTH[inputs.net.period ?? 'month']}`, `net=${v('net')}`);
      if (mixed && inputs.burn) { const r = revenue(); return calculate(cents(`${burnTerm('burn')} - (${r.expression})`), `burn=${v('burn')}, ${r.values}`); }
      if (!inputs.burn || !inputs.price || !inputs.paying || !nets) return undefined;
      const b = burnName();
      return inputs.cost
        ? calculate(cents(`${burnTerm(b)} - paying * (${priceTerm()} - ${costTerm()})`), `${b}=${v('burn')}, paying=${v('paying')}, price=${v('price')}, cost=${v('cost')}`)
        : calculate(cents(`${burnTerm(b)} - paying * ${priceTerm()}`), `${b}=${v('burn')}, paying=${v('paying')}, price=${v('price')}`);
    },
    gross() {
      if (!inputs.cash || !inputs.burn) return undefined;
      return calculate(`round(cash / ${wrap(burnTerm('burn'))}, 1)`, `cash=${v('cash')}, burn=${v('burn')}`);
    },
    runway() {
      if (!inputs.cash) return undefined;
      if (inputs.net) return calculate(`round(cash / net${TO_MONTH[inputs.net.period ?? 'month']}, 1)`, `cash=${v('cash')}, net=${v('net')}`);
      if (!inputs.burn) return undefined;
      if (mixed) { const r = revenue(); return calculate(`round(cash / (${burnTerm('burn')} - (${r.expression})), 1)`, `cash=${v('cash')}, burn=${v('burn')}, ${r.values}`); }
      if (!nets || !inputs.price || !inputs.paying) return calculate(`round(cash / ${wrap(burnTerm('burn'))}, 1)`, `cash=${v('cash')}, burn=${v('burn')}`);
      const b = burnName();
      return inputs.cost
        ? calculate(`round(cash / (${burnTerm(b)} - paying * (${priceTerm()} - ${costTerm()})), 1)`, `cash=${v('cash')}, ${b}=${v('burn')}, paying=${v('paying')}, price=${v('price')}, cost=${v('cost')}`)
        : calculate(`round(cash / (${burnTerm(b)} - paying * ${priceTerm()}), 1)`, `cash=${v('cash')}, ${b}=${v('burn')}, paying=${v('paying')}, price=${v('price')}`);
    },
    contribution() {
      if (mixed) return calculate(`plan${TO_MONTH[inputs.plan!.period ?? 'month']}`, `plan=${v('plan')}`);
      if (!inputs.price) return undefined;
      return inputs.cost ? calculate(`${priceTerm()} - ${costTerm()}`, `price=${v('price')}, cost=${v('cost')}`) : calculate(priceTerm(), `price=${v('price')}`);
    },
    breakEven() {
      // In paying customers on the plan, the jobs' stream held where it stands: never under none.
      if (mixed && inputs.burn) {
        const plan = `plan${TO_MONTH[inputs.plan!.period ?? 'month']}`;
        return inputs.volume && inputs.price
          ? calculate(`max(0, ceil((${burnTerm('burn')} - ${volumeTerm()}) / ${wrap(plan)}))`, `burn=${v('burn')}, volume=${v('volume')}, price=${v('price')}, plan=${v('plan')}`)
          : calculate(`ceil(${burnTerm('burn')} / ${wrap(plan)})`, `burn=${v('burn')}, plan=${v('plan')}`);
      }
      if (!inputs.price || !inputs.burn) return undefined;
      const b = burnName();
      if (inputs.cost) {
        const each = work.contribution()!;
        if (each.value <= 0) return { ...each, value: Infinity, losing: true as const };
        return calculate(`ceil(${burnTerm(b)} / (${priceTerm()} - ${costTerm()}))`, `${b}=${v('burn')}, price=${v('price')}, cost=${v('cost')}`);
      }
      return calculate(`ceil(${burnTerm(b)} / ${wrap(priceTerm())})`, `${b}=${v('burn')}, price=${v('price')}`);
    },
  };
  const netValue = () => { const n = work.net(); return n?.value; };
  const cashPositive = () => { const n = netValue(); return n !== undefined && n <= 0 && !inputs.net; };
  const state: EconomicsState = {
    inputs, unit, ...(currency ? { currency } : {}), perJob: !!per && !mixed, streams: mixed ? 2 : 1, ...(mixed && heldSaid() ? { held: `at ${heldSaid()}` } : {}),
    monthly,
    snapshot: () => Object.fromEntries(Object.entries(inputs).map(([field, one]) => [field, { value: one!.value, ...(one!.period ? { period: one!.period } : {}) }])) as Snapshot,
    mrr: () => work.mrr()?.value,
    net: netValue,
    cashPositive,
    runway() {
      const gross = work.gross();
      if (cashPositive()) return { value: Infinity, display: 'cash-positive', ...(gross ? { gross: { value: gross.value, display: gross.display } } : {}) };
      const one = work.runway();
      return one ? { value: one.value, display: one.display } : undefined;
    },
    breakEven: () => work.breakEven()?.value,
    current: () => inputs.paying?.value,
    gap() { const even = state.breakEven(); const now = state.current(); return even === undefined || now === undefined || !Number.isFinite(even) ? undefined : Math.max(0, even - now); },
    killDistance(line, below, value = state.current()) { return value === undefined ? undefined : below ? value - line : line - value; },
    side(value = state.current()) {
      const even = state.breakEven();
      if (even === undefined || value === undefined || !Number.isFinite(even) || (per && !mixed)) return undefined;
      return value > even ? 'above' : value < even ? 'below' : 'at';
    },
    explain: () => state.economics()?.working.map((one) => one.line) ?? [],
    founderLines: () => Object.entries(inputs).filter(([, one]) => one!.source === 'founder').map(([field, one]) => `- ${one!.label}: ${shown(field as Field, one!, currency)} (founder${one!.day ? `, ${one!.day}` : ''}: "${one!.said.slice(0, 160)}")`),
    economics() {
      const working: Working[] = [];
      const out: Economics = { working };
      if (currency) out.currency = currency;
      const push = (label: Working['label'], worked: { worked: string; display: string }, line: (display: string) => string) => {
        const result = `${worked.worked} = ${worked.display}`;
        working.push({ label, expression: '', values: '', result, line: `${label}: ${line(result)}` });
      };
      const n = inputs.paying?.value;
      if (n !== undefined && inputs.paying) { out.current = n; out.unit = unit; }
      if (per) out.unit = unit;
      const units = out.unit ?? 'paying customers';
      const have = n === undefined ? '' : per && !mixed ? `; the brief has ${n} (${inputs.paying!.label.toLowerCase()})` : `; we have ${n}`;
      const p = inputs.price?.period ?? 'month';
      const converted = p !== 'month' || cashPositive();
      const mrr = work.mrr();
      if (mrr && mixed) push('MRR', mrr, (result) => `${result} a month from ${[heldSaid() ? `${heldSaid()} at ${money(v('price'), currency)}` : '', `${n} ${units} at ${money(v('plan'), currency)} ${periodName(inputs.plan!.period)}`].filter(Boolean).join(' and ')}`);
      else if (mrr && converted) push('MRR', mrr, (result) => `${result} a month from ${n} ${units} at ${money(v('price'), currency)} ${periodName(p)}`);
      const even = work.breakEven();
      if (even && 'losing' in even) {
        push('Break-even', even, (result) => `${result} a month on each of the ${units}: each one loses money, so no count breaks even`);
        out.breakEven = Infinity;
      } else if (even) {
        if (mixed) push('Break-even', even, (result) => `${result} ${units} to cover the burn${heldSaid() ? ` with ${heldSaid()} at ${money(v('price'), currency)} held where they are` : ` (the brief gives no ${per} a month)`}${have}`);
        else push('Break-even', even, (result) => `${result} ${units} to cover ${inputs.cost ? 'fixed costs' : `the burn (the brief gives no cost per unit)`}${have}`);
        out.breakEven = even.value;
      }
      const net = work.net();
      if (net && cashPositive()) push('Net burn', net, (result) => `${result} a month: more comes in than goes out, so the company is cash-positive`);
      else if (net && (p !== 'month' || mixed) && !inputs.net) push('Net burn', net, (result) => `${result} a month`);
      const gross = work.gross();
      if (cashPositive() && gross) {
        push('Runway', gross, (result) => `cash-positive, so the cash does not run down at the net; at the gross burn alone ${result} months`);
        out.runway = { value: Infinity, display: 'cash-positive', gross: { value: gross.value, display: gross.display } };
      } else {
        const runway = work.runway();
        if (runway) {
          const atNet = !!inputs.net || (nets && !!inputs.price && !!inputs.paying);
          push('Runway', runway, (result) => `${result} months at the ${atNet ? 'net ' : ''}burn${!nets && !inputs.net ? ` (the brief gives no ${per} a month to net it)` : ''}`);
          out.runway = { value: runway.value, display: runway.display };
        }
      }
      // The calc tool's own expression and values for each line, for the turn's tools.
      for (const one of working) {
        const sum = one.label === 'MRR' ? mrr : one.label === 'Break-even' ? even : one.label === 'Net burn' ? net : out.runway && !Number.isFinite(out.runway.value) ? gross : work.runway();
        const expr = exprs.get(sum as object);
        if (expr) { one.expression = expr.expression; one.values = expr.values; }
      }
      const inputsOut: Inputs = { price: monthly('price'), cost: monthly('cost'), fixed: monthly('burn'), net: inputs.net ? monthly('net') : undefined, cash: inputs.cash?.value, paying: n };
      out.inputs = Object.fromEntries(Object.entries(inputsOut).filter(([, value]) => value !== undefined)) as Inputs;
      return working.length ? out : null;
    },
  };
  return state;
}
// The expression and values each worked sum came from, so the working rides as the calc tool's own call.
const exprs = new WeakMap<object, { expression: string; values: string }>();
function calculate(expression: string, values: string) {
  const out = calc(expression, values);
  exprs.set(out, { expression, values });
  return out;
}
const money = (value: number, currency = '') => `${value < 0 ? '-' : ''}${currency}${Math.abs(Math.round(value * 100) / 100).toLocaleString('en-US')}`;
const shown = (field: Field, one: Input, currency = '') => (isMoney(field) ? `${money(one.value, currency)} ${one.per && !one.period ? `per ${one.per}` : periodName(one.period)}` : String(one.value));

// The working from the Company brief's Numbers section, or nothing when it does not hold enough to work anything out.
export function economicsOf(numbers: string, given: Parameters<typeof stateOf>[1] = {}): Economics | null {
  return stateOf(numbers, given).economics();
}

// What moved between the inputs a call was made on and the inputs now: any change of a value or a period.
export type Changed = { field: Field; label: string; from?: { value: number; period?: Period }; to?: { value: number; period?: Period }; said?: string; per?: string };
export function changedSince(then: Snapshot, state: EconomicsState): Changed[] {
  const now = state.snapshot();
  return (Object.keys(LABELS) as Field[]).flatMap((field): Changed[] => {
    const [a, b] = [then[field], now[field]];
    if (!a && !b) return [];
    if (a && b && Math.abs(a.value - b.value) < 1e-9 && (a.period ?? 'month') === (b.period ?? 'month')) return [];
    const one = state.inputs[field];
    return [{ field, label: one?.label.toLowerCase() ?? LABELS[field], ...(a ? { from: a } : {}), ...(b ? { to: b } : {}), ...(one?.source === 'founder' ? { said: one.said } : {}), ...(one?.per ? { per: one.per } : {}) }];
  });
}
// "paying subscribers 14 → 11 (founder: "...")", "price €59 a month → €59 a week".
export function changedLine(one: Changed, currency = ''): string {
  // "€4 per booking → €4.6 per booking": a price per job is never said a month (journey 20).
  const say = (it?: { value: number; period?: Period }) => (!it ? 'not given' : isMoney(one.field) ? `${money(it.value, currency)} ${one.per && !it.period ? `per ${one.per}` : periodName(it.period)}` : String(it.value));
  return `${one.label} ${say(one.from)} → ${say(one.to)}${one.said ? ` (founder: "${one.said.slice(0, 120)}")` : ''}`;
}

// Break-even said on the wrong side: "further below break-even" at 9.5 paying with break-even 8. The side is worked
// out from the numbers in every sentence that names one; the words around it stay.
const SIDE = /\b(?:(?:further|still|well|far|just|now)\s+)?(below|under|short of|beneath|above|over|past|beyond)\s+(?:the\s+)?break[- ]?even(?:\s+point)?\b/gi;
export function breakEvenFix(text: string, state: EconomicsState | null | undefined): string {
  if (!state) return text;
  text = gapFix(text, state);
  const side = state.side();
  const even = state.breakEven();
  if (!side || even === undefined || side === 'at') return text;
  const now = state.current()!;
  return text.replace(SIDE, (whole, word: string) => {
    const says = /^(?:below|under|short of|beneath)$/i.test(word) ? 'below' : 'above';
    return says === side ? whole : `${side} break-even (${now} ${state.unit} against ${even})`;
  });
}
// Journey 19: brief 9 paying, 22 trials, break-even 38, and the partner said "closing just 16 of them will bridge the
// gap to break-even" three times: 9 + 16 is the goal of 25, not 38, and 29 more are needed, more than every trial on
// record. The calc lines were right; the sentence around them was not checked. A sentence that does arithmetic on the
// gap to break-even (a count to close it, the gap itself, the trials reaching it) is held to the state: when its
// numbers contradict it, the sentence becomes the state's own line.
const TRIAL = /\btrials?\b|\btrial users?\b|\bon trial\b/i;
const GAP_COUNT = /\b(?:clos\w*|convert\w*|sign\w*|win\w*|land\w*|add\w*|need\w*|turn\w*)\s+(?:just\s+|only\s+|another\s+|the\s+)?(\d+)(?![\d%]|[.,]\d)|\b(\d+)(?![\d%]|[.,]\d)\s+(?:of\s+(?:them|those|these|the\s+(?:\d+\s+)?trials?\b|our\s+trials?\b)|more\b|additional\b|new\b|(?:are\s+|is\s+)?(?:needed|required|to go)\b)|\bgap\s+(?:is|of|stands at|sits at)\s+(?:only\s+|just\s+)?(\d+)(?![\d%]|[.,]\d)/gi;
const REACHES = /\b(?:bridg\w*|clos\w*\s+(?:the\s+)?gap|reach\w*|get\w*\s+(?:us\s+)?to|hit\w*|cover\w*|enough|provid\w*\s+(?:the\s+)?pipeline|take\w*\s+us\s+to|push\w*\s+us\s+(?:to|past|over))\b/i;
const CANNOT = /\b(?:cannot|can't|can not|could not|couldn't|not enough|too few|short of|fall\w*\s+short|alone|even if all|only\s+\d+\s+trials?|fewer than)\b/i;
export function gapLine(state: EconomicsState): string | undefined {
  const even = state.breakEven();
  const now = state.current();
  const gap = state.gap();
  if (even === undefined || now === undefined || gap === undefined || !Number.isFinite(even)) return undefined;
  const trials = trialsOf(state);
  const tail = trials === undefined ? '' : trials < gap ? `; the ${trials} trials cannot close it alone` : `; ${gap} of the ${trials} trials would have to convert to close it`;
  return `Break-even is ${even} ${state.unit}${state.held ? ` ${state.held}` : ''}; ${now} pay now, gap ${gap}${tail}.`;
}
const trialsOf = (state: EconomicsState) => { const one = state.inputs.subscribers; return one && TRIAL.test(one.label) ? one.value : undefined; };
export function gapFix(text: string, state: EconomicsState | null | undefined): string {
  if (!state) return text;
  const even = state.breakEven();
  const gap = state.gap();
  const line = gapLine(state);
  if (even === undefined || gap === undefined || !line || gap === 0) return text;
  const trials = trialsOf(state);
  const evenSaid = new RegExp(`\\bbreak[- ]?even\\b|(?<![\\d.,])${even}(?![\\d%]|[.,]\\d)`, 'i');
  let said = false;
  return text.split('\n').map((row) => row.replace(/[^.!?\n]+[.!?]*/g, (sentence) => {
    // The working itself, and a sum on another price or cost ("at €39, break-even is 29"), stay.
    if (!evenSaid.test(sentence) || /=/.test(sentence) || /[$€£]\s?\d/.test(sentence) || /\bif\b[^.]*\b(?:price|cost|burn)\b/i.test(sentence)) return sentence;
    const counts = [...sentence.matchAll(GAP_COUNT)].map((hit) => Number(hit[1] ?? hit[2] ?? hit[3])).filter((value) => Number.isFinite(value) && value !== even);
    const wrongCount = counts.some((value) => value !== gap && value !== trials) && (REACHES.test(sentence) || /\b(?:needed|required|to go|gap)\b/i.test(sentence));
    const trialsReach = trials !== undefined && trials < gap && TRIAL.test(sentence) && REACHES.test(sentence) && !CANNOT.test(sentence);
    if (!wrongCount && !trialsReach) return sentence;
    const lead = /^\s*/.exec(sentence)![0];
    if (said) return '';
    said = true;
    return `${lead}${line}`;
  })).join('\n').replace(/[ \t]{2,}/g, ' ');
}

// The one line on break-even for an unasked note, from the numbers alone.
export function breakEvenLine(state: EconomicsState | null | undefined, value?: number): string | undefined {
  if (!state) return undefined;
  const even = state.breakEven();
  const side = state.side(value);
  if (even === undefined || !side) return undefined;
  const now = value ?? state.current();
  return `Break-even is ${even} ${state.unit}${state.held ? ` ${state.held}` : ''}; ${now} is ${side === 'at' ? 'right at it' : `${side} it`}${state.cashPositive() && value === undefined ? ', and the company is cash-positive' : ''}.`;
}

// Journey 19: "Unsourced figures: €839" under the verdict for the net burn worked out on the line before it, and "Not
// worked out: €261" beside "9 × €29 = €261"; the next morning's risk was the false footer. The working is added to the
// turn after the truth net has looked, so the net never saw it. The state's figures go into every partner turn as a
// source of their own, worked with calc from the brief, so a figure the state holds is never flagged.
export function stateFigures(state: EconomicsState | null | undefined): string {
  if (!state) return '';
  const currency = state.currency ?? '';
  const said: string[] = [];
  const mrr = state.mrr();
  const net = state.net();
  const runway = state.runway();
  const even = state.breakEven();
  const now = state.current();
  const gap = state.gap();
  if (mrr !== undefined) said.push(`MRR ${money(mrr, currency)} a month`);
  if (net !== undefined) said.push(`net burn ${money(net, currency)} a month`);
  if (runway) said.push(`runway ${runway.display}${Number.isFinite(runway.value) ? ' months' : ''}`);
  if (even !== undefined && Number.isFinite(even)) said.push(`break-even ${even} ${state.unit}${state.held ? ` ${state.held}` : ''}`);
  if (now !== undefined) said.push(`${now} ${state.unit} now`);
  if (gap !== undefined && gap > 0) said.push(`gap to break-even ${gap}`);
  return said.length ? `The company's figures, worked with calc from the Company brief: ${said.join('; ')}.` : '';
}

// Break-even far above where the company stands: more than twice the count today.
export const wideGap = (economics: Economics | null | undefined) => !!economics && economics.breakEven !== undefined
  && economics.current !== undefined && economics.breakEven > Math.max(economics.current * 2, economics.current + 2);

// Whether a reply says how the gap to break-even closes: it names break-even (or its number) beside a way to close it.
export function saysGap(text: string, economics: Economics): boolean {
  const named = /break[- ]?even/i.test(text) || (Number.isFinite(economics.breakEven) && new RegExp(`(?<![\\d.])${economics.breakEven}(?![\\d])`).test(text));
  return named && /\b(?:price|pricing|charge|raise|cost|margin|cut|bigger|larger|upsell|boxes|grow|reach|sign|close|by\s+20\d\d|within|months?)\b/i.test(text);
}

// What the partner is told before judging, with the working to quote.
export function economicsBlock(economics: Economics): string {
  const lines = economics.working.map((one) => `- ${one.line}`);
  const gap = wideGap(economics) ? `\nBreak-even is ${economics.breakEven} ${economics.unit} and the company has ${economics.current}: "keep going" is only a call if you say in Why how that gap closes (price, cost, or reaching ${economics.breakEven} by when).` : '';
  return `Worked from the Company brief's Numbers with calc, before you judge. Put these lines under Why exactly as written:\n${lines.join('\n')}${gap}`;
}

// The working as the calc tool's own results, so they sit with the turn's tools and back the figures in the reason.
export const workingTools = (economics: Economics, id: (index: number) => string): ToolEvent[] => economics.working.map((one, index) => ({
  id: id(index), name: 'calc', args: { expression: one.expression, values: one.values }, ok: true, result: one.result,
}));

// ---------------------------------------------------------------- the partner's own words held to the working

// Journey 14: the partner told the founder "your runway is 4.4 months (not 5)", cash over the gross burn, overruling a
// colleague's right 4.99 (net of the €98 coming in); the morning note then called 4.4 confirmed. Runway and break-even
// in what the partner says come from the working above, never from the model: a figure that differs is put right in
// place, and a "(not …)" correction beside it goes with it. A what-if ("at €69 runway would be 7 months") is the
// model's own sum on other inputs and stays.
const WHAT_IF = /\b(?:if|would|could|after|assum\w*|instead|scenario|once|at\s+[$€£]\s?\d|raising|raise|cut\w*|new)\b/i;
const MONTHS_SAID = /(\d+(?:\.\d+)?)(\s?(?:-|–)?\s?months?\b)(\**)(\s*\(not [^)]*\))?/gi;
const RUNWAY_SAID = /\brunway\b|\bmonths? of (?:cash|money|runway)\b|\bcash (?:lasts|runs out)\b/i;
const EVEN_SAID = /(\bbreak[- ]?even(?:\s+(?:is|sits|comes|lands|point|means|needs|requires|takes)|\s*:)*\s+(?:is\s+|at\s+|of\s+)?(?:~|about\s+|around\s+|roughly\s+)?(?:\*\*)?)(\d+)(?![\d.,]|\s*%)(\**)(\s*\(not [^)]*\))?/gi;
export function figuresFix(text: string, economics: Economics | null | undefined): string {
  if (!economics) return text;
  const runway = economics.runway;
  const even = economics.breakEven !== undefined && Number.isFinite(economics.breakEven) ? economics.breakEven : undefined;
  if (!runway && even === undefined) return text;
  return text.split('\n').map((line) => line.split(/(?<=[.!?])\s+/).map((sentence) => {
    // A what-if, and the working itself ("ceil(900 / 49) = 19"), stay as they are.
    if (WHAT_IF.test(sentence) || /=/.test(sentence)) return sentence;
    let out = sentence;
    if (runway && RUNWAY_SAID.test(out)) {
      out = out.replace(MONTHS_SAID, (whole, figure: string, unit: string, stars: string, _not, at: number) => {
        // "3 to 4 months", "under 5 months": a span or a bound is not the runway figure.
        if (/(?:\d\s*(?:to|–|-)\s*|\b(?:under|over|at least|more than|less than|nearly|almost)\s*)$/i.test(out.slice(0, at))) return whole;
        // Cash-positive: the only months to say are the gross burn's, and that is said with them.
        if (!Number.isFinite(runway.value)) return !runway.gross || Math.abs(Number(figure) - runway.gross.value) < 0.1 ? whole : `${runway.gross.display}${unit}${stars} at the gross burn (cash-positive at the net)`;
        return Math.abs(Number(figure) - runway.value) < 0.1 ? whole : `${runway.display}${unit}${stars}`;
      });
    }
    if (even !== undefined) out = out.replace(EVEN_SAID, (whole, lead: string, figure: string, stars: string) => (Number(figure) === even ? whole : `${lead}${even}${stars}`));
    return out;
  }).join(' ')).join('\n');
}

// The Company brief's Runway and Break-even rows, as the working gives them: what any write to the brief keeps there,
// whatever the writer put ("Runway: 4.4 (unsourced) months (4,000 / 900, calc)" with no calc behind it, or "Runway =
// 4,000 / (900 − 98 (unsourced)) = 5.0 months (calc)" on the live check). A net burn the writer worked out ("Net burn =
// 900 − 98 = 802 (calc)") is set the same way; one the founder gave ("Net burn: $6,000 a month") is a figure, not a sum.
const DERIVED_ROW = /^(\s*[-*]\s+)(runway|break[- ]?even|net burn)\s*[:=].*$/i;
const WORKED_NET = /=|\bcalc\b/i;
const derived = (line: string) => { const found = DERIVED_ROW.exec(line); return !!found && (!/^net burn$/i.test(found[2]) || WORKED_NET.test(line.replace(/^[^:=]*[:=]/, ''))); };
// `numbers`: the section the working is read from, when `text` is the whole document.
export function derivedRows(text: string, numbers = text): { text: string; set: string[] } {
  const economics = economicsOf(numbers.split('\n').filter((line) => !derived(line)).join('\n'));
  if (!economics) return { text, set: [] };
  // Net of what the paying units bring in, as the one state works it (a week's price made a month's first).
  const netWorking = economics.working.find((each) => each.label === 'Net burn');
  const netSum = netWorking ?? (() => {
    const state = stateOf(numbers.split('\n').filter((line) => !derived(line)).join('\n'));
    const n = state.inputs.net ? undefined : state.net();
    if (n === undefined) return undefined;
    const worked = state.inputs.cost ? calc('burn - paying * (price - cost)', `burn=${state.monthly('burn')}, paying=${state.current()}, price=${state.monthly('price')}, cost=${state.monthly('cost')}`)
      : calc('burn - paying * price', `burn=${state.monthly('burn')}, paying=${state.current()}, price=${state.monthly('price')}`);
    return { result: `${worked.worked} = ${worked.display}` };
  })();
  const net = netSum ? { display: netSum.result.split(' = ').at(-1)!, worked: netSum.result.split(' = ').slice(0, -1).join(' = ') } : null;
  const set: string[] = [];
  const out = text.split('\n').map((line) => {
    if (!derived(line)) return line;
    const found = DERIVED_ROW.exec(line)!;
    const kind = /^runway$/i.test(found[2]) ? 'Runway' : /^net burn$/i.test(found[2]) ? 'Net burn' : 'Break-even';
    let row: string;
    if (kind === 'Net burn') {
      if (!net) return line;
      row = `${found[1]}Net burn: ${economics.currency ?? ''}${net.display} a month (calc: ${net.worked} = ${net.display})`;
    } else {
      const one = economics.working.find((each) => each.label === kind);
      if (!one || (kind === 'Break-even' && !Number.isFinite(economics.breakEven))) return line;
      const value = one.result.split(' = ').at(-1)!;
      row = kind === 'Runway' && economics.runway && !Number.isFinite(economics.runway.value)
        ? `${found[1]}Runway: cash-positive, more comes in than goes out; ${value} months at the gross burn alone (calc: ${one.result})`
        : `${found[1]}${kind}: ${value} ${kind === 'Runway' ? 'months' : economics.unit ?? 'paying customers'} (calc: ${one.result})`;
    }
    if (row !== line) set.push(row.trim().replace(/^[-*]\s+/, ''));
    return row;
  }).join('\n');
  // Runway and break-even said anywhere else the write added are held to the same working.
  return { text: out.split('\n').map((line) => (derived(line) ? line : figuresFix(line, economics))).join('\n'), set };
}
