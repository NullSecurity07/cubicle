// The Runway card: how much cash there is, what goes out and comes in each month, and when it runs out. Everything
// here is arithmetic the founder can check by hand, done in TypeScript and never by a model. It is not accounting:
// no taxes, no accruals, no timing inside a month beyond "spread evenly".

export const CATEGORIES = ['people', 'tools', 'rent', 'revenue', 'other'] as const;
export type Category = (typeof CATEGORIES)[number];
// One line of money a month. `monthly` is negative for money going out. `from` and `to` are months (YYYY-MM), both
// counted. `grows` is % a month, compounding from whichever is later: the flow's start or the month cash was counted.
export type Flow = { id: string; label: string; monthly: number; from: string; to?: string; grows?: number; category?: Category };
// A scenario is Base with changes: a flow added, a Base flow dropped (by id), or a one-off sum of cash in a month
// (a raise is positive, a one-off bill negative).
export type Change = { add: Flow } | { drop: string } | { cash: number; at: string };
export type Scenario = { id: string; name: string; changes: Change[] };
export type Runway = { cash: { amount: number; asOf: string /* YYYY-MM-DD */ }; flows: Flow[]; scenarios: Scenario[] };

// A person's suggestion, waiting for the founder to accept it on the card. `into` is a scenario's id when the flow
// belongs in one rather than in Base.
export type RunwayProposal = { id: string; by: string; roomId?: string; at: number; why?: string }
  & ({ kind: 'flow'; flow: Flow; into?: string } | { kind: 'scenario'; scenario: Scenario });
// The last threshold the card warned about. It is raised once per crossing and put away once the founder has seen it.
export type RunwayAlert = { level: 6 | 3; at: number; seen?: boolean };
// The whole sidecar, as the server keeps it in `workspace/runway/<cardId>.json`.
export type RunwayFile = Runway & { proposals?: RunwayProposal[]; alert?: RunwayAlert };
// What the card hears: the sidecar after every change. `rev` only ever grows.
export type RunwayEvent = { runway: Runway; proposals: RunwayProposal[]; alert?: RunwayAlert; rev: number };
export const runwayChannel = (cardId: string) => `runway:${cardId}`;

export const MAX_SCENARIOS = 3;
export const MAX_FLOWS = 60;
export const HORIZON = 24;
// How far to look for the day cash runs out, beyond the 24 months drawn.
const SEARCH = 120;
export const BASE = 'base';

// ---- months and days, as strings, in UTC so the machine's zone never moves a day.

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
const DAY = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
export const isMonth = (value: unknown): value is string => typeof value === 'string' && MONTH.test(value);
export const isDay = (value: unknown): value is string => typeof value === 'string' && DAY.test(value) && toDate(value).toISOString().slice(0, 10) === value;
const toDate = (day: string) => new Date(`${day}T00:00:00Z`);
const dayOf = (date: Date) => date.toISOString().slice(0, 10);
export const monthOf = (day: string) => day.slice(0, 7);
const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// A month as a founder types one: "2027-01", "1/2027", "Jan 2027", "January 2027". Null when it is not one.
export function readMonth(text: string): string | null {
  const said = text.trim().toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ');
  let found = /^(\d{4})[-/.](\d{1,2})$/.exec(said);
  const make = (year: string, month: number) => { const value = `${year}-${String(month).padStart(2, '0')}`; return isMonth(value) ? value : null; };
  if (found) return make(found[1], Number(found[2]));
  found = /^(\d{1,2})[-/.](\d{4})$/.exec(said);
  if (found) return make(found[2], Number(found[1]));
  found = /^([a-z]{3,9})\.? (\d{4})$/.exec(said);
  if (found) { const index = MONTH_NAMES.indexOf(found[1].slice(0, 3)); return index >= 0 && (found[1].length === 3 || found[1] === 'sept' || MONTH_WORD_FULL[index] === found[1]) ? make(found[2], index + 1) : null; }
  return null;
}
const MONTH_WORD_FULL = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
export function addMonths(month: string, count: number): string {
  const [year, number] = month.split('-').map(Number);
  const index = year * 12 + (number - 1) + count;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}
export function monthsBetween(from: string, to: string): number {
  const [a, b] = [from, to].map((month) => { const [year, number] = month.split('-').map(Number); return year * 12 + number; });
  return b - a;
}
export const daysIn = (month: string) => { const [year, number] = month.split('-').map(Number); return new Date(Date.UTC(year, number, 0)).getUTCDate(); };
export const addDays = (day: string, count: number) => dayOf(new Date(toDate(day).getTime() + count * 86_400_000));
export const daysBetween = (from: string, to: string) => Math.round((toDate(to).getTime() - toDate(from).getTime()) / 86_400_000);
export const todayOf = (at: number) => { const date = new Date(at); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; };
// The length of an average month in days, for saying a number of days as months.
export const MONTH_DAYS = 365.25 / 12;

// ---- what one plan (Base, or a scenario) spends each month.

export const categoryOf = (flow: Pick<Flow, 'monthly' | 'category'>): Category => flow.category ?? (flow.monthly > 0 ? 'revenue' : 'other');

// What a flow comes to in one month: nothing outside its months, and compounded from the later of its start and the
// month the cash was counted, so a revenue line entered as "what it is now" is not grown twice.
export function amountIn(flow: Flow, month: string, startMonth: string): number {
  if (monthsBetween(flow.from, month) < 0) return 0;
  if (flow.to && monthsBetween(month, flow.to) < 0) return 0;
  const since = monthsBetween(monthsBetween(flow.from, startMonth) > 0 ? startMonth : flow.from, month);
  return flow.monthly * (1 + (flow.grows ?? 0) / 100) ** Math.max(0, since);
}

export type Plan = { flows: Flow[]; oneOffs: { cash: number; at: string }[] };
// Base with a scenario's changes laid over it. An unknown scenario is Base.
export function planOf(runway: Runway, scenarioId?: string): Plan {
  const scenario = runway.scenarios.find((one) => one.id === scenarioId);
  if (!scenario) return { flows: runway.flows, oneOffs: [] };
  const dropped = new Set(scenario.changes.flatMap((change) => ('drop' in change ? [change.drop] : [])));
  return {
    flows: [...runway.flows.filter((flow) => !dropped.has(flow.id)), ...scenario.changes.flatMap((change) => ('add' in change ? [change.add] : []))],
    oneOffs: scenario.changes.flatMap((change) => ('cash' in change ? [{ cash: change.cash, at: change.at }] : [])),
  };
}

export type Projection = {
  // Month 0 is the month the cash was counted; its flows count for the days left in it after that day.
  start: string; series: { month: string; cash: number }[];
  // Month 0's money, whole-month amounts: gross burn out, revenue in, and burn by category (all positive numbers).
  burn: number; revenue: number; net: number; byCategory: Partial<Record<Category, number>>; growth: number;
  // The first day cash is not enough, and how many months that is from today. Both null when it is not in sight.
  zero: string | null; monthsLeft: number | null;
};

export function project(runway: Runway, scenarioId: string | undefined, today: string): Projection {
  const { flows, oneOffs } = planOf(runway, scenarioId);
  const asOf = isDay(runway.cash.asOf) ? runway.cash.asOf : today;
  const start = monthOf(asOf);
  const firstDays = daysIn(start) - Number(asOf.slice(8)) + 1;
  const first = firstDays / daysIn(start);

  const byCategory: Partial<Record<Category, number>> = {};
  let burn = 0;
  let revenue = 0;
  let grownRevenue = 0;
  for (const flow of flows) {
    const amount = amountIn(flow, start, start);
    if (!amount) continue;
    if (amount < 0) burn -= amount; else { revenue += amount; grownRevenue += amount * (flow.grows ?? 0); }
    const category = categoryOf(flow);
    byCategory[category] = (byCategory[category] ?? 0) + Math.abs(amount);
  }

  const series: Projection['series'] = [];
  let cash = runway.cash.amount;
  let zero: string | null = null;
  for (let index = 0; index < SEARCH && (index < HORIZON || !zero); index++) {
    const month = addMonths(start, index);
    const spanStart = index === 0 ? asOf : `${month}-01`;
    const span = index === 0 ? firstDays : daysIn(month);
    for (const one of oneOffs) if (one.at === month) cash += one.cash;
    if (!zero && cash < 0) zero = spanStart;
    const net = flows.reduce((sum, flow) => sum + amountIn(flow, month, start), 0) * (index === 0 ? first : 1);
    if (!zero && net < 0 && cash + net <= 0) zero = addDays(spanStart, Math.floor((cash / -net) * span));
    cash += net;
    if (index < HORIZON) series.push({ month, cash });
  }
  const monthsLeft = zero ? Math.max(0, daysBetween(today, zero)) / MONTH_DAYS : null;
  return { start, series, burn, revenue, net: burn - revenue, byCategory, growth: revenue ? grownRevenue / revenue : 0, zero, monthsLeft };
}

// The warning a runway deserves: red under three months, amber under six, nothing otherwise.
export const alertLevel = (monthsLeft: number | null): 6 | 3 | null => (monthsLeft === null ? null : monthsLeft < 3 ? 3 : monthsLeft < 6 ? 6 : null);

// ---- words and numbers.

export function money(amount: number, currency = 'USD'): string {
  const rounded = Math.round(amount);
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0, minimumFractionDigits: 0 }).format(rounded); }
  catch { return `${rounded.toLocaleString('en-US')} ${currency}`; }
}
export const months = (value: number) => `${value.toFixed(1)} month${value.toFixed(1) === '1.0' ? '' : 's'}`;
const pct = (value: number) => `${Number(value.toFixed(1))}%`;
const CATEGORY_ORDER: Category[] = ['people', 'tools', 'rent', 'other'];

// What a wired person reads each turn: a few compact lines, ending with the day they are true on.
export function runwayLine(runway: Runway, today: string, currency = 'USD'): string {
  if (!runway.cash.amount && !runway.flows.length) return `- A Runway card, still empty. Read it with read_runway; suggest lines with propose_flow and propose_scenario, the founder accepts. As of ${today}.`;
  const base = project(runway, undefined, today);
  const parts = CATEGORY_ORDER.filter((category) => base.byCategory[category]).map((category) => `${category} ${money(base.byCategory[category]!, currency)}`);
  const lines = [`- A Runway card (read_runway; propose_flow and propose_scenario go to the founder). Cash ${money(runway.cash.amount, currency)} on ${runway.cash.asOf}.`
    + ` Burn ${money(base.burn, currency)} a month${parts.length ? ` (${parts.join(', ')})` : ''}.`
    + (base.revenue ? ` Revenue ${money(base.revenue, currency)} a month${base.growth ? ` growing ${pct(base.growth)}` : ''}.` : '')
    + ` ${outcome(base)}.`];
  for (const scenario of runway.scenarios) lines.push(`Scenario "${scenario.name}": ${outcome(project(runway, scenario.id, today))}.`);
  return `${lines.join(' ')} As of ${today}.`;
}
function outcome(projection: Projection) {
  if (projection.zero && projection.monthsLeft !== null) return `${months(projection.monthsLeft)} left, cash out ${monthOf(projection.zero)}`;
  return projection.net <= 0 ? 'Cash does not run out: more comes in than goes out' : 'Cash does not run out within ten years';
}

// What read_runway returns: the summary, then each flow on its own line, then the cash at each quarter.
export function runwayDetail(runway: Runway, scenarioId: string | undefined, today: string, currency = 'USD'): string {
  const scenario = runway.scenarios.find((one) => one.id === scenarioId);
  const projection = project(runway, scenario?.id, today);
  const { flows, oneOffs } = planOf(runway, scenario?.id);
  const out = [`${scenario ? `Scenario "${scenario.name}"` : 'Base'}: cash ${money(runway.cash.amount, currency)} on ${runway.cash.asOf}. Burn ${money(projection.burn, currency)} a month, revenue ${money(projection.revenue, currency)}, net ${money(-projection.net, currency)}. ${outcome(projection)}.`];
  out.push(flows.length ? 'Flows:' : 'No flows yet.');
  for (const flow of flows) out.push(`- ${flow.label}: ${money(flow.monthly, currency)} a month from ${flow.from}${flow.to ? ` to ${flow.to}` : ''}${flow.grows ? `, growing ${pct(flow.grows)}` : ''} (${categoryOf(flow)})`);
  for (const one of oneOffs) out.push(`- One-off ${money(one.cash, currency)} in ${one.at}`);
  out.push(`Cash at the end of: ${projection.series.filter((_, index) => index % 3 === 2).map((point) => `${point.month} ${money(point.cash, currency)}`).join(', ')}.`);
  const others = runway.scenarios.filter((one) => one.id !== scenario?.id).map((one) => `"${one.name}"`);
  if (scenario || others.length) out.push(`Other plans: ${[...(scenario ? ['Base'] : []), ...others].join(', ')}.`);
  out.push(`Not accounting: no taxes or accruals. As of ${today}.`);
  return out.join('\n');
}

// A suggestion in a few words, the same in the tool's answer, in Needs you and on the card.
export function proposalTitle(proposal: RunwayProposal, flows: { id: string; label: string }[], currency: string): string {
  if (proposal.kind === 'flow') return `"${proposal.flow.label}", ${money(proposal.flow.monthly, currency)} a month from ${proposal.flow.from}${proposal.flow.to ? ` to ${proposal.flow.to}` : ''}${proposal.flow.grows ? ` growing ${proposal.flow.grows}%` : ''}`;
  const parts = proposal.scenario.changes.map((change) => ('add' in change ? `adds "${change.add.label}" ${money(change.add.monthly, currency)} a month from ${change.add.from}`
    : 'drop' in change ? `drops "${flows.find((flow) => flow.id === change.drop)?.label ?? 'a flow'}"` : `${change.cash < 0 ? 'pays' : 'brings in'} ${money(Math.abs(change.cash), currency)} in ${change.at}`));
  return `the scenario "${proposal.scenario.name}" (${parts.join('; ')})`;
}

// ---- cleaning what comes in, from the founder's window or from a person's tool call.

const words = (value: unknown, max: number) => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '');
const finite = (value: unknown) => (typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN);
const LIMIT = 1e12;
export const newRunwayId = (prefix: string) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function cleanFlow(input: unknown, fallbackMonth: string): Flow {
  const raw = (input ?? {}) as Record<string, unknown>;
  const label = words(raw.label, 80);
  if (!label) throw new Error('a flow needs a label');
  const monthly = finite(raw.monthly);
  if (!Number.isFinite(monthly) || Math.abs(monthly) > LIMIT) throw new Error(`"${label}" needs a monthly amount (negative for money out)`);
  const from = isMonth(raw.from) ? raw.from : fallbackMonth;
  const to = isMonth(raw.to) ? raw.to : undefined;
  if (to && monthsBetween(from, to) < 0) throw new Error(`"${label}" ends before it starts`);
  const grows = finite(raw.grows);
  const category = (CATEGORIES as readonly unknown[]).includes(raw.category) ? (raw.category as Category) : undefined;
  const id = typeof raw.id === 'string' && /^[a-z0-9-]{1,40}$/.test(raw.id) ? raw.id : newRunwayId('flow');
  return { id, label, monthly: Math.round(monthly * 100) / 100, from, ...(to ? { to } : {}), ...(Number.isFinite(grows) && grows ? { grows: Math.max(-100, Math.min(100, grows)) } : {}), ...(category ? { category } : {}) };
}

export function cleanScenario(input: unknown, fallbackMonth: string, baseIds: Set<string>): Scenario {
  const raw = (input ?? {}) as Record<string, unknown>;
  const name = words(raw.name, 60);
  if (!name) throw new Error('a scenario needs a name');
  const changes: Change[] = [];
  for (const change of Array.isArray(raw.changes) ? raw.changes.slice(0, 40) : []) {
    const one = (change ?? {}) as Record<string, unknown>;
    if (one.add) changes.push({ add: cleanFlow(one.add, fallbackMonth) });
    else if (typeof one.drop === 'string' && baseIds.has(one.drop)) changes.push({ drop: one.drop });
    else if ('cash' in one) {
      const cash = finite(one.cash);
      if (!Number.isFinite(cash) || Math.abs(cash) > LIMIT || !isMonth(one.at)) throw new Error('a one-off needs an amount and a month (YYYY-MM)');
      changes.push({ cash: Math.round(cash), at: one.at });
    }
  }
  const id = typeof raw.id === 'string' && /^[a-z0-9-]{1,40}$/.test(raw.id) && raw.id !== BASE ? raw.id : newRunwayId('plan');
  return { id, name, changes };
}

export function cleanRunway(input: unknown, today: string): Runway {
  const raw = (input ?? {}) as Record<string, unknown>;
  const cash = (raw.cash ?? {}) as Record<string, unknown>;
  const amount = finite(cash.amount);
  const asOf = isDay(cash.asOf) ? cash.asOf : today;
  const month = monthOf(asOf);
  const flows = (Array.isArray(raw.flows) ? raw.flows : []).slice(0, MAX_FLOWS).map((flow) => cleanFlow(flow, month));
  if (new Set(flows.map((flow) => flow.id)).size !== flows.length) throw new Error('two flows share an id');
  const ids = new Set(flows.map((flow) => flow.id));
  const scenarios = (Array.isArray(raw.scenarios) ? raw.scenarios : []).map((scenario) => cleanScenario(scenario, month, ids));
  if (scenarios.length > MAX_SCENARIOS) throw new Error(`at most ${MAX_SCENARIOS} scenarios beside Base`);
  return { cash: { amount: Number.isFinite(amount) && Math.abs(amount) <= LIMIT ? Math.round(amount) : 0, asOf }, flows, scenarios };
}
export const emptyRunway = (today: string): Runway => ({ cash: { amount: 0, asOf: today }, flows: [], scenarios: [] });

// ---- the numbers as a spreadsheet: one row a month, each Base flow's amount, then each plan's cash at month end.

const cell = (value: unknown) => {
  const text = value === undefined || value === null ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
const round2 = (value: number) => Math.round(value * 100) / 100;
export function runwayCsv(runway: Runway, today: string): string {
  const base = project(runway, undefined, today);
  const plans = runway.scenarios.map((scenario) => project(runway, scenario.id, today));
  const head = ['month', ...runway.flows.map((flow) => flow.label), 'net (Base)', 'cash at month end (Base)', ...runway.scenarios.map((one) => `cash at month end (${one.name})`)];
  const rows = base.series.map((point, index) => {
    const share = index === 0 ? (daysIn(base.start) - Number((isDay(runway.cash.asOf) ? runway.cash.asOf : today).slice(8)) + 1) / daysIn(base.start) : 1;
    const amounts = runway.flows.map((flow) => round2(amountIn(flow, point.month, base.start) * share));
    return [point.month, ...amounts, round2(amounts.reduce((sum, one) => sum + one, 0)), round2(point.cash), ...plans.map((plan) => round2(plan.series[index].cash))];
  });
  return `${[head, ...rows].map((row) => row.map(cell).join(',')).join('\n')}\n`;
}

// ---- a bank statement pasted as CSV, grouped into candidate flows the founder ticks one by one.

export type BankRow = { month: string; description: string; amount: number };
export type Candidate = { key: string; label: string; monthly: number; count: number; months: number; category: Category };
export type BankRead = { candidates: Candidate[]; rows: number; skipped: number; months: number };

function splitLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') { field += '"'; index++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === sep) { out.push(field.trim()); field = ''; }
    else field += char;
  }
  out.push(field.trim());
  return out;
}

export function parseAmount(raw: string): number {
  let text = raw.trim().replace(/[^\d,.()+-]/g, '');
  if (!text) return NaN;
  const negative = /^\(.*\)$/.test(text) || text.startsWith('-') || text.endsWith('-');
  text = text.replace(/[()+-]/g, '');
  // "1.234,56" and "12,50" are a decimal comma; "1,234.56" and "1,234" are thousands.
  if (/,\d{1,2}$/.test(text)) text = text.replace(/\./g, '').replace(',', '.');
  else text = text.replace(/,/g, '');
  const value = Number(text);
  return Number.isFinite(value) ? (negative ? -value : value) : NaN;
}

// The month a bank's date falls in. `order` says which of two short numbers is the month, worked out once per file.
function monthOfBank(raw: string, order: 'dmy' | 'mdy'): string | null {
  const text = raw.trim();
  let found = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(text);
  if (found) return month2(found[1], found[2]);
  found = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/.exec(text);
  if (!found) return null;
  const year = found[3].length === 2 ? `20${found[3]}` : found[3];
  return month2(year, order === 'dmy' ? found[2] : found[1]);
}
const month2 = (year: string, month: string) => { const number = Number(month); return number >= 1 && number <= 12 ? `${year}-${String(number).padStart(2, '0')}` : null; };

const TOOL_WORDS = /\b(aws|amazon web|google|gcp|github|gitlab|slack|notion|figma|vercel|netlify|heroku|openai|anthropic|atlassian|jira|linear|zoom|adobe|microsoft|dropbox|cloudflare|digitalocean|stripe fee|hubspot|intercom|mailchimp|zapier|saas|subscription)\b/i;
const PEOPLE_WORDS = /\b(team|engineers?|hires?|hiring|founders?|payroll|salary|salaries|wages|gusto|deel|remote\.com|rippling|contractor|upwork|freelance|pension|benefits)\b/i;
const RENT_WORDS = /\b(rent|lease|wework|office|coworking|landlord)\b/i;
export function guessCategory(description: string, amount: number): Category {
  if (amount > 0) return 'revenue';
  if (PEOPLE_WORDS.test(description)) return 'people';
  if (RENT_WORDS.test(description)) return 'rent';
  if (TOOL_WORDS.test(description)) return 'tools';
  return 'other';
}
// Two lines are the same payee when their words match once numbers, dates and reference codes are taken out.
// Month names go too, so "Rent June" and "Rent July" are one line.
const MONTH_WORDS = new Set('jan feb mar apr may jun jul aug sep sept oct nov dec january february march april june july august september october november december januar februar maerz mai juni juli oktober dezember'.split(' '));
export const payeeKey = (description: string) => description.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter((word) => word.length > 1 && !MONTH_WORDS.has(word)).slice(0, 3).join(' ');

export function readBank(text: string): BankRead {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return { candidates: [], rows: 0, skipped: 0, months: 0 };
  const sep = [',', ';', '\t'].map((one) => [one, lines[0].split(one).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const head = splitLine(lines[0], sep).map((one) => one.toLowerCase());
  const find = (pattern: RegExp) => head.findIndex((one) => pattern.test(one));
  let date = find(/date|datum|fecha|posted|booking|valuta/);
  let description = find(/desc|details|memo|narrative|payee|merchant|name|reference|particulars|text/);
  let amount = find(/^amount|amount$|^value|betrag|sum/);
  const debit = find(/debit|withdraw|paid out|money out|out$/);
  const credit = find(/credit|deposit|paid in|money in|in$/);
  // "Debit amount" is a debit column, not the amount.
  if (amount >= 0 && (amount === debit || amount === credit)) amount = -1;
  let body = lines.slice(1);
  // No header row: the first row is data, read as date, description, amount.
  if (date < 0 && description < 0 && amount < 0 && debit < 0) { date = 0; description = 1; amount = 2; body = lines; }
  const rows = body.map((line) => splitLine(line, sep));
  const shorts = rows.map((row) => /^(\d{1,2})[-/.](\d{1,2})[-/.]/.exec(row[date] ?? '')).filter(Boolean) as RegExpExecArray[];
  // A day over twelve settles it; otherwise dotted dates are European (day first) and slashed ones American.
  const order = shorts.some((one) => Number(one[1]) > 12) ? 'dmy' : shorts.some((one) => Number(one[2]) > 12) ? 'mdy' : shorts.some((one) => one[0].includes('.')) ? 'dmy' : 'mdy';

  const read: BankRow[] = [];
  let skipped = 0;
  for (const row of rows) {
    const month = monthOfBank(row[date] ?? '', order);
    const words = (row[description] ?? '').replace(/\s+/g, ' ').trim();
    let value = amount >= 0 ? parseAmount(row[amount] ?? '') : NaN;
    if (!Number.isFinite(value) && (debit >= 0 || credit >= 0)) {
      const out = debit >= 0 ? parseAmount(row[debit] ?? '') : NaN;
      const in_ = credit >= 0 ? parseAmount(row[credit] ?? '') : NaN;
      value = (Number.isFinite(in_) ? Math.abs(in_) : 0) - (Number.isFinite(out) ? Math.abs(out) : 0);
      if (!Number.isFinite(out) && !Number.isFinite(in_)) value = NaN;
    }
    if (!month || !words || !Number.isFinite(value) || value === 0) { skipped++; continue; }
    read.push({ month, description: words, amount: value });
  }
  const span = new Set(read.map((row) => row.month)).size;
  const groups = new Map<string, BankRow[]>();
  for (const row of read) {
    const key = `${payeeKey(row.description) || row.description.toLowerCase()}|${row.amount > 0 ? 'in' : 'out'}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const candidates = [...groups.entries()].map(([key, group]): Candidate => {
    const total = group.reduce((sum, row) => sum + row.amount, 0);
    const counts = new Map<string, number>();
    for (const row of group) counts.set(row.description, (counts.get(row.description) ?? 0) + 1);
    const label = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0][0].slice(0, 80);
    return { key, label, monthly: Math.round(total / Math.max(1, span)), count: group.length, months: new Set(group.map((row) => row.month)).size, category: guessCategory(label, total) };
  }).filter((one) => one.monthly !== 0).sort((a, b) => Math.abs(b.monthly) - Math.abs(a.monthly));
  return { candidates, rows: read.length, skipped, months: span };
}
