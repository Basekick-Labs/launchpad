import { describe, expect, it } from 'vitest';
import { queryFailure, readQueryResult } from './arcQuery';

const res = (status: number, body: string, headers: Record<string, string> = {}) => ({ status, headers, body: Buffer.from(body) });

describe('readQueryResult', () => {
  it('reads rows from Arc\'s data field', () => {
    expect(readQueryResult(res(200, JSON.stringify({ success: true, columns: ['1'], data: [[1]] })))).toEqual({ ok: true, rows: [[1]] });
    expect(readQueryResult(res(200, JSON.stringify({ success: true, columns: [], data: [] })))).toEqual({ ok: true, rows: [] });
  });

  it('names governance throttling instead of reading it as no results', () => {
    expect(readQueryResult(res(429, '{}', { 'retry-after': '60' }))).toEqual({ ok: false, error: 'Throttled by Arc query governance (retry after 60s)' });
    expect(queryFailure(429, undefined)).toBe('Throttled by Arc query governance');
    expect(queryFailure(500, undefined)).toBe('Arc answered 500');
  });

  it('calls a body that is not a query result unreadable', () => {
    for (const body of ['not json', 'null', '"x"', '[1]', '{"data":"x"}']) {
      expect(readQueryResult(res(200, body))).toEqual({ ok: false, error: 'Arc returned an unreadable response' });
    }
  });
});
