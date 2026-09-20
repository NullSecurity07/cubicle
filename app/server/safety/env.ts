import { SECRET_NAME } from './keys.ts';

// A child process this app starts is not this app: it gets the environment it needs to work, and none of the founder's
// other keys. Everything whose name says key, token, secret, password or authorisation is left behind unless that
// child demonstrably needs it, and what is kept is named at the call, never guessed here.
export function childEnv(env: NodeJS.ProcessEnv, keep: string[] = []): NodeJS.ProcessEnv {
  const wanted = new Set(keep);
  return Object.fromEntries(Object.entries(env).filter(([name]) => wanted.has(name) || !SECRET_NAME.test(name)));
}

// What the coding agent really needs: opencode signs in to its own built-in models from a file under HOME, and to any
// other provider from that provider's own key (`anthropic/claude-…` reads ANTHROPIC_API_KEY). So the key of the one
// provider the founder pointed it at is kept, and every other key on this machine stays here.
export function coderKeys(model: string): string[] {
  const provider = model.split('/')[0]?.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  return provider ? [`${provider}_API_KEY`] : [];
}
