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
export type Economics = { working: Working[]; breakEven?: number; current?: number; unit?: string };

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

// The working from the Company brief's Numbers section, or nothing when it does not hold enough to work anything out.
export function economicsOf(numbers: string): Economics | null {
  const rows = rowsOf(numbers);
  const price = find(rows, /\b(?:price|fee|arpu|revenue per|charge)\b/i);
  const cost = find(rows, /\bcost\b/i, /\bfixed\b|\bburn\b|\bacquisition\b|\bcac\b/i);
  const fixed = find(rows, /\bfixed costs?\b|\boverheads?\b|\bburn\b|\boperating costs?\b|\bexpenses\b/i, /\bnet\b/i);
  const net = find(rows, /\bnet burn\b/i);
  const cash = find(rows, /\bcash\b|\bin the bank\b|\bbank balance\b/i);
  const paying = find(rows, /\bpaying\b|\bcustomers\b|\bsubscribers\b/i, /\bprice\b|\bcost\b/i);
  const working: Working[] = [];
  const out: Economics = { working };
  const work = (label: Working['label'], expression: string, values: string, said: (value: string) => string) => {
    const worked = calculate(expression, values);
    const result = `${worked.worked} = ${worked.display}`;
    working.push({ label, expression, values, result, line: `${label}: ${result} ${said(worked.display)}` });
    return worked.value;
  };
  const p = price ? monthly(price) : undefined;
  const c = cost ? monthly(cost) : undefined;
  const f = fixed ? monthly(fixed) : undefined;
  const n = paying?.amounts[0].value;
  if (n !== undefined && paying) { out.current = n; out.unit = unitOf(paying.label); }
  const units = out.unit ?? 'paying customers';
  if (p !== undefined && c !== undefined && f !== undefined) {
    if (p - c <= 0) {
      work('Break-even', 'price - cost', `price=${p}, cost=${c}`, () => `a month on each of the ${units}: each one loses money, so no count breaks even`);
      out.breakEven = Infinity;
    } else {
      out.breakEven = work('Break-even', 'ceil(fixed / (price - cost))', `fixed=${f}, price=${p}, cost=${c}`, (value) => `${units} to cover fixed costs${n !== undefined ? `; we have ${n}` : ''}`);
    }
  }
  if (cash) {
    const money = cash.amounts[0].value;
    if (net) work('Runway', 'round(cash / net, 1)', `cash=${money}, net=${monthly(net)}`, () => 'months at the net burn');
    else if (f !== undefined && p !== undefined && c !== undefined && n !== undefined && f - n * (p - c) > 0) {
      work('Runway', 'round(cash / (fixed - paying * (price - cost)), 1)', `cash=${money}, fixed=${f}, paying=${n}, price=${p}, cost=${c}`, () => 'months at the net burn');
    } else if (f !== undefined && p === undefined) work('Runway', 'round(cash / burn, 1)', `cash=${money}, burn=${f}`, () => 'months at the burn');
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
