import { describe, expect, it } from 'vitest';
import { DEFAULT_PROXY_BODY_BYTES, proxyBodyLimit } from './bodyLimits';

describe('proxy body limit configuration', () => {
  it('defaults to 8 MiB and accepts aligned custom limits', () => {
    expect(proxyBodyLimit({})).toBe(8 * 1024 * 1024);
    expect(DEFAULT_PROXY_BODY_BYTES).toBe(8388608);
    expect(proxyBodyLimit({ LAUNCHPAD_PROXY_BODY_SIZE_LIMIT: '1048576', BODY_SIZE_LIMIT: '1048576' })).toBe(1048576);
    expect(proxyBodyLimit({ LAUNCHPAD_PROXY_BODY_SIZE_LIMIT: '16777216', BODY_SIZE_LIMIT: '16777217' })).toBe(16777216);
  });
  it('rejects invalid or too-small caps and misaligned adapter configuration', () => {
    for (const value of ['', '0', '-1', '1.5', '8M', 'Infinity', '9007199254740992', '524288']) {
      expect(() => proxyBodyLimit({ LAUNCHPAD_PROXY_BODY_SIZE_LIMIT: value })).toThrow();
    }
    for (const value of ['0', 'Infinity', '8M', '1048576']) {
      expect(() => proxyBodyLimit({ BODY_SIZE_LIMIT: value })).toThrow();
    }
  });
});
