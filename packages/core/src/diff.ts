const CONTEXT = 3;

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
 */
export function unifiedDiff(a: string, b: string, aName = 'current', bName = 'proposed'): string {
  const list = ops(toLines(a), toLines(b));
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
