// Starts the api server and Vite together. The api is started again when it falls over, up to three times in a
// minute; Vite leaving, a fourth fall in a minute, or being told to stop, stops both.
import { spawn } from 'node:child_process';
import { restartBudget } from '../server/restart.ts';

const run = (command, args) => spawn(command, args, { stdio: 'inherit', env: process.env });
// One more folder to watch, named from outside: the browser checks restart the api the way a deploy does, and this is
// how they do it without writing a byte into the code the founder's own app is watching.
const extra = process.env.STAGE_RESTART_DIR ? [`--watch-path=${process.env.STAGE_RESTART_DIR}`] : [];
// The browser checks switch the code watch off: an edit under server/ while they run used to restart the api under
// a journey half way through it, which is a failure of the edit, not of the journey.
const code = process.env.STAGE_NO_CODE_WATCH === '1' ? [] : ['--watch-path=server', '--watch-path=shared'];
const budget = restartBudget({ times: 3, within: 60_000 });
let stopping = false;
let api;
const vite = run('pnpm', ['exec', 'vite']);
const stop = () => { stopping = true; api?.kill('SIGTERM'); vite.kill('SIGTERM'); };

function startApi() {
  api = run('node', [...code, ...extra, 'server/index.ts']);
  api.on('exit', (status, signal) => {
    // A clean leave (the desktop shell closing it), our own stop, or Ctrl-C reaching it before it reached us ends
    // everything, as it always did.
    if (stopping || status === 0 || signal === 'SIGINT' || signal === 'SIGTERM') { stop(); process.exit(status ?? 0); }
    if (budget.allow()) {
      console.error(`the api stopped (${signal ?? `exit ${status}`}); starting it again`);
      startApi();
      return;
    }
    console.error('the api stopped four times in a minute; giving up');
    stop();
    process.exit(1);
  });
}
startApi();
vite.on('exit', () => { stop(); process.exit(); });
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
