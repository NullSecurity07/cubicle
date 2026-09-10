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
});
