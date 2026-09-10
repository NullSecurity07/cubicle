import { describe, it, expect } from 'vitest';
import { stripThinking } from '../src/client.js';

describe('stripThinking', () => {
  it('drops <thought>…</thought> and <think>…</think> blocks (Gemma 4 and qwen leak them into content)', () => {
    expect(stripThinking('<thought>The user wants a pong.</thought>pong')).toBe('pong');
    expect(stripThinking('<think>\nplan\n</think>\n\nAnswer here')).toBe('Answer here');
    expect(stripThinking('a <thought>x</thought> b <thought>y</thought> c')).toBe('a  b  c');
  });
  it('drops an unterminated block only when nothing but the block was returned, and leaves plain text alone', () => {
    expect(stripThinking('<thought>cut off by max_tokens')).toBe('');
    expect(stripThinking('no tags here')).toBe('no tags here');
    expect(stripThinking('')).toBe('');
  });
});
