import { connect } from 'node:net';
import { SERVICE, servicePort, systemctl, type Ask } from './service.ts';

// Two things that keep the app up through a bad moment.

// How many times the api may be started again after it fell over, within a stretch of time. Three in a minute is a
// bad moment; a fourth means it cannot start at all, and starting it again forever would only hide that.
export function restartBudget(options: { times: number; within: number; now?: () => number }) {
  const { times, within, now = Date.now } = options;
  let starts: number[] = [];
  return {
    allow(): boolean {
      const at = now();
      starts = starts.filter((one) => at - one < within);
      if (starts.length >= times) return false;
      starts.push(at);
      return true;
    },
  };
}

type Emitter = { on(event: string, listener: (...args: any[]) => void): unknown };
// A promise nobody caught is one piece of work that failed: it is written down and the app goes on, rather than a
// fire-and-forget call anywhere taking the whole day's app with it. A throw nobody caught leaves the process in a
// state nobody can vouch for, so it is written down and the process leaves with a failure, for dev.mjs to start again.
export function guardProcess(proc: Emitter = process, log: (line: string) => void = (line) => console.error(line), exit: (code: number) => void = (code) => process.exit(code)) {
  const said = (error: unknown) => (error instanceof Error ? error.stack || error.message : String(error));
  proc.on('unhandledRejection', (error: unknown) => log(`a promise failed and nothing caught it; the app goes on: ${said(error)}`));
  proc.on('uncaughtException', (error: unknown) => { log(`the app stopped on an error nothing caught: ${said(error)}`); exit(1); });
}

// Whether something already listens on this port here.
export function answers(port: number, host = '127.0.0.1', wait = 400): Promise<boolean> {
  return new Promise((settle) => {
    const socket = connect({ port, host });
    const done = (yes: boolean) => { socket.destroy(); settle(yes); };
    socket.setTimeout(wait, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

// Whether the api port is held by the Cubicle service (`pnpm service:install`), running: then `pnpm dev` uses it
// rather than starting a second api into a port that is taken. Anything else on the port (an api left over from a
// killed run, another program) is not trusted: the api is started as always and falls over loudly if it cannot.
// Only the service's own port counts: with the service running on 7421, an api left over on a check's port is still
// somebody else's.
export async function serviceHolds(port: number, ask: Ask = systemctl, own: () => Promise<number> = () => servicePort()): Promise<boolean> {
  if (await ask(['is-active', SERVICE]) !== 'active') return false;
  if (await own() !== port) return false;
  return answers(port);
}
