const CONTEXT = 3;
/** Per side, after the common head and tail are trimmed. The LCS table is (n+1)(m+1) Uint32: 4000 x 4000 is 64 MB. */
const MAX_LINES = 4000;

type Op = { kind: ' ' | '-' | '+'; text: string };

function toLines(text: string): string[] {
  if (text === '') return [];
  return text.replace(/\n$/, '').split('\n');
}

/** Longest-common-subsequence walk, deletions before insertions at a replaced line. */
function ops(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const out: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ kind: ' ', text: a[i] }); i++; j++; }
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) { out.push({ kind: '-', text: a[i] }); i++; }
    else { out.push({ kind: '+', text: b[j] }); j++; }
  }
  while (i < n) out.push({ kind: '-', text: a[i++] });
  while (j < m) out.push({ kind: '+', text: b[j++] });
  return out;
}

/**
 * A unified diff of two texts (line granularity, 3 lines of context), for showing an owner what a
 * proposal would change. Returns '' when the texts are identical.
 *
 * A trailing newline is stripped before splitting, so a change that only adds or removes the final
 * newline is not shown. Only the lines between the common head and tail reach the quadratic LCS table;
 * when more than MAX_LINES of those remain on either side the diff is refused with a single
 * `(diff too large: N vs M lines)` line rather than allocating a table of gigabytes.
 */
export function unifiedDiff(a: string, b: string, aName = 'current', bName = 'proposed'): string {
  const aLines = toLines(a);
  const bLines = toLines(b);

  // Common head and tail are unchanged by definition; diffing only the middle keeps the table small.
  let head = 0;
  while (head < aLines.length && head < bLines.length && aLines[head] === bLines[head]) head++;
  let tail = 0;
  while (tail < aLines.length - head && tail < bLines.length - head && aLines[aLines.length - 1 - tail] === bLines[bLines.length - 1 - tail]) tail++;
  const midA = aLines.slice(head, aLines.length - tail);
  const midB = bLines.slice(head, bLines.length - tail);
  if (!midA.length && !midB.length) return '';
  if (midA.length > MAX_LINES || midB.length > MAX_LINES) return `(diff too large: ${aLines.length} vs ${bLines.length} lines)\n`;

  const unchanged = (text: string): Op => ({ kind: ' ', text });
  const list: Op[] = [
    ...aLines.slice(0, head).map(unchanged),
    ...ops(midA, midB),
    ...aLines.slice(aLines.length - tail).map(unchanged),
  ];
  const changed = list.map((o, k) => (o.kind === ' ' ? -1 : k)).filter((k) => k >= 0);
  if (!changed.length) return '';

  // Lines of each side consumed before op k, so a hunk can state its start line.
  const aBefore: number[] = [];
  const bBefore: number[] = [];
  let ac = 0;
  let bc = 0;
  for (const o of list) {
    aBefore.push(ac);
    bBefore.push(bc);
    if (o.kind !== '+') ac++;
    if (o.kind !== '-') bc++;
  }

  // Group changes that are within 2*CONTEXT unchanged lines of each other into one hunk.
  const groups: [number, number][] = [];
  let first = changed[0];
  let last = changed[0];
  for (const k of changed.slice(1)) {
    if (k - last - 1 > 2 * CONTEXT) { groups.push([first, last]); first = k; }
    last = k;
  }
  groups.push([first, last]);

  let out = `--- ${aName}\n+++ ${bName}\n`;
  for (const [from, to] of groups) {
    const start = Math.max(0, from - CONTEXT);
    const end = Math.min(list.length - 1, to + CONTEXT);
    const slice = list.slice(start, end + 1);
    const aCount = slice.filter((o) => o.kind !== '+').length;
    const bCount = slice.filter((o) => o.kind !== '-').length;
    const aStart = aCount === 0 ? aBefore[start] : aBefore[start] + 1;
    const bStart = bCount === 0 ? bBefore[start] : bBefore[start] + 1;
    out += `@@ -${aStart},${aCount} +${bStart},${bCount} @@\n`;
    for (const o of slice) out += `${o.kind}${o.text}\n`;
  }
  return out;
}
