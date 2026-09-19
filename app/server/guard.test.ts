import { describe, expect, it } from 'vitest';
import { guard } from './guard.ts';

const own = { ports: [7421, 7420], token: 'secret-token' };
const ask = (path: string, method: string, headers: Record<string, string>) => guard({ path, method, headers }, own);

describe('guard', () => {
  it('lets the app\'s own page through', () => {
    expect(ask('/api/stage', 'GET', { host: '127.0.0.1:7421', 'sec-fetch-site': 'same-origin' })).toBeNull();
    expect(ask('/api/rooms/build/chat', 'POST', { host: 'localhost:7420', origin: 'http://localhost:7420', 'sec-fetch-site': 'same-origin' })).toBeNull();
  });

  it('lets the founder open a file address by hand, but only to read', () => {
    expect(ask('/api/files/chart.png', 'GET', { host: '127.0.0.1:7421', 'sec-fetch-site': 'none' })).toBeNull();
    expect(ask('/api/stage', 'PUT', { host: '127.0.0.1:7421', 'sec-fetch-site': 'none' })).toMatch(/another site|own page/);
  });

  it('refuses a name that is not this machine: DNS rebinding', () => {
    expect(ask('/api/stage', 'GET', { host: 'evil.example:7421', 'sec-fetch-site': 'same-origin' })).toMatch(/host/i);
    expect(ask('/', 'GET', { host: 'evil.example' })).toMatch(/host/i);
    expect(ask('/', 'GET', {})).toMatch(/host/i);
  });

  it('refuses another site, a sandboxed preview and another local app', () => {
    expect(ask('/api/approvals/x', 'POST', { host: '127.0.0.1:7421', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' })).not.toBeNull();
    expect(ask('/api/stage', 'GET', { host: '127.0.0.1:7421', 'sec-fetch-site': 'cross-site' })).not.toBeNull();
    expect(ask('/api/stage', 'PUT', { host: '127.0.0.1:7421', origin: 'null', 'sec-fetch-site': 'same-origin' })).not.toBeNull();
    expect(ask('/api/stage', 'PUT', { host: '127.0.0.1:7421', origin: 'http://localhost:3000' })).not.toBeNull();
    expect(ask('/api/stage', 'GET', { host: '127.0.0.1:7421', 'sec-fetch-site': 'same-site' })).not.toBeNull();
  });

  it('refuses a bare request: a server-side fetch bounced here by a redirect', () => {
    expect(ask('/api/stage', 'GET', { host: '127.0.0.1:7421' })).not.toBeNull();
  });

  it('accepts an engine without fetch metadata when Origin or Referer is the app itself', () => {
    expect(ask('/api/stage', 'PUT', { host: '127.0.0.1:7421', origin: 'http://127.0.0.1:7421' })).toBeNull();
    expect(ask('/api/stage', 'GET', { host: '127.0.0.1:7421', referer: 'http://127.0.0.1:7421/' })).toBeNull();
    expect(ask('/api/stage', 'GET', { host: '127.0.0.1:7421', referer: 'https://evil.example/http://127.0.0.1:7421/' })).not.toBeNull();
  });

  it('accepts scripts and tests that carry the token, and no wrong token', () => {
    expect(ask('/api/stage', 'PUT', { host: 'localhost:7430', 'x-stage-token': 'secret-token' })).toBeNull();
    expect(ask('/api/stage', 'PUT', { host: 'localhost:7430', 'x-stage-token': 'guess' })).not.toBeNull();
    expect(ask('/api/stage', 'PUT', { host: 'evil.example', 'x-stage-token': 'secret-token' })).toMatch(/host/i);
  });

  it('serves the client itself to any local visitor', () => {
    expect(ask('/', 'GET', { host: '127.0.0.1:7421' })).toBeNull();
    expect(ask('/assets/index.js', 'GET', { host: 'localhost:7421', 'sec-fetch-site': 'cross-site' })).toBeNull();
  });
});
