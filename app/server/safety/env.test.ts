import { describe, expect, it } from 'vitest';
import { childEnv } from './env.ts';

const env = {
  PATH: '/usr/bin', HOME: '/home/founder', XDG_RUNTIME_DIR: '/run/user/1000', LANG: 'en_GB.UTF-8',
  GROQ_API_KEY: 'a-real-looking-value', GEMINI_API_KEY: 'another-one', STAGE_API_TOKEN: 'launch-token-value',
  AGENTMAIL_API_KEY: 'mail-value', SMTP_PASSWORD: 'word', ANTHROPIC_API_KEY: 'coder-value', OPENCODE_BIN: '/usr/bin/opencode',
};

describe('what a child process is started with', () => {
  it('keeps what it needs to work and leaves every key behind', () => {
    const child = childEnv(env);
    expect(child).toEqual({ PATH: '/usr/bin', HOME: '/home/founder', XDG_RUNTIME_DIR: '/run/user/1000', LANG: 'en_GB.UTF-8', OPENCODE_BIN: '/usr/bin/opencode' });
  });

  it('keeps a key only when the call names it, and no other', () => {
    const child = childEnv(env, ['ANTHROPIC_API_KEY']);
    expect(child.ANTHROPIC_API_KEY).toBe('coder-value');
    expect(child.HOME).toBe('/home/founder');
    for (const left of ['GROQ_API_KEY', 'GEMINI_API_KEY', 'STAGE_API_TOKEN', 'AGENTMAIL_API_KEY', 'SMTP_PASSWORD']) expect(child[left]).toBeUndefined();
  });
});
