// A "(calc)" tag says a figure was worked out with the calc tool. Journey 16: a reply marked every line "(calc)" with no
// calc call in the turn, and a note wrote "(calc)" beside a figure nobody worked out; the tag made a guess look checked.
// It stands only on a line holding a figure some calc working read this turn gave; anywhere else it is taken out.

const RESULT = /=\s*(-?\d[\d,]*(?:\.\d+)?)/g;
const FIGURE = /-?\d[\d,]*(?:\.\d+)?/g;
const TAG = /\s*\(calc\)/gi;

// Every result a calc working gives, with its roundings ("31.0344 = 31.03, 31, 32").
export function calcResults(workings: string[]): Set<number> {
  const found = new Set<number>();
  for (const working of workings) {
    for (const hit of working.matchAll(RESULT)) {
      const value = Number(hit[1].replace(/,/g, ''));
      if (!Number.isFinite(value)) continue;
      for (const one of [value, Math.round(value), Math.ceil(value), Math.floor(value), Math.round(value * 10) / 10, Math.round(value * 100) / 100]) found.add(one);
    }
  }
  return found;
}

export function calcTagsHeld(text: string, workings: string[]): string {
  if (!/\(calc\)/i.test(text)) return text;
  const results = calcResults(workings);
  return text.split('\n').map((line) => {
    if (!/\(calc\)/i.test(line)) return line;
    const figures = (line.replace(TAG, '').match(FIGURE) ?? []).map((one) => Number(one.replace(/,/g, '')));
    return figures.some((one) => results.has(one)) ? line : line.replace(TAG, '');
  }).join('\n');
}
