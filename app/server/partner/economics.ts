import type { ToolEvent } from '../../shared/model.ts';
import { calculate } from '../tools/calc.ts';

// Journey 13: asked "keep going, pivot or stop?", the partner said "keep going" for a goal of 10 paying offices while
// the brief's own numbers (price €240, cost €178 an office, burn €2,100) put break-even at 34. It saw it only when the
// founder pushed. Before the partner judges, the brief's Numbers are worked out here with the calc tool: break-even
// (fixed costs over what each paying unit leaves) and runway (cash over net burn). The working goes into the verdict's
// reason as calc results, so the truth guard backs every figure, and a "keep going" far below break-even has to say
// how the gap closes.

type Row = { label: string; line: string; amounts: { value: number; at: number }[] };
export type Working = { label: 'Break-even' | 'Runway'; expression: string; values: string; result: string; line: string };
// `inputs`: the brief's own monthly figures as read, for a review that works a colleague's sums out again and a
// verdict refresh that sees how far they moved since the call.
export type Inputs = { price?: number; cost?: number; fixed?: number; net?: number; cash?: number; paying?: number };
// `runway`: the months the working gives, as calc showed them, for holding the partner's own words to them (figuresFix).
export type Economics = { working: Working[]; breakEven?: number; current?: number; unit?: string; inputs?: Inputs; currency?: string; runway?: { value: number; display: string } };

const AMOUNT = /[$€£]?\s?(\d[\d,]*(?:\.\d+)?)\s*(k\b)?/gi;
function rowsOf(numbers: string): Row[] {
  return numbers.split('\n').flatMap((line): Row[] => {
    const found = /^\s*[-*]\s+([^:]{1,60}):\s*(.+)$/.exec(line);
    if (!found) return [];
    const amounts = [...found[2].matchAll(AMOUNT)].map((hit) => ({ value: Number(hit[1].replace(/,/g, '')) * (hit[2] ? 1000 : 1), at: hit.index ?? 0 }));
    return amounts.length ? [{ label: found[1].trim(), line: found[2], amounts }] : [];
  });
}
const find = (rows: Row[], label: RegExp, not?: RegExp) => rows.find((row) => label.test(row.label) && !(not && not.test(row.label)));
// A monthly figure from a row: the amount said "a month" when the row gives more than one ("€41 per box, about €178 a
// month per office"), else its first.
const MONTHLY = /^\s*(?:[$€£]?\s?)?(?:a|per|\/)\s*(?:month|mo)\b|^\s*(?:a|per)\s+month\b|^\s*monthly\b/i;
function monthly(row: Row): number {
  if (row.amounts.length > 1) {
    const said = row.amounts.find((one) => MONTHLY.test(row.line.slice(one.at).replace(/^[$€£]?\s?\d[\d,]*(?:\.\d+)?\s*k?/, '')));
    if (said) return said.value;
  }
  return row.amounts[0].value;
}
const unitOf = (label: string) => label.toLowerCase().replace(/\s*\(.*\)$/, '').trim();
// What one price is paid for, when the brief says: "€12 per print job" is paid per print job, so break-even counts print
// jobs a month, not the paying hosts beside it (journey 15 said "50 paying hosts" three times after the founder said
// otherwise). A price a month, a year or per user, seat or customer is the paying row's own.
const PERIOD_OR_PAYER = /^(?:month|mo|year|yr|week|day|user|seat|customer|client|subscriber|member|account|licen[cs]e|head)s?$/i;
export function perUnit(line: string): string | undefined {
  const found = /^(?:[$€£]\s?)?\d[\d,]*(?:\.\d+)?\s*k?\s*(?:[$€£])?\s*(?:(?:per|a|an|each)\s+|\/\s*)((?:[a-z][a-z-]*\s+){0,2}?[a-z][a-z-]*)(?=\s*(?:,|;|\.|$|\bpaid\b|\bfrom\b|\bto\b|\bfor\b))/i.exec(line.replace(/\(.*?\)/g, ' ').trim());
  const words = found?.[1].trim().toLowerCase();
  // "€240 per office a month" is a subscription per paying office, not a price per job.
  if (!words || PERIOD_OR_PAYER.test(words.split(/\s+/).at(-1)!) || /^\s*(?:a|per|each|\/)\s*(?:month|mo|year|yr)\b/i.test(line.replace(/\(.*?\)/g, ' ').slice((found!.index ?? 0) + found![0].length))) return undefined;
  return words.endsWith('s') ? words : /(?:x|ch|sh)$/.test(words) ? `${words}es` : /[^aeiou]y$/.test(words) ? `${words.slice(0, -1)}ies` : `${words}s`;
}
const stem = (word: string) => word.replace(/(?:es|s)$/, '');

// The working from the Company brief's Numbers section, or nothing when it does not hold enough to work anything out.
export function economicsOf(numbers: string): Economics | null {
  const rows = rowsOf(numbers);
  const price = find(rows, /\b(?:price|fee|arpu|revenue per|charge)\b/i);
  const cost = find(rows, /\bcost\b/i, /\bfixed\b|\bburn\b|\bacquisition\b|\bcac\b/i);
  const fixed = find(rows, /\bfixed costs?\b|\boverheads?\b|\bburn\b|\boperating costs?\b|\bexpenses\b/i, /\bnet\b/i);
  const net = find(rows, /\bnet burn\b/i);
  const cash = find(rows, /\bcash\b|\bin the bank\b|\bbank balance\b/i);
  const payers = find(rows, /\bpaying\b|\bcustomers\b|\bsubscribers\b/i, /\bprice\b|\bcost\b/i);
  const said = price ? perUnit(price.line) : undefined;
  // Priced per the very thing the paying row counts ("€40 per office", "Paying offices: 5"): that is the paying unit.
  const per = said && !(payers && new RegExp(`\\b${stem(said.split(' ').at(-1)!)}`, 'i').test(payers.label)) ? said : undefined;
  // Priced per job: what is counted is that thing ("Print jobs done: 4"), never the paying people beside it.
  const counted = per ? find(rows, new RegExp(`\\b${stem(per.split(' ').at(-1)!)}`, 'i'), /\bprice\b|\bcost\b/i) : undefined;
  const paying = per ? counted : payers;
  const working: Working[] = [];
  const out: Economics = { working };
  const currency = /[$€£]/.exec(numbers)?.[0];
  if (currency) out.currency = currency;
  const work = (label: Working['label'], expression: string, values: string, said: (value: string) => string) => {
    const worked = calculate(expression, values);
    const result = `${worked.worked} = ${worked.display}`;
    working.push({ label, expression, values, result, line: `${label}: ${result} ${said(worked.display)}` });
    if (label === 'Runway') out.runway = { value: worked.value, display: worked.display };
    return worked.value;
  };
  const p = price ? monthly(price) : undefined;
  const c = cost ? monthly(cost) : undefined;
  const f = fixed ? monthly(fixed) : undefined;
  const n = paying?.amounts[0].value;
  if (n !== undefined && paying) { out.current = n; out.unit = unitOf(paying.label); }
  if (per) out.unit = `${per} a month`;
  const inputs: Inputs = { price: p, cost: c, fixed: f, net: net ? monthly(net) : undefined, cash: cash?.amounts[0].value, paying: n };
  out.inputs = Object.fromEntries(Object.entries(inputs).filter(([, value]) => value !== undefined)) as Inputs;
  const units = out.unit ?? 'paying customers';
  // A count of jobs done so far is not a month's count: it is said as what the brief has, and never nets the burn.
  const have = n === undefined ? '' : per ? `; the brief has ${n} (${paying!.label.toLowerCase()})` : `; we have ${n}`;
  const nets = !per;
  // Journey 14's brief gave a price and the whole month's burn and no cost per practice: the partner worked break-even
  // and runway out in its head (and got runway wrong) because nothing here did. With no cost per unit, each paying
  // unit's price goes to the fixed costs whole, and the line says the brief gives no cost.
  if (p !== undefined && c === undefined && f !== undefined) {
    out.breakEven = work('Break-even', 'ceil(fixed / price)', `fixed=${f}, price=${p}`, () => `${units} to cover the burn (the brief gives no cost per unit)${have}`);
  }
  if (p !== undefined && c !== undefined && f !== undefined) {
    if (p - c <= 0) {
      work('Break-even', 'price - cost', `price=${p}, cost=${c}`, () => `a month on each of the ${units}: each one loses money, so no count breaks even`);
      out.breakEven = Infinity;
    } else {
      out.breakEven = work('Break-even', 'ceil(fixed / (price - cost))', `fixed=${f}, price=${p}, cost=${c}`, () => `${units} to cover fixed costs${have}`);
    }
  }
  if (cash) {
    const money = cash.amounts[0].value;
    if (net) work('Runway', 'round(cash / net, 1)', `cash=${money}, net=${monthly(net)}`, () => 'months at the net burn');
    else if (nets && f !== undefined && p !== undefined && c !== undefined && n !== undefined && f - n * (p - c) > 0) {
      work('Runway', 'round(cash / (fixed - paying * (price - cost)), 1)', `cash=${money}, fixed=${f}, paying=${n}, price=${p}, cost=${c}`, () => 'months at the net burn');
    } else if (nets && f !== undefined && p !== undefined && c === undefined && n !== undefined && f - n * p > 0) {
      work('Runway', 'round(cash / (burn - paying * price), 1)', `cash=${money}, burn=${f}, paying=${n}, price=${p}`, () => 'months at the net burn');
    } else if (f !== undefined && (p === undefined || !nets)) work('Runway', 'round(cash / burn, 1)', `cash=${money}, burn=${f}`, () => `months at the burn${nets ? '' : ` (the brief gives no ${per} a month to net it)`}`);
  }
  return working.length ? out : null;
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
  const inputs = economics.inputs ?? {};
  // Net of what the paying units bring in: the burn less paying × (price − cost).
  const net = inputs.net === undefined && inputs.fixed !== undefined && inputs.price !== undefined && inputs.paying !== undefined
    ? inputs.cost === undefined ? calculate('burn - paying * price', `burn=${inputs.fixed}, paying=${inputs.paying}, price=${inputs.price}`)
      : calculate('burn - paying * (price - cost)', `burn=${inputs.fixed}, paying=${inputs.paying}, price=${inputs.price}, cost=${inputs.cost}`) : null;
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
      row = `${found[1]}${kind}: ${value} ${kind === 'Runway' ? 'months' : economics.unit ?? 'paying customers'} (calc: ${one.result})`;
    }
    if (row !== line) set.push(row.trim().replace(/^[-*]\s+/, ''));
    return row;
  }).join('\n');
  // Runway and break-even said anywhere else the write added are held to the same working.
  return { text: out.split('\n').map((line) => (derived(line) ? line : figuresFix(line, economics))).join('\n'), set };
}
