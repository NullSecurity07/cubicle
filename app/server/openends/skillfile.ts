import type { Skill } from '../../shared/model.ts';
import { CAPS } from '../skills.ts';

// A skill as one file, so one can be carried between machines, put in a repository, or written by hand in an editor.
// The shape is the one the rest of the world already writes: a little block of fields at the top, then four headings.
// Our reader is forgiving about everything except the two things a skill cannot do without — a name and a procedure —
// because a file somebody typed will have the wrong number of hashes long before it has the wrong idea.
export const OUTSIDE = 'outside';
export const cameFromOutside = (skill: Pick<Skill, 'source'>) => skill.source?.ref === OUTSIDE || skill.source?.ref?.startsWith(`${OUTSIDE}:`) === true;

export type Fields = { name: string; when: string; procedure: string[]; pitfalls: string[]; verify: string };
const HEADS: [keyof Fields | 'title', RegExp][] = [
  ['when', /^when(\s+to\s+use)?$/i],
  ['procedure', /^(procedure|what to do|steps?|how)$/i],
  ['pitfalls', /^(pitfalls?|watch out( for)?|gotchas?)$/i],
  ['verify', /^(verification|verify|done when|how to check)$/i],
];
const flat = (text: string) => text.replace(/\s+/g, ' ').trim();
const item = (line: string) => flat(line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ''));
const listed = (lines: string[]) => lines.map(item).filter(Boolean);

// The block between the first two lines of dashes. Only `name:` and `description:` are ours; anything else somebody's
// own tooling put there is left where it is and ignored.
export function frontMatter(text: string): { fields: Record<string, string>; rest: string } {
  const match = /^\s*---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { fields: {}, rest: text };
  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (pair) fields[pair[1].toLowerCase()] = pair[2].trim().replace(/^["'](.*)["']$/, '$1');
  }
  return { fields, rest: text.slice(match[0].length) };
}

export function parseSkillFile(text: string): Fields {
  const { fields, rest } = frontMatter(text);
  const found: Record<string, string[]> = {};
  let title = '';
  let here: string | null = null;
  for (const line of rest.split(/\r?\n/)) {
    const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      const what = flat(heading[1]).replace(/[:.]$/, '');
      const known = HEADS.find(([, pattern]) => pattern.test(what));
      if (known) { here = known[0]; found[here] ??= []; } else { here = null; title ||= what; }
      continue;
    }
    if (here) (found[here] ??= []).push(line);
  }
  const words = (key: string) => flat((found[key] ?? []).join(' '));
  const name = flat(fields.name || title);
  if (!name) throw new Error('this file has no name: give it a `name:` line at the top, or a heading');
  const procedure = listed(found.procedure ?? []);
  if (!procedure.length) throw new Error('this file has no procedure: add a "Procedure" heading with one step to a line');
  return {
    name: name.slice(0, CAPS.name),
    when: (flat(fields.description || fields.when || words('when')) || `When "${name}" applies`).slice(0, CAPS.when),
    procedure,
    pitfalls: listed(found.pitfalls ?? []),
    verify: (words('verify') || 'The founder can see that it is done.').slice(0, CAPS.verify),
  };
}

// The same thing written back out, so what goes out of here reads the same as what comes in.
export function renderSkillFile(skill: Pick<Skill, 'name' | 'when' | 'procedure' | 'pitfalls' | 'verify'>): string {
  const quote = (text: string) => (/[:#]/.test(text) ? `"${text.replace(/"/g, "'")}"` : text);
  return [
    '---', `name: ${quote(skill.name)}`, `description: ${quote(skill.when)}`, '---', '',
    `# ${skill.name}`, '',
    '## When to use', skill.when, '',
    '## Procedure', ...skill.procedure.map((step, at) => `${at + 1}. ${step}`), '',
    ...(skill.pitfalls.length ? ['## Pitfalls', ...skill.pitfalls.map((one) => `- ${one}`), ''] : []),
    '## Verification', skill.verify, '',
  ].join('\n');
}

// A file the founder brought in. It goes through the same door everything else does, so the same caps hold, and it
// arrives switched off: nobody works from words this company did not write until the founder has read them.
export const fileName = (skill: Pick<Skill, 'id'>) => `${skill.id}.SKILL.md`;
