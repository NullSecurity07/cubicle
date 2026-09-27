import { describe, expect, it } from 'vitest';
import type { DashProvider } from '../../shared/dashboard';
import { providerLeft, providerLine } from './providerLine';

const row = (more: Partial<DashProvider>): DashProvider => ({ name: 'gemini', model: 'flash', usedToday: { requests: 3, tokens: 1200 }, limits: { rpd: 1000 }, leftPct: 99, window: 'resets at midnight UTC', ...more });

describe('a model\'s line in the dashboard (round 6)', () => {
  it('says replies, tokens and when the day starts again, as before, for a model with no neuron pool', () => {
    expect(providerLine(row({}))).toBe('3 replies · 1.2k tokens · resets at midnight UTC');
  });

  it('says a Cloudflare model\'s replies of its day\'s allowance and the account\'s neurons of the 9,000, pictures included', () => {
    const cloudflare = row({ name: 'cloudflare-gpt-oss', usedToday: { requests: 1, tokens: 2 }, limits: { rpd: 25 }, neurons: { used: 294, of: 9000, pictures: 58, drawn: 1 } });
    expect(providerLine(cloudflare)).toBe('1 of 25 replies · 2 tokens · 294 of 9,000 neurons, 58 of them on 1 picture · resets at midnight UTC');
    const spent = { ...cloudflare, neurons: { used: 9120, of: 9000, pictures: 0, drawn: 0 }, window: 'daily free turns used; resets at midnight UTC' };
    expect(providerLine(spent)).toBe('1 of 25 replies · 2 tokens · 9,120 of 9,000 neurons · daily free turns used; resets at midnight UTC');
  });
});

describe('what a model\'s row says it has left (hotfix 7)', () => {
  it('says free plan not on for a provider whose keys all want a plan, not "No daily limit", and does not say it twice', () => {
    const off = row({ limits: {}, leftPct: 100, planOff: true, window: 'free plan not on', usedToday: { requests: 0, tokens: 0 } });
    expect(providerLeft(off)).toBe('Free plan not on');
    expect(providerLine(off)).toBe('0 replies · 0 tokens');
  });

  it('gives the share left under a daily limit, and says when there is none', () => {
    expect(providerLeft(row({}))).toBe('99% left');
    expect(providerLeft(row({ limits: {} }))).toBe('No daily limit');
  });
});
