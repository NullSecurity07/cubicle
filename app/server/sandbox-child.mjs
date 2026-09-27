// Runs inside a locked-down Node process (see sandbox.ts): it may read Pyodide and the shared files folder, write only
// the shared files folder, and has no network, no child processes and no workers. The job comes in as one line on
// stdin and the result goes out as one line on stdout; in between, a line each way carries one tool call, so code can
// use the person's own tools without the wall getting a single hole in it.
import { constants, mkdirSync, readFileSync, readSync, readdirSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import vm from 'node:vm';

const [filesDir, pyodideDir, packageDir] = process.argv.slice(2);

const decoder = new StringDecoder('utf8');
const buffer = Buffer.alloc(65_536);
let rest = '';
// Blocking on purpose: the parent answers a call before anything else happens here, which is what lets `tools.call`
// be an ordinary function in both languages instead of a promise the code has to know about.
function readLine() {
  for (;;) {
    const at = rest.indexOf('\n');
    if (at >= 0) { const line = rest.slice(0, at); rest = rest.slice(at + 1); return line; }
    let read = 0;
    try { read = readSync(0, buffer, 0, buffer.length, null); }
    catch (caught) {
      if (caught?.code !== 'EAGAIN') throw caught;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      continue;
    }
    if (!read) throw new Error('the link to the app closed');
    rest += decoder.write(buffer.subarray(0, read));
  }
}

function writeLine(frame) {
  const bytes = Buffer.from(`${JSON.stringify(frame)}\n`);
  for (let sent = 0; sent < bytes.length;) sent += writeSync(1, bytes, sent, bytes.length - sent);
}

const job = JSON.parse(readLine());
const lines = [];
const say = (...parts) => lines.push(parts.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' '));
const inside = (name) => { const full = resolve(filesDir, String(name)); if (!full.startsWith(filesDir + sep)) throw new Error('path is outside the shared files folder'); return full; };

let calls = 0;
// What the parent ran for us, or why it would not. The count is its own too; this one only keeps the ids apart.
function callTool(name, args) {
  calls += 1;
  writeLine({ t: 'call', id: calls, name: String(name), args: args && typeof args === 'object' ? args : {} });
  const answer = JSON.parse(readLine());
  return { ok: !!answer.ok, text: String(answer.text ?? '') };
}
const names = job.toolNames ?? [];
const tools = {
  names,
  call(name, args) {
    const answer = callTool(name, args);
    if (!answer.ok) throw new Error(answer.text);
    return answer.text;
  },
};

// The same two lines in Python, so code in either language calls a tool the same way.
const PYTHON_TOOLS = `
import json as _json
class _Tools:
    def __init__(self, names):
        self.names = names
    def call(self, name, args=None, **rest):
        answer = _json.loads(_call_tool(name, _json.dumps(args if args is not None else rest)))
        if not answer['ok']:
            raise RuntimeError(answer['text'])
        return answer['text']
tools = _Tools(_json.loads(_tool_names))
del _Tools
`;

// The permission model stops files, programs and the network, but not signals: code that climbs out of vm could still
// kill or abort any process of the user, the app server included. Take those away before any code runs. process.exit
// stays, since ending this process is only ending the sandbox.
for (const name of ['kill', '_kill', 'abort']) {
  Object.defineProperty(process, name, { value: () => { throw new Error('no signals from the sandbox'); }, writable: false, configurable: false });
}

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
    python.globals.set('_call_tool', (name, argsJson) => JSON.stringify(callTool(name, JSON.parse(argsJson))));
    python.globals.set('_tool_names', JSON.stringify(names));
    python.runPython(PYTHON_TOOLS);
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
    // This clock only stops a runaway loop from holding the pipe for ever; the parent's is the real limit. Code that
    // calls tools waits here while the parent works, so it gets the longer one rather than being cut off mid-call.
    const value = vm.runInNewContext(job.code, { console: { log: say, error: say, warn: say, info: say }, files, tools }, { timeout: names.length ? 120_000 : 15_000 });
    if (value !== undefined) say(value);
  }
} catch (caught) {
  error = String(caught?.message ?? caught).split('\n').slice(-6).join('\n');
}
writeLine({ t: 'done', output: lines.join('\n'), error });
