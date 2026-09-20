import { Script } from 'node:vm';
import type { TaskScript } from '../../shared/model.ts';

// Work the founder wrote out themselves. It goes through the same sandbox `run_code` uses — no network, no programs,
// no model — and what it prints is the result.

export const CODE_CHARS = 20_000;

export function cleanScript(value: unknown): TaskScript | undefined {
  const script = value as Partial<TaskScript> | null | undefined;
  const code = typeof script?.code === 'string' ? script.code.slice(0, CODE_CHARS) : '';
  if (!code.trim()) return undefined;
  return { language: script?.language === 'python' ? 'python' : 'javascript', code };
}

// Whether the brackets and quotes in a piece of Python close. There is no Python parser on this side of the sandbox,
// so this catches what can be seen from here rather than pretending to know more.
function balanced(code: string): boolean {
  const open: string[] = [];
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  let quote = '';
  for (let at = 0; at < code.length; at += 1) {
    const here = code[at];
    if (quote) {
      if (here === '\\') at += 1;
      else if (code.startsWith(quote, at)) { at += quote.length - 1; quote = ''; }
      continue;
    }
    if (here === '#') { at = code.indexOf('\n', at); if (at < 0) break; continue; }
    if (here === '"' || here === "'") { quote = code.startsWith(here.repeat(3), at) ? here.repeat(3) : here; at += quote.length - 1; continue; }
    if ('([{'.includes(here)) open.push(here);
    else if (pairs[here] && open.pop() !== pairs[here]) return false;
  }
  return !open.length && !quote;
}

// What the sandbox is really handed. A task's script is a piece of work rather than a line typed at a prompt, so the
// JavaScript runs inside a function of its own: what it prints is the result, and nothing of the plumbing shows.
export const forSandbox = (script: TaskScript) => (script.language === 'python' ? script.code : `(() => {\n${script.code}\n})()`);

// A script with a mistake in it is found before the founder waits on it. JavaScript is compiled — exactly as it will
// be run, never run — and Python is only looked at, which is said plainly rather than dressed up as more than it is.
export function scriptProblem(script: TaskScript): string {
  if (!script.code.trim()) return 'there is no script in this task yet';
  if (script.language === 'python') return balanced(script.code) ? '' : 'the brackets or quotes in this script do not close';
  try { new Script(forSandbox(script)); } catch (error) { return `this script has a mistake in it: ${(error as Error).message.split('\n')[0]}`; }
  return '';
}
