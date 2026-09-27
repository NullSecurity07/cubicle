import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
        expect(result).toMatchObject({ ok: false, output: expect.stringContaining('no signals from the sandbox') });
      }
      const python = await runCode({ language: 'python', code: `import js\ntry:\n    js.process.kill(${pid}, 'SIGTERM')\n    print('SENT')\nexcept Exception as e:\n    print('blocked', e)` }, dir);
      expect(python.output).toContain('no signals from the sandbox');
      await new Promise((wait) => setTimeout(wait, 100));
      expect(alive()).toBe(true);
      expect(dummy.exitCode).toBe(null);
    } finally { dummy.kill('SIGKILL'); }
  }, 90_000);
});
