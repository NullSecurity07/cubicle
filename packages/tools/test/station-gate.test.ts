/**
 * The third rule on what a role may use: the office floor (SP9b).
 *
 * A tool whose family has a station standing on the campus is only for a desk with a line to it. A family with
 * no station is not gated at all, which is what keeps a vault that has never had an `Office/campus.md` working
 * exactly as it did.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { RoleFrontmatter, type CampusLayout } from '@cubicle/core';
import { parseToolsConfig, ToolRegistry, phase3Tools, phase5Tools, phase6Tools } from '../src/index.js';

const cfg = parseToolsConfig(readFileSync(path.resolve(__dirname, '../../../config/tools.yaml'), 'utf8'));
const reg = new ToolRegistry().registerAll([...phase3Tools({ includeMock: true }), ...phase5Tools(), ...phase6Tools()]);
const role = RoleFrontmatter.parse({
  role: 'cmo', display: 'CMO', hired: '', sprite: 'cmo', desk: 'cmo',
  tools: ['browser.*', 'email.*', 'vault.read', 'skills.*'],
});

const layout = (nodes: CampusLayout['nodes'], connections: CampusLayout['connections'] = []): CampusLayout => ({ version: 1, nodes, connections });
const names = (l: CampusLayout | null): string[] => reg.forRole(role, cfg, l).map((t) => t.name);

const BROWSER = { station_browser: { kind: 'browser' as const, tool: 'browser', x: 22, y: 23 } };

describe('the station gate', () => {
  it('gates nothing when there is no office note', () => {
    expect(names(null)).toEqual(expect.arrayContaining(['browser.goto', 'email.send', 'vault.read']));
  });

  it('gates nothing when the family has no station on the campus', () => {
    expect(names(layout({}))).toEqual(expect.arrayContaining(['browser.goto', 'email.send']));
  });

  it('takes the browser away from a desk with no line to the browser station', () => {
    const cut = names(layout(BROWSER));
    expect(cut).not.toContain('browser.goto');
    expect(cut).not.toContain('browser.open');
    expect(cut).toContain('email.send');      // no email station on this campus, so email is untouched
    expect(cut).toContain('vault.read');      // and a tool with no family at all is never gated
  });

  it('gives it back when the owner draws the line, either way round', () => {
    expect(names(layout(BROWSER, [{ from: 'cmo', to: 'station_browser', kind: 'access' }]))).toContain('browser.goto');
    expect(names(layout(BROWSER, [{ from: 'station_browser', to: 'cmo', kind: 'access' }]))).toContain('browser.goto');
  });

  it('reads the desk from the charter, not the role id', () => {
    const hire = { ...role, role: 'account_exec', desk: 'sales_2' };
    expect(reg.forRole(hire, cfg, layout(BROWSER)).map((t) => t.name)).not.toContain('browser.goto');
    expect(reg.forRole(hire, cfg, layout(BROWSER, [{ from: 'sales_2', to: 'station_browser', kind: 'access' }])).map((t) => t.name)).toContain('browser.goto');
  });
});
