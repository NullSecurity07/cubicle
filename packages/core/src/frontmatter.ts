import YAML from 'yaml';

export interface Note<T = Record<string, unknown>> {
  data: T;
  body: string;
}

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Recursively turn Date instances into ISO strings (defensive: notes must round-trip as plain strings). */
function normalize(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = normalize(x);
    return o;
  }
  return v;
}

/**
 * Parse a markdown note with YAML frontmatter. Uses the YAML *core* schema, so ISO timestamps stay strings.
 * Missing or malformed frontmatter yields {} and the whole text as body (never throws).
 */
export function parseNote<T = Record<string, unknown>>(text: string): Note<T> {
  const m = text.match(FM_RE);
  if (!m) return { data: {} as T, body: text };
  let data: unknown = {};
  try {
    data = YAML.parse(m[1], { schema: 'core' }) ?? {};
  } catch {
    return { data: {} as T, body: text };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
  return { data: normalize(data) as T, body: m[2] };
}

/** Serialise frontmatter + body. Key order follows the object's insertion order; undefined keys are dropped. */
export function stringifyNote(data: Record<string, unknown>, body: string): string {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) if (v !== undefined) clean[k] = normalize(v);
  const yaml = YAML.stringify(clean, { lineWidth: 0, nullStr: 'null', schema: 'core' }).trimEnd();
  const b = body.endsWith('\n') ? body : body + '\n';
  return `---\n${yaml}\n---\n${b}`;
}

/** Extract the first fenced ```yaml block from a body and parse it (core schema). */
export function extractYamlBlock<T = Record<string, unknown>>(body: string): T | null {
  const m = body.match(/```ya?ml\s*\n([\s\S]*?)\n```/);
  if (!m) return null;
  try { return normalize(YAML.parse(m[1], { schema: 'core' })) as T; } catch { return null; }
}

/** Extract %%cubicle: ...%% owner comments. */
export function extractOwnerComments(body: string): string[] {
  const out: string[] = [];
  const re = /%%\s*cubicle:\s*([\s\S]*?)%%/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) out.push(m[1].trim());
  return out;
}
