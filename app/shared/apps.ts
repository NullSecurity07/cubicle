import type { Card } from './model.ts';

export type AppKey = 'linkedin' | 'x' | 'gmail' | 'custom';
// What a browser card carries when it is a named app: enough to open it, show it and tell a person what it is.
export type AppPreset = { key: AppKey; name: string; home: string };
export type AppSpec = { key: AppKey; name: string; home: string; signInUrls: RegExp[]; playbook: string };

// Playbooks are what a wired person is told about a site: where to search, what an address looks like, what waits
// for the founder. Facts about the site's layout only; nothing about a date.
export const APPS: Record<Exclude<AppKey, 'custom'>, AppSpec> = {
  linkedin: {
    key: 'linkedin', name: 'LinkedIn', home: 'https://www.linkedin.com/feed/',
    signInUrls: [/linkedin\.com\/(login|authwall|checkpoint\/|uas\/)/i],
    playbook: 'Search people at https://www.linkedin.com/search/results/people/?keywords=<words>. A profile is https://www.linkedin.com/in/<handle>/, a company is https://www.linkedin.com/company/<handle>/, the feed is the home address. Connect, Follow, Message and Post wait for the founder.',
  },
  x: {
    key: 'x', name: 'X', home: 'https://x.com/home',
    signInUrls: [/x\.com\/(i\/flow\/(login|signup)|login)/i],
    playbook: 'Search at https://x.com/search?q=<words>&f=live for the newest posts first. A profile is https://x.com/<handle>; the timeline is the home address. Post, Reply, Repost, Like and Follow wait for the founder.',
  },
  gmail: {
    key: 'gmail', name: 'Gmail', home: 'https://mail.google.com/mail/u/0/',
    signInUrls: [/^https?:\/\/accounts\.google\.com\//i],
    playbook: 'The inbox is the home address. Search with the box at the top. Compose opens a draft; Send waits for the founder.',
  },
};
export const CUSTOM_PLAYBOOK = 'The founder added this app and signed in. Learn the site by looking before acting.';

const address = (raw: string) => { const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`); return url.href; };
export function preset(key: AppKey, name = '', home = ''): AppPreset {
  if (key !== 'custom') return { key, name: APPS[key].name, home: APPS[key].home };
  if (!name.trim()) throw new Error('an app needs a name');
  if (!home.trim()) throw new Error('an app needs a web address');
  return { key, name: name.trim(), home: address(home.trim()) };
}
// true or false when the preset has a rule and the page has loaded; null is "nothing is known".
export function signedIn(app: AppPreset, landedOn: string): boolean | null {
  if (app.key === 'custom' || !landedOn || /^about:/.test(landedOn)) return null;
  return !APPS[app.key].signInUrls.some((rule) => rule.test(landedOn));
}
export const playbookOf = (app: AppPreset) => (app.key === 'custom' ? CUSTOM_PLAYBOOK : APPS[app.key].playbook);
export const appName = (card?: Card) => (card?.kind === 'browser' ? card.app?.name ?? 'Browser' : '');
