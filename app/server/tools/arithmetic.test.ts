import { describe, expect, it } from 'vitest';
import { plainArithmetic } from './arithmetic.ts';

describe('plain arithmetic', () => {
  it('takes short code that only works numbers out and prints them', () => {
    expect(plainArithmetic('python', 'cash = 9800\nburn = 1650 - 78\nprint(round(cash / burn, 2))')).toBe(true);
    expect(plainArithmetic('javascript', 'const months = 9800 / 1650;\nconsole.log(months.toFixed(1));')).toBe(true);
    expect(plainArithmetic('python', 'rows = [1, 2, 3]\nfor r in rows:\n    print(r * 12.5)')).toBe(true);
  });

  it('turns down anything that imports, or reaches files, the network, the process or the environment', () => {
    for (const code of ['import math\nprint(math.sqrt(2))', 'from os import path', "__import__('os')", "open('notes.md').read()", 'import os\nprint(os.environ)',
      "exec('1')", "eval('1')", "getattr(1, 'real')", 'import subprocess', 'import socket', 'import sys\nsys.exit()']) {
      expect(plainArithmetic('python', code), code).toBe(false);
    }
    for (const code of ["require('fs')", "import fs from 'fs'", "await import('node:child_process')", 'process.env.KEY', "fetch('https://x.test')",
      "files.write('a.txt', 'x')", "tools.call('read_file', {})", 'globalThis.x = 1', "new Function('return 1')()", 'eval("1")', "Deno.readTextFile('a')"]) {
      expect(plainArithmetic('javascript', code), code).toBe(false);
    }
  });

  it('turns down long code, empty code and a language it does not know', () => {
    expect(plainArithmetic('python', Array.from({ length: 41 }, (_, i) => `x${i} = ${i}`).join('\n'))).toBe(false);
    expect(plainArithmetic('python', Array.from({ length: 40 }, (_, i) => `x${i} = ${i}`).join('\n'))).toBe(true);
    expect(plainArithmetic('python', '   ')).toBe(false);
    expect(plainArithmetic('ruby', '1 + 1')).toBe(false);
  });
});
