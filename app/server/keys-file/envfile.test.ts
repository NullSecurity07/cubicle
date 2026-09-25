import { parseEnv } from 'node:util';
import { describe, expect, it } from 'vitest';
import { quoted, tailOf, withEnv } from './envfile.ts';

describe('changing one name in .env', () => {
  it('replaces the line that sets it and keeps every other line as it was', () => {
    const text = '# my keys\nGROQ_API_KEY=old\n\nexport OTHER=keep # mine\n';
    expect(withEnv(text, 'GROQ_API_KEY', 'gsk_new')).toBe('# my keys\nGROQ_API_KEY=gsk_new\n\nexport OTHER=keep # mine\n');
  });

  it('adds a name at the end, and makes a file from nothing', () => {
    expect(withEnv('A=1', 'HF_TOKEN', 'hf_x')).toBe('A=1\nHF_TOKEN=hf_x\n');
    expect(withEnv('', 'HF_TOKEN', 'hf_x')).toBe('HF_TOKEN=hf_x\n');
  });

  it('takes out a second line for the same name, which would otherwise be read instead', () => {
    expect(withEnv('K=1\nX=2\nK=3\n', 'K', 'new')).toBe('K=new\nX=2\n');
  });

  it('takes a name out altogether', () => {
    expect(withEnv('K=1\nX=2\n', 'K', null)).toBe('X=2\n');
    expect(withEnv('K=1\n', 'K', null)).toBe('');
  });

  it('quotes what would otherwise be read differently, and reads back exactly what was given', () => {
    for (const value of ['plain-key_123', 'has # hash', 'with spaces', "it's", 'say "hi"', '/home/me/Cubicle backups', 'a=b&c']) {
      expect(parseEnv(withEnv('', 'K', value)).K).toBe(value);
    }
    expect(quoted('abc')).toBe('abc');
    expect(quoted('a b')).toBe("'a b'");
    expect(() => quoted('two\nlines')).toThrow('one line');
    expect(() => quoted(`both ' and "`)).toThrow('both kinds of quote');
  });

  it('refuses a name .env cannot hold', () => {
    expect(() => withEnv('', 'bad name', 'x')).toThrow('not a name');
  });

  it('shows only the last four characters, and only of a long value', () => {
    expect(tailOf('gsk_abcdefghijWXYZ')).toBe('WXYZ');
    expect(tailOf('short')).toBeUndefined();
    expect(tailOf(undefined)).toBeUndefined();
  });
});
