import { describe, expect, it } from 'vitest';
import { compact } from './numbers';

describe('compact', () => {
  it('says a count the way a person says it', () => {
    expect([940, 1000, 1240, 12_400, 999_000, 1_300_000, 2_000_000].map(compact)).toEqual(['940', '1k', '1.2k', '12k', '999k', '1.3M', '2M']);
  });
});
