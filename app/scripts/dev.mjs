// Starts the api server and Vite together; stops both when either exits.
import { spawn } from 'node:child_process';

const run = (command, args) => spawn(command, args, { stdio: 'inherit', env: process.env });
// One more folder to watch, named from outside: the browser checks restart the api the way a deploy does, and this is
// how they do it without writing a byte into the code the founder's own app is watching.
const extra = process.env.STAGE_RESTART_DIR ? [`--watch-path=${process.env.STAGE_RESTART_DIR}`] : [];
// The browser checks switch the code watch off: an edit under server/ while they run used to restart the api under
// a journey half way through it, which is a failure of the edit, not of the journey.
const code = process.env.STAGE_NO_CODE_WATCH === '1' ? [] : ['--watch-path=server', '--watch-path=shared'];
const children = [run('node', [...code, ...extra, 'server/index.ts']), run('pnpm', ['exec', 'vite'])];
const stop = () => { for (const child of children) child.kill('SIGTERM'); };
for (const child of children) child.on('exit', () => { stop(); process.exit(); });
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
