import { describe, expect, it } from 'vitest';
import { APPS, appName, playbookOf, preset, signedIn } from './apps.ts';

describe('app presets', () => {
  it('knows where each app sends a visitor who is not signed in', () => {
    expect(signedIn(preset('linkedin'), 'https://www.linkedin.com/feed/')).toBe(true);
    expect(signedIn(preset('linkedin'), 'https://www.linkedin.com/login?fromSignIn=true')).toBe(false);
    expect(signedIn(preset('linkedin'), 'https://www.linkedin.com/authwall?trk=x')).toBe(false);
    expect(signedIn(preset('linkedin'), 'https://www.linkedin.com/checkpoint/challenge/abc')).toBe(false);
    expect(signedIn(preset('x'), 'https://x.com/home')).toBe(true);
    expect(signedIn(preset('x'), 'https://x.com/i/flow/login')).toBe(false);
    expect(signedIn(preset('gmail'), 'https://mail.google.com/mail/u/0/#inbox')).toBe(true);
    expect(signedIn(preset('gmail'), 'https://accounts.google.com/v3/signin/identifier?x=1')).toBe(false);
  });
  it('claims nothing about a custom app, or about a page that has not loaded', () => {
    expect(signedIn(preset('custom', 'Notion', 'https://www.notion.so/'), 'https://www.notion.so/login')).toBeNull();
    expect(signedIn(preset('linkedin'), '')).toBeNull();
    expect(signedIn(preset('linkedin'), 'about:blank')).toBeNull();
  });
  it('makes a preset from a key, and a custom one from a name and a home', () => {
    expect(preset('linkedin')).toEqual({ key: 'linkedin', name: 'LinkedIn', home: 'https://www.linkedin.com/feed/' });
    expect(preset('custom', 'Notion', 'notion.so')).toEqual({ key: 'custom', name: 'Notion', home: 'https://notion.so/' });
    expect(() => preset('custom', '', 'https://a.b')).toThrow(/name/);
    expect(() => preset('custom', 'A', '')).toThrow(/address/);
  });
  it('has a playbook for every app that names no year', () => {
    for (const spec of Object.values(APPS)) expect(spec.playbook).not.toMatch(/\b(19|20)\d{2}\b/);
    expect(playbookOf(preset('linkedin'))).toContain('linkedin.com/search/results/people/');
    expect(playbookOf(preset('custom', 'Notion', 'https://www.notion.so/'))).toContain('Learn the site by looking before acting');
  });
  it('names a card', () => {
    expect(appName({ id: 'b', kind: 'browser', x: 0, y: 0, w: 1, h: 1 })).toBe('Browser');
    expect(appName({ id: 'b', kind: 'browser', app: preset('x'), x: 0, y: 0, w: 1, h: 1 })).toBe('X');
    expect(appName({ id: 'n', kind: 'note', text: '', x: 0, y: 0, w: 1, h: 1 })).toBe('');
  });
});
