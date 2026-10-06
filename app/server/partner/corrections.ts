// Journey 15: the founder told the partner "break-even is 50 print jobs a month, not 50 paying hosts: one host is not
// €12 a month of revenue". The app wrote "MRR: €12 a month (founder)" into the brief, and "50 paying hosts" came back in
// the next verdict, the refresh and the notes kept on their own. A founder's correction in chat is read here, in code:
// what they said is wrong never goes back into the brief, the standing facts or the kept notes, and what they said is
// right stands over any figure before it.

// `wrong`: the figure the founder said is not so ("50 paying hosts", "€12 a month"). `right`: what they said it is,
// when they said it ("50 print jobs a month"). `about`: what the wrong figure was said of ("one host"), when named.
export type Correction = { wrong?: string; right?: string; about?: string; said: string; day?: string };

// A figure: an amount or a count with up to three words of what it is ("€12 a month", "50 paying hosts").
const FIGURE = String.raw`(?:[$€£]\s?)?\d[\d,]*(?:\.\d+)?%?(?:\s?k\b)?(?:\s+(?!(?:of|for|in|to|from|and|but|by|on|at|with|so|because|not|is|are|was)\b)[a-z][a-z-]*){0,3}(?:\s+(?:a|per|each)\s+(?:month|week|year|day))?`;
const RIGHT_NOT_WRONG = new RegExp(String.raw`(${FIGURE})\s*,?\s+(?:and\s+)?not\s+(${FIGURE})`, 'gi');
const NOT_WRONG_BUT_RIGHT = new RegExp(String.raw`\bnot\s+(${FIGURE})\s*,?\s+but\s+(${FIGURE})`, 'gi');
const SUBJECT_IS_NOT = new RegExp(String.raw`\b([a-z][a-z' -]{0,40}?)\s+(?:is|are|was|were)\s*(?:not|n't)\s+(?:even\s+)?(${FIGURE})|\b([a-z][a-z' -]{0,40}?)\s+(?:isn'?t|aren'?t|wasn'?t)\s+(?:even\s+)?(${FIGURE})`, 'gi');
const NO_IT_IS = new RegExp(String.raw`^\s*(?:no|nope|wrong)\b[,.!:;]?\s+(?:it'?s|it is|that'?s|that is|the (?:\w+\s){0,2}(?:is|are))\s+(${FIGURE})`, 'i');
const clean = (text: string) => text.replace(/\s+/g, ' ').trim().replace(/[\s,.;:!?]+$/, '');
const hasNumber = (text: string) => /\d/.test(text);

// Every correction in what the founder said, in order. A plain "not" before a figure with nothing being corrected
// ("not even 3 users yet") is not one: it needs a right figure beside it, a subject it is said of, or a "no" in front.
export function correctionsIn(said: string): Correction[] {
  const out: Correction[] = [];
  const add = (one: Correction) => {
    const wrong = one.wrong ? clean(one.wrong) : undefined;
    const right = one.right ? clean(one.right) : undefined;
    if ((wrong && !hasNumber(wrong)) || (right && !hasNumber(right))) return;
    if (out.some((had) => had.wrong === wrong && had.right === right)) return;
    out.push({ ...(wrong ? { wrong } : {}), ...(right ? { right } : {}), ...(one.about ? { about: clean(one.about) } : {}), said: clean(one.said).slice(0, 200) });
  };
  for (const line of said.split(/\n+/)) {
    for (const clause of line.split(/(?<=[.!?])\s+|:\s+|;\s+/)) {
      const taken: [number, number][] = [];
      for (const found of clause.matchAll(RIGHT_NOT_WRONG)) { add({ right: found[1], wrong: found[2], said: clause }); taken.push([found.index!, found.index! + found[0].length]); }
      for (const found of clause.matchAll(NOT_WRONG_BUT_RIGHT)) { add({ wrong: found[1], right: found[2], said: clause }); taken.push([found.index!, found.index! + found[0].length]); }
      for (const found of clause.matchAll(SUBJECT_IS_NOT)) {
        if (taken.some(([from, to]) => found.index! < to && found.index! + found[0].length > from)) continue;
        const about = (found[1] ?? found[3]).replace(/^.*\b(?:and|but|so|because|that|which)\s+/i, '');
        add({ wrong: found[2] ?? found[4], about, said: clause });
      }
      const no = NO_IT_IS.exec(clause);
      if (no) add({ right: no[1], said: clause });
    }
  }
  return out;
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A figure as a pattern: its own words, any spacing, a plural or not, and its amount with or without thousands commas.
export function figurePattern(figure: string): RegExp {
  const words = figure.replace(/,(?=\d{3}\b)/g, '').split(/\s+/).map((word) => {
    const bare = escaped(word.replace(/s$/i, ''));
    return /\d/.test(word) ? escaped(word).replace(/\d+/g, (digits) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',?')) : `${bare}s?`;
  });
  return new RegExp(`(?<![\\w.])${words.join('\\s+')}(?![\\w])`, 'i');
}
// The wrong figure the founder named in a line, if any.
export const saysWrong = (line: string, corrections: Correction[]) => corrections.find((one) => one.wrong && figurePattern(one.wrong).test(line));

// The lines for the standing facts: what the founder said is wrong and what is right, newest first.
export function correctionLines(corrections: Correction[]): string[] {
  return corrections.slice().reverse().map((one) => {
    const day = one.day ? ` (founder, ${one.day})` : ' (founder)';
    if (one.wrong && one.right) return `- "${one.right}", not "${one.wrong}"${day}`;
    if (one.wrong) return `- ${one.about ? `${one.about}: ` : ''}not "${one.wrong}"${day}`;
    return `- "${one.right}"${day}`;
  });
}

// The unit a correction puts right: "50 print jobs a month, not 50 paying hosts" with the same count says the thing
// counted is print jobs, not paying hosts.
export function unitFix(corrections: Correction[]): { wrong: string; right: string }[] {
  const out: { wrong: string; right: string }[] = [];
  for (const one of corrections) {
    if (!one.wrong || !one.right) continue;
    const w = /^(\d[\d,]*)\s+(.+)$/.exec(one.wrong);
    const r = /^(\d[\d,]*)\s+(.+?)(?:\s+(?:a|per|each)\s+(?:month|week|year))?$/.exec(one.right);
    if (w && r && w[1] === r[1] && w[2].toLowerCase() !== r[2].toLowerCase()) out.push({ wrong: w[2].toLowerCase(), right: r[2].toLowerCase() });
  }
  return out;
}

// What the partner keeps of them: the last few, the newest a correction of the same figure replacing the older one.
export const MOST_CORRECTIONS = 8;
export function keepCorrections(held: Correction[], fresh: Correction[], day: string): Correction[] {
  const next = held.filter((old) => !fresh.some((one) => (one.wrong && one.wrong === old.wrong) || (one.right && old.wrong && figurePattern(old.wrong).test(one.right))));
  return [...next, ...fresh.map((one) => ({ ...one, day }))].slice(-MOST_CORRECTIONS);
}

// A break-even said in the unit the founder put right: "break-even is 44 paying hosts" is "44 print jobs a month"
// once they said it is print jobs. Only in a sentence about break-even: "1 paying host" elsewhere is a real count.
export function unitsFix(text: string, fixes: { wrong: string; right: string }[]): string {
  if (!fixes.length) return text;
  return text.split('\n').map((line) => line.split(/(?<=[.!?])\s+/).map((sentence) => {
    if (!/\bbreak[- ]?even\b|\bto break even\b/i.test(sentence)) return sentence;
    let out = sentence;
    for (const fix of fixes) out = out.replace(new RegExp(`(\\d[\\d,]*\\**\\s+)${figurePattern(fix.wrong).source.replace(/^\(\?<!\[\\w\.\]\)/, '')}`, 'gi'), (_whole, count: string) => `${count}${fix.right}`);
    return out;
  }).join(' ')).join('\n');
}

// The brief's working with the unit the founder gave: the unit and each line of the working said in it.
export function inUnits<T extends { unit?: string; working: { line: string }[] }>(economics: T | null, fixes: { wrong: string; right: string }[]): T | null {
  if (!economics || !fixes.length) return economics;
  const fix = fixes.find((one) => economics.unit && figurePattern(one.wrong).test(economics.unit));
  return { ...economics, ...(fix ? { unit: economics.unit!.replace(figurePattern(fix.wrong), fix.right) } : {}), working: economics.working.map((one) => ({ ...one, line: unitsFix(one.line, fixes) })) };
}
