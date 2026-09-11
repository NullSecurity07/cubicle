import { describe, it, expect } from 'vitest';
import { isOwnerOwned, assertWritable, OwnerOwnedPathError, isCachePath } from '../src/guard.js';

describe('guard', () => {
  it('flags owner-owned paths', () => {
    expect(isOwnerOwned('Brand/palette.md')).toBe(true);
    expect(isOwnerOwned('Roles/ceo.md')).toBe(true);
    expect(isOwnerOwned('Memory/constitution.md')).toBe(true);
    expect(isOwnerOwned('Memory/lessons.md')).toBe(false);
    expect(isOwnerOwned('Jobs/x.md')).toBe(false);
    expect(isOwnerOwned('Plans/plan.md', ['Plans/'])).toBe(true);
  });
  it('blocks agents, allows privileged actors', () => {
    expect(() => assertWritable('Brand/name.md', 'backend_engineer')).toThrow(OwnerOwnedPathError);
    expect(() => assertWritable('Brand/name.md', 'daemon')).not.toThrow();
    expect(() => assertWritable('Site/index.html', 'backend_engineer')).not.toThrow();
  });
  it('identifies cache paths', () => {
    expect(isCachePath('.cubicle/cubicle.db')).toBe(true);
    expect(isCachePath('.obsidian/app.json')).toBe(true);
    expect(isCachePath('Site/dist/index.html')).toBe(true);
    expect(isCachePath('Site/src/index.astro')).toBe(false);
  });
  it('treats a stream workspace\'s generated directories as cache, and its source as source', () => {
    // vault-template/.gitignore declares these; the recursive scan must not walk a stream's dependencies.
    expect(isCachePath('Workspace/checkout/node_modules/left-pad/index.js')).toBe(true);
    expect(isCachePath('Workspace/checkout/dist/bundle.js')).toBe(true);
    expect(isCachePath('Workspace/checkout/dist')).toBe(true);
    expect(isCachePath('Workspace/checkout/.venv/bin/python')).toBe(true);
    // Only ci.run may put a record here, so vault.write must refuse it (a forged green record ships code).
    expect(isCachePath('Workspace/checkout/.cubicle-ci/2026-09-11T10-00-00-000Z.json')).toBe(true);
    expect(isCachePath('Workspace/checkout/src/index.js')).toBe(false);
    expect(isCachePath('Workspace/checkout/cubicle-ci.yaml')).toBe(false);
    expect(isCachePath('Workspace/README.md')).toBe(false);
    expect(isCachePath('Workspace/node_modules/x')).toBe(false); // not inside a stream
  });
});
