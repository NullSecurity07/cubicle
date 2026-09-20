import { describe, expect, it } from 'vitest';
import { guard } from '../guard.ts';
import { BODY_LIMIT, DELIVERY, SIGNATURE, TIMESTAMP, WINDOW, createHooks, newSecret, rawBody, sign } from './hooks.ts';

const own = { ports: [7421, 7420], token: 'launch-token' };
const at = 1_700_000_000_000;
const headers = (secret: string, body: string, when: number | string = at, delivery?: string) => ({
  [TIMESTAMP]: String(when), [SIGNATURE]: sign(secret, String(when), body), ...(delivery ? { [DELIVERY]: delivery } : {}),
});
const stream = (chunks: string[]) => ({ async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield Buffer.from(chunk); } }) as any;

describe('a signed call in', () => {
  it('takes a call signed with this hook\'s secret', () => {
    const secret = newSecret();
    const hooks = createHooks(() => at);
    expect(hooks.check(secret, Buffer.from('{"who":"stripe"}'), headers(secret, '{"who":"stripe"}'))).toBeNull();
  });

  it('refuses another hook\'s secret, a changed body and a signature that is merely the right length', () => {
    const hooks = createHooks(() => at);
    const secret = newSecret();
    expect(hooks.check(secret, Buffer.from('{}'), headers(newSecret(), '{}'))).toContain('not signed');
    expect(hooks.check(secret, Buffer.from('{"amount":9}'), headers(secret, '{"amount":1}'))).toContain('not signed');
    expect(hooks.check(secret, Buffer.from('{}'), { [TIMESTAMP]: String(at), [SIGNATURE]: 'f'.repeat(64) })).toContain('not signed');
  });

  it('takes "sha256=" in front of the signature, and seconds instead of milliseconds', () => {
    const secret = newSecret();
    const hooks = createHooks(() => at);
    const signed = headers(secret, '{}', Math.floor(at / 1000));
    expect(hooks.check(secret, Buffer.from('{}'), { ...signed, [SIGNATURE]: `sha256=${signed[SIGNATURE]}` })).toBeNull();
  });

  it('refuses a call with no time on it, or one from outside the five minutes', () => {
    const secret = newSecret();
    const hooks = createHooks(() => at);
    expect(hooks.check(secret, Buffer.from('{}'), { [SIGNATURE]: sign(secret, '', '{}') })).toContain('not stamped');
    expect(hooks.check(secret, Buffer.from('{}'), headers(secret, '{}', at - WINDOW - 1000))).toContain('too old');
    expect(hooks.check(secret, Buffer.from('{}'), headers(secret, '{}', at + WINDOW + 1000))).toContain('too far ahead');
  });

  it('answers a repeated delivery once, and remembers it for a day', () => {
    const secret = newSecret();
    let now = at;
    const hooks = createHooks(() => now);
    expect(hooks.check(secret, Buffer.from('{}'), headers(secret, '{}', now, 'd-1'))).toBeNull();
    expect(hooks.check(secret, Buffer.from('{}'), headers(secret, '{}', now, 'd-1'))).toBe('already done');
    // A day later that delivery is forgotten, along with the memory of it.
    now = at + 86_400_001;
    expect(hooks.check(secret, Buffer.from('{}'), headers(secret, '{}', now, 'd-2'))).toBeNull();
    expect(hooks.remembered()).toBe(1);
  });

  it('will not read a body over a megabyte', async () => {
    await expect(rawBody(stream(['x'.repeat(BODY_LIMIT), 'more']))).rejects.toThrow('too big');
    expect((await rawBody(stream(['a', 'b']))).toString()).toBe('ab');
  });
});

describe('the guard and the one path it lets through', () => {
  const asked = (path: string, method = 'POST') => ({ path, method, headers: { host: '127.0.0.1:7421' } });

  it('lets a signed call in without the launch token', () => {
    expect(guard(asked('/api/hooks/h-1'), own)).toBeNull();
    expect(guard(asked('/api/hooks/h-abc123-de'), own)).toBeNull();
  });

  it('lets nothing else in by that door', () => {
    // Only POST, only that shape, and nothing that walks back up out of it.
    expect(guard(asked('/api/hooks/h-1', 'GET'), own)).toBe('only the app\'s own page may use the api');
    expect(guard(asked('/api/hooks/h-1', 'DELETE'), own)).toBe('only the app\'s own page may use the api');
    expect(guard(asked('/api/hooks/x/../stage'), own)).toBe('only the app\'s own page may use the api');
    expect(guard(asked('/api/hooks/'), own)).toBe('only the app\'s own page may use the api');
    expect(guard(asked('/api/hooks'), own)).toBe('only the app\'s own page may use the api');
    expect(guard(asked('/api/hooks/h-1/run'), own)).toBe('only the app\'s own page may use the api');
    expect(guard(asked(`/api/hooks/${'h'.repeat(61)}`), own)).toBe('only the app\'s own page may use the api');
    expect(guard(asked('/api/stage'), own)).toBe('only the app\'s own page may use the api');
  });

  it('leaves the signature as the only gate, and still refuses a name that merely resolves here', () => {
    // A page on another site may post to this one path — and without the secret it gets nothing but a refusal from
    // the route itself, which is the whole point of signing it.
    expect(guard({ ...asked('/api/hooks/h-1'), headers: { host: '127.0.0.1:7421', origin: 'https://evil.example' } }, own)).toBeNull();
    expect(createHooks(() => at).check(newSecret(), Buffer.from('{}'), {})).toContain('not stamped');
    expect(guard({ ...asked('/api/hooks/h-1'), headers: { host: 'evil.example' } }, own)).toBe('this host name is not this machine');
  });

  it('leaves every other answer of the guard exactly as it was', () => {
    expect(guard({ path: '/api/stage', method: 'GET', headers: { host: 'localhost:7421', 'x-stage-token': own.token } }, own)).toBeNull();
    expect(guard({ path: '/api/stage', method: 'GET', headers: { host: 'localhost:7421', 'sec-fetch-site': 'none' } }, own)).toBeNull();
    expect(guard({ path: '/api/stage', method: 'PUT', headers: { host: 'localhost:7421', 'sec-fetch-site': 'none' } }, own)).toBe('only the app\'s own page may change things');
    expect(guard({ path: '/index.html', method: 'GET', headers: { host: 'localhost:7420' } }, own)).toBeNull();
  });
});
