import matter from 'gray-matter';
import YAML from 'yaml';

export interface Note<T = Record<string, unknown>> {
  data: T;
  body: string;
}

/** Parse a markdown note with YAML frontmatter. Missing frontmatter yields {}. */
export function parseNote<T = Record<string, unknown>>(text: string): Note<T> {
  const parsed = matter(text);
  return { data: (parsed.data ?? {}) as T, body: parsed.content.replace(/^\r?\n/, '') };
}

/** Serialise frontmatter + body. Key order follows the object's insertion order. */
export function stringifyNote(data: Record<string, unknown>, body: string): string {
  const yaml = YAML.stringify(data, { lineWidth: 0, nullStr: 'null' }).trimEnd();
  const b = body.endsWith('\n') ? body : body + '\n';
  return `---\n${yaml}\n---\n${b}`;
}

/** Extract the first fenced ```yaml block from a body and parse it. */
export function extractYamlBlock<T = Record<string, unknown>>(body: string): T | null {
  const m = body.match(/```ya?ml\s*\n([\s\S]*?)\n```/);
  if (!m) return null;
  return YAML.parse(m[1]) as T;
}

/** Extract %%cubicle: ...%% owner comments. */
export function extractOwnerComments(body: string): string[] {
  const out: string[] = [];
  const re = /%%\s*cubicle:\s*([\s\S]*?)%%/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) out.push(m[1].trim());
  return out;
}
