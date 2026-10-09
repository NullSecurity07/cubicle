import { replaceSection } from '../tools/sections.ts';
import { addToSection, sectionText } from './company.ts';
import { derivedRows, periodName, type EconomicsState, type Field, type InputFix } from './economics.ts';

// Journey 21: the founder said "6 cafés pay €39 a month" and "310 bookings"; the partner took both as the numbers and
// never put them in the Company brief, so Otto worked his runway from the old rows. A founder's correction of an input
// goes on its brief row at once, through this one write, and the reply says which row moved: "Paying cafés 4 → 6".

const MONEY: Field[] = ['price', 'cost', 'burn', 'net', 'cash', 'plan'];
const NEW_ROW: Partial<Record<Field, string>> = { price: 'Price', cost: 'Cost per unit', burn: 'Burn', net: 'Net burn', cash: 'Cash' };
const ROW = /^(\s*[-*]\s+)([^:]{1,60}):\s*(.+?)\s*$/;
const STAMP = /\s+\((?:founder|partner)\b[^)]*\)\s*$/i;
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const amount = (value: number) => value.toLocaleString('en-US');

// The value of a row with one input put right: the count, the money amount or the period it is paid in.
function swapped(value: string, fix: InputFix, mixed: boolean, currency: string): string {
  let out = value;
  if (fix.value !== undefined) {
    if (fix.field === 'paying' && mixed) out = out.replace(/(?<![$€£\d.,]\s?)\d[\d,]*(?:\.\d+)?/, amount(fix.value));
    else if (fix.field === 'plan' || (MONEY.includes(fix.field) && /[$€£]/.test(out))) out = out.replace(/([$€£])\s?\d[\d,]*(?:\.\d+)?(?:\s?k\b)?/, `$1${amount(fix.value)}`);
    else out = out.replace(/\d[\d,]*(?:\.\d+)?(?:\s?k\b)?/, MONEY.includes(fix.field) && fix.field !== 'cash' ? `${currency}${amount(fix.value)}` : amount(fix.value));
  }
  if (fix.period && MONEY.includes(fix.field) && fix.field !== 'cash') {
    const said = /(?:\b(?:a|an|per|each|every)\s+|\/\s*)(?:week|month|year|day)\b|\b(?:weekly|monthly|yearly|daily)\b/i;
    out = said.test(out) ? out.replace(said, periodName(fix.period)) : out.replace(/([$€£]\s?\d[\d,]*(?:\.\d+)?(?:\s?k\b)?)/, `$1 ${periodName(fix.period)}`);
  }
  return out;
}

// The brief with each correction on its row, and what moved for the receipt ("Paying cafés 4 → 6").
export function fixRows(text: string, fixes: InputFix[], state: EconomicsState, day: string): { text: string; moved: string[] } {
  let numbers = sectionText(text, 'Numbers');
  const added: string[] = [];
  const moved: string[] = [];
  const currency = state.currency ?? '';
  const mixed = state.streams > 1;
  for (const fix of fixes) {
    // The plan's price sits on the paying row ("Paying cafés: 6 at €39 a month").
    const label = fix.field === 'plan' ? state.inputs.paying?.label : state.inputs[fix.field]?.label;
    const rows = numbers.split('\n');
    const at = label ? rows.findIndex((row) => new RegExp(`^\\s*[-*]\\s+${escaped(label)}:`, 'i').test(row)) : -1;
    const said = (value?: number) => (value === undefined ? '' : MONEY.includes(fix.field) ? `${currency}${amount(value)}` : amount(value));
    const what = fix.field === 'plan' ? state.inputs.plan?.label ?? 'price per paying customer' : label;
    if (at < 0) {
      const name = NEW_ROW[fix.field];
      if (!name || fix.value === undefined || rows.some((row) => new RegExp(`^\\s*[-*]\\s+${escaped(name)}:`, 'i').test(row))) continue;
      added.push(`- ${name}: ${said(fix.value)}${fix.field === 'cash' ? '' : ` ${periodName(fix.period)}`} (founder, ${day})`);
      moved.push(`${name} ${said(fix.value)} (new row)`);
      continue;
    }
    const [, lead, name, value] = ROW.exec(rows[at])!;
    const next = swapped(value.replace(STAMP, ''), fix, mixed, currency);
    if (next === value.replace(STAMP, '')) continue;
    rows[at] = `${lead}${name}: ${next} (founder, ${day})`;
    numbers = rows.join('\n');
    const from = fix.value !== undefined ? said(fix.over?.value) : periodName(fix.over?.period);
    const to = fix.value !== undefined ? said(fix.value) : periodName(fix.period);
    moved.push(`${what} ${from ? `${from} → ` : ''}${to}${fix.value !== undefined && fix.period && fix.over?.period !== fix.period ? ` ${periodName(fix.period)}` : ''}`);
  }
  if (!moved.length) return { text, moved };
  const put = replaceSection(text, 'Numbers', numbers.trim());
  let out = 'text' in put ? put.text : text;
  out = addToSection(out, 'Numbers', added);
  // Runway and break-even rows are worked again on the rows as they are now.
  out = derivedRows(out, sectionText(out, 'Numbers')).text;
  return { text: out, moved };
}

export const movedLine = (moved: string[], title: string) => `${title}: ${moved.join('; ')}.`;
