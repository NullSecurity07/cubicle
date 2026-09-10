import { describe, it, expect } from 'vitest';
import { sitePathHint } from '../src/tools/shell.js';

describe('shell.run cwd hint (live run: `ls Site/` from inside /work/Site)', () => {
  it('a failed command that used vault-relative Site/ paths from the Site cwd gets told where it is', () => {
    const h = sitePathHint('cat Site/astro.config.mjs', 'Site', false);
    expect(h).toMatch(/cwd is \/work\/Site/);
    expect(h).toMatch(/astro\.config\.mjs/);
    expect(sitePathHint("ls -la 'Site/'", 'Site', false)).toMatch(/cwd is \/work\/Site/);
  });
  it('is silent when the command succeeded, ran from scratch, or did not mention Site/', () => {
    expect(sitePathHint('cat Site/astro.config.mjs', 'Site', true)).toBe('');
    expect(sitePathHint('ls ../Site/', 'Site', false)).toBe('');
    expect(sitePathHint('ls /work/Site', 'Site', false)).toBe('');
    expect(sitePathHint('ls Site/', 'scratch', false)).toBe('');
    expect(sitePathHint('npm run build', 'Site', false)).toBe('');
  });
});
