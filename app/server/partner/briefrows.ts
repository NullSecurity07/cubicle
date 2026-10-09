// Journey 21: Maya, answering a review flag on a film ask, wrote "Burn: -€54 a month (cash-positive), calculated as
// 1,300 − (280 × 4 + 6 × 39) = −54 (calc)" over the Company brief's Burn row. The figure was stale when written, the
// gross burn the whole company works from was gone, the partner's next snapshot had no burn at all and the morning note
// said nothing. The brief's Numbers rows are the founder's and the partner's: a colleague's write to one is refused
// (tools/docs.ts), a figure worked out from the others is never written as an input row, every change to a row is kept
// with who made it for the morning note, and a row that goes missing is read from the last figure on record.

// The rows worked out by calc from the others: set in code on every brief write, never an input.
const DERIVED_LABEL = /^(?:runway|break[- ]?even|net burn)\b/i;
// What a row's value says, without the stamp the app puts after it ("(founder, 2026-10-09)").
const STAMP = /\s+\((?:founder|partner|from|kept)\b[^)]*\)\s*$/i;
const ROW = /^\s*[-*]\s+([^:]{1,60}):\s*(.+?)\s*$/;

export type BriefRows = Record<string, { label: string; value: string }>;
export type RowChange = { label: string; from?: string; to?: string };

// The input rows of a Numbers section, by their label in lower case.
export function briefRows(numbers: string): BriefRows {
  const out: BriefRows = {};
  for (const line of numbers.split('\n')) {
    const found = ROW.exec(line);
    if (!found || !/\d/.test(found[2])) continue;
    const label = found[1].trim();
    if (DERIVED_LABEL.test(label)) continue;
    out[label.toLowerCase()] = { label, value: found[2].replace(STAMP, '').trim() };
  }
  return out;
}

// The same figure said with other spacing or thousands commas is no change.
const same = (a: string, b: string) => a.replace(/(?<=\d),(?=\d{3})/g, '').replace(/\s+/g, ' ').toLowerCase() === b.replace(/(?<=\d),(?=\d{3})/g, '').replace(/\s+/g, ' ').toLowerCase();

// Each input row added, taken out or changed between two Numbers sections.
export function rowChanges(before: string | BriefRows, after: string | BriefRows): RowChange[] {
  const a = typeof before === 'string' ? briefRows(before) : before;
  const b = typeof after === 'string' ? briefRows(after) : after;
  const out: RowChange[] = [];
  for (const [key, was] of Object.entries(a)) {
    const now = b[key];
    if (!now) out.push({ label: was.label, from: was.value });
    else if (!same(was.value, now.value)) out.push({ label: now.label, from: was.value, to: now.value });
  }
  for (const [key, now] of Object.entries(b)) if (!a[key]) out.push({ label: now.label, to: now.value });
  return out;
}

// A figure worked out from the others written as an input: a sum or a calc on the row, "cash-positive", or a burn or
// cash below zero.
export function derivedAsInput(label: string, value: string): boolean {
  if (DERIVED_LABEL.test(label)) return false;
  if (/\bcalc\b|\bcalculated\b|(?:^|\s)=\s|\bcash[- ]positive\b/i.test(value)) return true;
  return /\b(?:burn|cash|costs?|expenses|overheads?)\b/i.test(label) && /^\s*[-−–]\s?[$€£]?\s?\d|^\s*[$€£]\s?[-−–]\s?\d/.test(value);
}

export const changeSaid = (one: RowChange) => (one.from && one.to ? `${one.label} ${one.from} → ${one.to}` : one.to ? `${one.label} ${one.to} (new row)` : `${one.label} ${one.from} taken out`);

// Why a write to the brief is refused, or null when it may stand. `partner`: the writer is the partner.
export function numbersRefusal(before: string, after: string, partner: boolean): string | null {
  const changes = rowChanges(before, after);
  if (!changes.length) return null;
  if (!partner) {
    return `the brief's numbers are the founder's and the partner's, so a colleague does not change them (${changes.map(changeSaid).join('; ')}). `
      + 'Leave the Numbers rows as they are: say your figure in your reply or in your own doc, and the founder or the partner puts it in the brief.';
  }
  const worked = changes.filter((one) => one.to && derivedAsInput(one.label, one.to));
  if (worked.length) {
    return `${worked.map((one) => `"${one.label}: ${one.to}"`).join(', ')} ${worked.length > 1 ? 'are figures' : 'is a figure'} worked out from the others, and the brief's Numbers keep only the inputs `
      + '(gross burn, cash, prices, counts). Net burn, runway and break-even are set by calc on their own rows: leave the input as it was.';
  }
  return null;
}

// A change kept for the morning note: what moved, from what to what, by whom.
export type BriefChange = RowChange & { at: number; by: string };
export const MOST_CHANGES = 20;
export const briefChangeLine = (one: BriefChange) => (one.from && one.to
  ? `Company brief: ${one.label} ${one.from} → ${one.to} (by ${one.by}).`
  : one.to ? `Company brief: ${one.label} ${one.to} added (by ${one.by}).`
    : `Company brief: the ${one.label} row (${one.from}) was taken out (by ${one.by}); the last figure on record is used until it is back.`);
