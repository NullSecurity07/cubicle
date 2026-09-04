import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseToolsConfig, ToolRegistry, phase3Tools, phase5Tools, phase6Tools, resolveMode } from '../src/index.js';

const cfg = parseToolsConfig(readFileSync(path.resolve(__dirname, '../../../config/tools.yaml'), 'utf8'));
const registry = new ToolRegistry().registerAll([...phase3Tools({ includeMock: true }), ...phase5Tools(), ...phase6Tools()]);

describe('config/tools.yaml covers the registry', () => {
  it('every tool the registry exposes has a row', () => {
    const missing = registry.names().filter((n) => !cfg.tools[n]);
    expect(missing).toEqual([]);
  });

  it('no row names a tool the registry does not expose', () => {
    const stale = Object.keys(cfg.tools).filter((n) => !registry.get(n));
    expect(stale).toEqual([]);
  });

  it('a declared mode beats the auto default', () => {
    expect(resolveMode('git.revert', cfg)).toBe('auto');
    expect(resolveMode('email.send', cfg)).toBe('ask');
  });
});
