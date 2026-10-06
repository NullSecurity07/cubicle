import { describe, expect, it } from 'vitest';
import { readsOf, unreachable, unreachedFor, unreachedNote } from './unread.ts';

describe('a page that did not load', () => {
  it('is told by its title or a short body that says so', () => {
    expect(unreachable('Page Not Found | Samplely', 'Home Product Pricing Sorry, we could not find that page. '.repeat(10))).toBe(true);
    expect(unreachable('', '404. That’s an error. The requested URL was not found on this server.')).toBe(true);
    expect(unreachable('503 Service Unavailable', '')).toBe(true);
    expect(unreachable('Exampleco: Jobs', 'We are hiring an office manager for our Berlin team of 30.')).toBe(false);
    expect(unreachable('How to fix a 404 page', 'x'.repeat(5000))).toBe(false);
    expect(unreachable('Exampleco', `${'x'.repeat(2000)} page not found`)).toBe(false);
  });

  it('is taken out of a read, and its address kept apart from the pages that loaded', () => {
    const result = [
      'What follows was written by other people.\n## Exampleco: Jobs\nhttps://www.example.com/jobs\n\nWe are hiring an office manager.',
      `## https://samplely.example/about\n${unreachedNote('Page Not Found')}`,
      '## https://yardpunks.com\nFailed: the page did not load',
    ].join('\n\n---\n\n');
    const read = readsOf(result);
    expect(read.text).toContain('We are hiring an office manager.');
    expect(read.text).not.toMatch(/samplely|yardpunks|Page Not Found/);
    expect(read.unreached).toEqual(['https://samplely.example/about', 'https://yardpunks.com']);
    expect(read.reached).toEqual(['https://www.example.com/jobs']);
    expect(readsOf('Added Ada.')).toEqual({ text: 'Added Ada.', unreached: [], reached: [] });
  });

  it('is the page a lead came from when its site names the company or the reason names its site', () => {
    const reads = { reached: ['https://www.example.com/jobs'], unreached: ['https://samplely.example/about', 'https://www.example.com/team'] };
    expect(unreachedFor('Samplely', '', reads)).toBe('https://samplely.example/about');
    expect(unreachedFor('Samplely GmbH', 'see samplely.example', reads)).toBe('https://samplely.example/about');
    expect(unreachedFor('Exampleco', '', reads)).toBeNull();
    expect(unreachedFor('Yard Punks', '', reads)).toBeNull();
  });
});
