// Keys, two ways: the shapes the well-known ones are written in, and the exact values this machine's own secret-named
// environment variables hold. Both are used to stop a key leaving in a tool call, and to take it out of anything a
// person reads back.

// Shapes chosen to be unmistakable. Nothing here matches an ordinary sentence, a file path or a word of English.
const SHAPES: { name: string; pattern: RegExp }[] = [
  { name: 'an OpenAI or Anthropic key', pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g },
  { name: 'a Groq key', pattern: /\bgsk_[A-Za-z0-9]{20,}/g },
  { name: 'a Google key', pattern: /\bAIza[A-Za-z0-9_-]{35}/g },
  { name: 'an AWS key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'a GitHub key', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})/g },
  { name: 'a Slack key', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'a Hugging Face key', pattern: /\bhf_[A-Za-z0-9]{20,}/g },
  { name: 'a signed token', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/g },
  { name: 'a private key file', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
];

// A name that says the value is a secret. The same list decides what a child process is started without.
export const SECRET_NAME = /(?:^|_)(?:KEY|KEYS|TOKEN|SECRET|PASSWORD|PASSWD|PASS|AUTH|CREDENTIAL|CREDENTIALS)(?:$|_)/i;
// Twelve characters, so a short setting ("true", "fake", a port) can never blank ordinary text that happens to hold it.
const SHORTEST = 12;

// This process's own secrets, longest first so a value that contains another is taken out whole.
export function secretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  const found = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (value && value.length >= SHORTEST && SECRET_NAME.test(name)) found.add(value);
  }
  return [...found].sort((one, other) => other.length - one.length);
}

// What kind of key is in this text, in words a founder reads, or null. `own` is the machine's own values, passed in so
// a test can hand it a fake set and nothing ever reaches for the real environment by surprise.
export function findKey(text: string, own: string[] = secretValues()): string | null {
  if (!text) return null;
  for (const value of own) if (text.includes(value)) return "one of this machine's own keys";
  for (const { name, pattern } of SHAPES) if (new RegExp(pattern.source).test(text)) return name;
  return null;
}

export const HIDDEN = '[key hidden]';

// The same keys, taken out of something the founder or a person is about to read. Everything else is left exactly as
// it was: this only ever removes, and only what it is sure about.
export function redact(text: string, own: string[] = secretValues()): string {
  if (!text) return text;
  let left = text;
  for (const value of own) if (left.includes(value)) left = left.split(value).join(HIDDEN);
  for (const { pattern } of SHAPES) left = left.replace(new RegExp(pattern.source, 'g'), HIDDEN);
  return left;
}
