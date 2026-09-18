// Starts the api server and Vite together; stops both when either exits.
import { spawn } from 'node:child_process';

const run = (command, args) => spawn(command, args, { stdio: 'inherit', env: process.env });
const children = [run('node', ['--watch-path=server', '--watch-path=shared', 'server/index.ts']), run('pnpm', ['exec', 'vite'])];
const stop = () => { for (const child of children) child.kill('SIGTERM'); };
for (const child of children) child.on('exit', () => { stop(); process.exit(); });
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
