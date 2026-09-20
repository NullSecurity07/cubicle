import { describe, expect, it } from 'vitest';
import { findKey, HIDDEN, redact, secretValues } from './keys.ts';

// Shapes written the way they really are, with nothing of anybody's real key in them.
const SHAPED = [
  ['an OpenAI or Anthropic key', 'sk-ant-api03-abcdefghijklmnopqrstuvwx'],
  ['a Groq key', 'gsk_abcdefghijklmnopqrstuvwxyz0123'],
  ['a Google key', `AIzaSy${'0'.repeat(33)}`],
  ['an AWS key', 'AKIA0000111122223333'],
  ['a GitHub key', 'ghp_abcdefghijklmnopqrstuvwxyz0123'],
  ['a Slack key', 'xoxb-000000-000000-abcdefghij'],
  ['a Hugging Face key', 'hf_abcdefghijklmnopqrstuvwxyz0123'],
  ['a signed token', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIwMDAwIn0.c2lnbmF0dXJlLWhlcmU'],
  ['a private key file', '-----BEGIN OPENSSH PRIVATE KEY-----'],
];

describe('keys', () => {
  it.each(SHAPED)('knows %s when it sees one', (name, shape) => {
    expect(findKey(`before ${shape} after`, [])).toBe(name);
    expect(redact(`before ${shape} after`, [])).toBe(`before ${HIDDEN} after`);
  });

  it('leaves ordinary writing exactly as it was', () => {
    const plain = 'The launch is on Tuesday. Ask Sam for the sk- prefix convention and the ask-anything doc.';
    expect(findKey(plain, [])).toBeNull();
    expect(redact(plain, [])).toBe(plain);
  });

  it("knows this machine's own secrets by their value, and takes them out whole", () => {
    const own = secretValues({ GROQ_API_KEY: 'a-real-looking-value-here', STAGE_PORT: '7420', SHORT_TOKEN: 'fake', HOME: '/home/founder' });
    expect(own).toEqual(['a-real-looking-value-here']);
    expect(findKey('the key is a-real-looking-value-here', own)).toBe("one of this machine's own keys");
    expect(redact('the key is a-real-looking-value-here, twice: a-real-looking-value-here', own)).toBe(`the key is ${HIDDEN}, twice: ${HIDDEN}`);
    // Short settings are never taken out: blanking the word "fake" out of a founder's sentence would be worse than useless.
    expect(redact('that run was fake and the port was 7420', own)).toBe('that run was fake and the port was 7420');
  });
});
