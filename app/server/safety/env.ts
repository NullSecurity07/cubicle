import { SECRET_NAME } from './keys.ts';

// A child process this app starts is not this app: it gets the environment it needs to work, and none of the founder's
// other keys. Everything whose name says key, token, secret, password or authorisation is left behind unless that
// child demonstrably needs it, and what is kept is named at the call, never guessed here.
export function childEnv(env: NodeJS.ProcessEnv, keep: string[] = []): NodeJS.ProcessEnv {
  const wanted = new Set(keep);
  return Object.fromEntries(Object.entries(env).filter(([name]) => wanted.has(name) || !SECRET_NAME.test(name)));
}
