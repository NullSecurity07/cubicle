// Numbers that are one thing however many digits they hold: a date, a time, a version, a phone number. A guard that
// takes figures out of a line ("a number nobody measured comes off the screen") must take such a thing out whole or
// leave it whole. Read digit by digit, "2026-10-19" is a 2026 and a 19, and striking both left "-10-" on a caption.

const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';
const CODES = [
  // 2026-10-19, 2026/10/19, 10/19/2026, 19.10.2026, 10-19-26
  /\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b|\b\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\b/g,
  // 19 Oct 2026, 19th October, Oct 19, October 19th, 2026
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}(?:,?\\s+\\d{4})?\\b|\\b${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?\\b(?:,?\\s+\\d{4}\\b)?`, 'gi'),
  // 06:30, 6:30pm, 18:05:12
  /\b\d{1,2}:\d{2}(?::\d{2})?(?:\s?[ap]\.?m\.?\b)?/gi,
  // v2, v1.4, 1.2.3, version 4
  /\bv\d+(?:\.\d+)*\b|\b\d+\.\d+\.\d+(?:\.\d+)*\b|\bversion\s+\d+(?:\.\d+)*\b/gi,
  // +44 20 7946 0958, (555) 123-4567, 555-123-4567: seven digits or more with a separator between them
  /(?:\+\s?)?\(?\d[\d()\s.-]{5,}\d/g,
  // day 19, week 2, step 3: a number that names a place in a sequence, not a count
  /\b(?:step|day|week|phase|round|chapter|part|stage|level|tier|sprint|slide|page|section|q)\s*#?\d+\b/gi,
];
const isPhone = (hit: string) => (hit.match(/\d/g) ?? []).length >= 7 && /[\s().-]\d/.test(hit) && !/^\d+\.\d+$/.test(hit.trim());

// The spans of a line that are codes, as [from, to).
export function codeSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  CODES.forEach((pattern, index) => {
    for (const hit of text.matchAll(pattern)) {
      if (index === 4 && !isPhone(hit[0])) continue;
      spans.push([hit.index!, hit.index! + hit[0].length]);
    }
  });
  return spans;
}

export const inCode = (spans: [number, number][], at: number, end = at + 1) => spans.some(([from, to]) => at < to && end > from);

// A line with each figure taken out where it stands as a figure of its own: never out of the middle of a date, a time,
// a version or a phone number, and never out of a longer number ("19" is not struck from "190").
export function withoutFigures(line: string, figures: string[], by = ''): string {
  let out = line;
  for (const figure of figures) {
    const spans = codeSpans(out);
    const escaped = figure.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(?<![\\d.,])${escaped}(?![\\d]|[.,]\\d)`, 'g');
    const hit = [...out.matchAll(pattern)].find((one) => !inCode(spans, one.index!, one.index! + one[0].length));
    if (hit) out = out.slice(0, hit.index!) + by + out.slice(hit.index! + hit[0].length);
  }
  return out;
}

// The matches of a global pattern that are not inside a code, and the line with only those replaced.
export const hitsOutsideCodes = (text: string, pattern: RegExp): RegExpMatchArray[] => {
  const spans = codeSpans(text);
  return [...text.matchAll(pattern)].filter((hit) => !inCode(spans, hit.index!, hit.index! + hit[0].length));
};
export function replaceOutsideCodes(text: string, pattern: RegExp, by: (hit: string) => string): string {
  let out = '';
  let from = 0;
  for (const hit of hitsOutsideCodes(text, pattern)) {
    out += text.slice(from, hit.index!) + by(hit[0]);
    from = hit.index! + hit[0].length;
  }
  return out + text.slice(from);
}
