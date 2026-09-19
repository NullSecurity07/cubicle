// Runs inside a locked-down Node process (see sandbox.ts): it may read Pyodide and the shared files folder, write only
// the shared files folder, and has no network, no child processes and no workers. One job in on stdin, one result out.
import { constants, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import vm from 'node:vm';

const [filesDir, pyodideDir, packageDir] = process.argv.slice(2);
const job = JSON.parse(readFileSync(0, 'utf8'));
const lines = [];
const say = (...parts) => lines.push(parts.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' '));
const inside = (name) => { const full = resolve(filesDir, String(name)); if (!full.startsWith(filesDir + sep)) throw new Error('path is outside the shared files folder'); return full; };

let error;
try {
  if (job.language === 'python') {
    // Emscripten's file layer asks for this one internal table, which the permission model hides. Give it the public one.
    process.binding = (name) => { if (name === 'constants') return { fs: constants }; throw new Error('not available'); };
    const { loadPyodide } = await import(`${pyodideDir}/pyodide.mjs`);
    const python = await loadPyodide({ stdout: say, stderr: (line) => { if (!/Warning/.test(line)) say(line); }, ...(packageDir ? { packageCacheDir: packageDir } : {}) });
    // Wheels come from the folder the server filled; there is no network here to fetch anything else.
    if (job.packages?.length) await python.loadPackage(job.packages, { messageCallback: () => {}, errorCallback: (message) => say(`package problem: ${message}`) });
    python.runPython("import os; os.environ['MPLBACKEND'] = 'Agg'");
    python.FS.mkdirTree('/files');
    python.FS.mount(python.FS.filesystems.NODEFS, { root: filesDir }, '/files');
    python.FS.chdir('/files');
    const value = await python.runPythonAsync(job.code);
    if (value !== undefined && value !== null) say(String(value));
  } else {
    const files = {
      list: () => readdirSync(filesDir, { recursive: true }).map(String),
      read: (name) => readFileSync(inside(name), 'utf8'),
      write: (name, text) => { mkdirSync(dirname(inside(name)), { recursive: true }); writeFileSync(inside(name), String(text)); },
    };
    const value = vm.runInNewContext(job.code, { console: { log: say, error: say, warn: say, info: say }, files }, { timeout: 15_000 });
    if (value !== undefined) say(value);
  }
} catch (caught) {
  error = String(caught?.message ?? caught).split('\n').slice(-6).join('\n');
}
process.stdout.write(JSON.stringify({ output: lines.join('\n'), error }));
