import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { getPriority, tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { runCode } from './sandbox.ts';

const folder = () => mkdtemp(join(tmpdir(), 'sandbox-'));

describe('sandbox', () => {
  it('runs python against the shared files and keeps what it writes', async () => {
    const dir = await folder();
    await writeFile(join(dir, 'data.csv'), 'a,b\n1,2\n3,4\n');
    const result = await runCode({ language: 'python', code: "import csv\nrows = list(csv.DictReader(open('data.csv')))\nprint('sum', sum(int(r['b']) for r in rows))\n_ = open('out.txt', 'w').write('done')" }, dir);
    expect(result).toEqual({ ok: true, output: 'sum 6' });
    expect(await readFile(join(dir, 'out.txt'), 'utf8')).toBe('done');
  }, 60_000);

  it('runs javascript with a small files helper and reports errors as text', async () => {
    const dir = await folder();
    expect(await runCode({ language: 'javascript', code: "files.write('n/a.txt', 'hi'); console.log(files.read('n/a.txt').toUpperCase()); 6 * 7" }, dir)).toEqual({ ok: true, output: 'HI\n42' });
    expect(await runCode({ language: 'javascript', code: 'nope()' }, dir)).toMatchObject({ ok: false, output: expect.stringContaining('nope is not defined') });
  }, 60_000);

  it('says plainly what the sandbox has when code wants a package it cannot have', async () => {
    const result = await runCode({ language: 'python', code: 'import tensorflow' }, await folder());
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/tensorflow is not available in this sandbox.*Pyodide packages/);
    expect(result.output).not.toMatch(/micropip/);
  }, 60_000);

  it('cannot read the machine, start programs or reach the network, even from escaped code', async () => {
    const dir = await folder();
    const escape = await runCode({ language: 'javascript', code: "const p = this.constructor.constructor('return process')(); const out = []; for (const [name, go] of [['fs', () => p.getBuiltinModule('fs').readFileSync('/etc/hostname', 'utf8')], ['exec', () => p.getBuiltinModule('child_process').execSync('id').toString()], ['write', () => p.getBuiltinModule('fs').writeFileSync('/tmp/escaped.txt', 'x')]]) { try { go(); out.push(name + ' OPEN'); } catch (e) { out.push(name + ' blocked'); } } out.join(', ')" }, dir);
    expect(escape.output).toBe('fs blocked, exec blocked, write blocked');
    const python = await runCode({ language: 'python', code: "import js\ntry:\n    js.process.getBuiltinModule('fs').readFileSync('/etc/hostname', 'utf8')\n    print('OPEN')\nexcept Exception:\n    print('blocked')" }, dir);
    expect(python.output).toBe('blocked');
    expect((await runCode({ language: 'javascript', code: "files.read('../../etc/hostname')" }, dir)).output).toContain('outside the shared files folder');
  }, 90_000);

  it('cannot signal another process, even from escaped code, in either language', async () => {
    const dummy = spawn('sleep', ['60'], { stdio: 'ignore' });
    try {
      const pid = dummy.pid!;
      const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
      const dir = await folder();
      for (const call of [`p.kill(${pid}, 'SIGTERM')`, `p._kill(${pid}, 15)`, 'p.abort()']) {
        const result = await runCode({ language: 'javascript', code: `const p = this.constructor.constructor('return process')(); ${call}; 'SENT'` }, dir);
        expect(result).toMatchObject({ ok: false, output: expect.stringContaining('is not available in the sandbox') });
      }
      const python = await runCode({ language: 'python', code: `import js\ntry:\n    js.process.kill(${pid}, 'SIGTERM')\n    print('SENT')\nexcept Exception as e:\n    print('blocked', e)` }, dir);
      expect(python.output).toContain('is not available in the sandbox');
      await new Promise((wait) => setTimeout(wait, 100));
      expect(alive()).toBe(true);
      expect(dummy.exitCode).toBe(null);
    } finally { dummy.kill('SIGKILL'); }
  }, 90_000);

  it('cannot change any other process, reach os or the network, or read the app\'s environment, even from escaped code', async () => {
    const dummy = spawn('sleep', ['120'], { stdio: 'ignore' });
    let hits = 0;
    const server = createServer((_request, response) => { hits += 1; response.end('hi'); }).listen(0, '127.0.0.1');
    process.env.SANDBOX_PARENT_SECRET = 'parent-only';
    try {
      await new Promise((ready) => server.once('listening', ready));
      const port = (server.address() as { port: number }).port;
      const pid = dummy.pid!;
      const nice = getPriority(pid);
      const dir = await folder();
      const escaped = "const p = this.constructor.constructor('return process')(); ";
      const refused: Record<string, string> = {
        setPriority: `p.getBuiltinModule('os').setPriority(${pid}, 19)`,
        'node:os': "p.getBuiltinModule('node:os').hostname()",
        debugProcess: `p._debugProcess(${pid})`,
        dlopen: "p.dlopen({ exports: {} }, '/usr/lib/libc.so.6')",
        setuid: 'p.setuid(0)',
        umask: 'p.umask(0)',
        chdir: "p.chdir('/')",
        execve: "p.execve('/bin/sh', ['sh'])",
        loadEnvFile: "p.loadEnvFile('/etc/environment')",
        net: `p.getBuiltinModule('net').connect(${port}, '127.0.0.1')`,
        dgram: "p.getBuiltinModule('dgram').createSocket('udp4')",
        http: `p.getBuiltinModule('http').get('http://127.0.0.1:${port}/')`,
        child_process: "p.getBuiltinModule('child_process').execSync('id')",
        worker_threads: "new (p.getBuiltinModule('worker_threads').Worker)('1', { eval: true })",
        inspector: 'p.getBuiltinModule(\'inspector\').open(9339)',
        module: "p.getBuiltinModule('module').createRequire('/')('os')",
        procEnviron: `p.getBuiltinModule('fs').readFileSync('/proc/${process.pid}/environ', 'utf8')`,
        fetch: `this.constructor.constructor('return fetch')()('http://127.0.0.1:${port}/'); p.getBuiltinModule('fs').readFileSync('/proc/self/status')`,
      };
      for (const [name, call] of Object.entries(refused)) {
        const result = await runCode({ language: 'javascript', code: `${escaped}${call}; 'REACHED'` }, dir);
        expect({ name, ...result }).toMatchObject({ name, ok: false });
        expect(result.output).not.toContain('REACHED');
      }
      // A module loaded through import() meets the same wall as getBuiltinModule.
      await runCode({ language: 'javascript', code: `${escaped}this.constructor.constructor('return import("node:os")')().then((os) => os.setPriority(${pid}, 18), () => {}); 'x'` }, dir);
      const python = await runCode({ language: 'python', code: `import js
for name, go in [('os', lambda: js.process.getBuiltinModule('os').setPriority(${pid}, 17)), ('debug', lambda: js.process._debugProcess(${pid})), ('require', lambda: js.require('child_process').execSync('id'))]:
    try:
        go()
        print(name, 'OPEN')
    except Exception:
        print(name, 'blocked')` }, dir);
      expect(python.output).toBe('os blocked\ndebug blocked\nrequire blocked');
      expect((await runCode({ language: 'javascript', code: `${escaped}JSON.stringify(p.env)` }, dir)).output).toBe('{}');
      await new Promise((wait) => setTimeout(wait, 300));
      expect(getPriority(pid)).toBe(nice);
      expect(dummy.exitCode).toBe(null);
      expect(dummy.signalCode).toBe(null);
      expect(hits).toBe(0);
    } finally {
      delete process.env.SANDBOX_PARENT_SECRET;
      dummy.kill('SIGKILL');
      server.close();
    }
  }, 120_000);

  it('still runs ordinary work after the lockdown: math, JSON, dates and the files handed to it, in both languages', async () => {
    const dir = await folder();
    await writeFile(join(dir, 'plan.json'), '{"price": 9, "users": 120}');
    const js = await runCode({ language: 'javascript', code: "const plan = JSON.parse(files.read('plan.json')); console.log(Math.round(plan.price * plan.users * 1.1), new Date(0).toISOString()); files.write('out.json', JSON.stringify({ ok: true })); files.list().sort().join(',')" }, dir);
    expect(js).toEqual({ ok: true, output: '1188 1970-01-01T00:00:00.000Z\nout.json,plan.json' });
    const py = await runCode({ language: 'python', code: "import json, math, statistics, datetime, time\nplan = json.load(open('plan.json'))\nprint(plan['price'] * plan['users'], math.sqrt(16), statistics.mean([1, 2, 3]), datetime.date(2026, 1, 1).isoformat(), time.time() > 0)" }, dir);
    expect(py).toEqual({ ok: true, output: '1080 4.0 2 2026-01-01 True' });
  }, 90_000);
});
