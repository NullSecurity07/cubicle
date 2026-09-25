import { parseEnv } from 'node:util';

// The `.env` file, changed one name at a time. Everything else in it stays exactly as the founder wrote it: their
// comments, their blank lines, the order, the names this app has never heard of. Only the line that sets this name is
// replaced (a second one, which would be read instead of the first, is taken out), or added at the end.

export const NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const PLAIN = /^[A-Za-z0-9_\-.:/@+,=~%]*$/;
const line = (name: string) => new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`);

// A value written so that reading the file gives it back exactly: bare when it is only safe characters, else in
// single quotes (which keep everything as it is), else in double quotes. A value that can be written neither way, or
// that holds a line break, is refused rather than written wrong.
export function quoted(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error('a key is one line');
  if (PLAIN.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"') && !value.includes('\\')) return `"${value}"`;
  throw new Error('that value has both kinds of quote in it, and cannot be written to .env as it is');
}

// The file's words with `name` set to `value`, or taken out when `value` is null. Checked by reading it back.
export function withEnv(text: string, name: string, value: string | null): string {
  if (!NAME.test(name)) throw new Error(`"${name}" is not a name .env can hold`);
  const lines = text.length ? text.replace(/\r?\n$/, '').split(/\r?\n/) : [];
  const at = lines.findIndex((one) => line(name).test(one));
  const kept = lines.filter((one, index) => index === at || !line(name).test(one));
  const setting = value === null ? null : `${name}=${quoted(value)}`;
  const place = kept.findIndex((one) => line(name).test(one));
  if (place >= 0) { if (setting === null) kept.splice(place, 1); else kept[place] = setting; }
  else if (setting !== null) kept.push(setting);
  const next = kept.length ? `${kept.join('\n')}\n` : '';
  if ((parseEnv(next)[name] ?? null) !== value) throw new Error(`${name} could not be written so that it reads back the same`);
  return next;
}

// What the file says, by name. A file that is not there says nothing.
export const readEnv = (text: string): Record<string, string> => parseEnv(text) as Record<string, string>;

// All a person is ever shown of a key: that there is one, and its last four characters when it is long enough that
// four give nothing away. Nothing else of a value leaves the server.
export const tailOf = (value: string | undefined): string | undefined => (value && value.length >= 12 ? value.slice(-4) : undefined);
