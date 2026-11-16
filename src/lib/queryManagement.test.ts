import { describe, expect, it } from 'vitest';
import {
  describeCancel,
  LIST_SQL_MAX,
  matchesFilter,
  mergeNodeQueries,
  NO_FILTER,
  parseQueryList,
  parseTrackedQuery,
  QUERY_ID_RE,
  tokenLabel,
  type TrackedQuery,
} from './queryManagement';

/** An entry as Arc's registry marshals it (internal/queryregistry/registry.go). */
const arc = (over: Record<string, unknown> = {}) => ({
  id: '3f2a9c1e-7b4',
  sql: 'SELECT * FROM cpu',
  token_id: 7,
  token_name: 'grafana',
  remote_addr: '10.0.0.9',
  status: 'running',
  start_time: '2026-11-17T10:00:00Z',
  duration_ms: 1500,
  is_parallel: false,
  ...over,
});

const q = (over: Partial<TrackedQuery> = {}): TrackedQuery => ({
  nodeId: 'a',
  id: '00000000-001',
  sql: 'SELECT 1',
  sqlTruncated: false,
  tokenId: 7,
  tokenName: 'grafana',
  remoteAddr: null,
  status: 'running',
  startTime: '2026-11-17T10:00:00Z',
  endTime: null,
  durationMs: 0,
  rowCount: null,
  rowCap: null,
  error: null,
  forwardedTo: null,
  ...over,
});

describe('QUERY_ID_RE', () => {
  it("takes Arc's ids and nothing that could spell another route or path", () => {
    expect(QUERY_ID_RE.test('3f2a9c1e-7b4')).toBe(true);
    for (const id of ['active', 'history', '../x', 'A1B2', '', '-abc', 'a'.repeat(37)]) expect(QUERY_ID_RE.test(id)).toBe(false);
  });
});

describe('parseTrackedQuery', () => {
  it('reads a running query from the active list', () => {
    expect(parseTrackedQuery(arc(), 'a', LIST_SQL_MAX, true)).toEqual({
      nodeId: 'a',
      id: '3f2a9c1e-7b4',
      sql: 'SELECT * FROM cpu',
      sqlTruncated: false,
      tokenId: 7,
      tokenName: 'grafana',
      remoteAddr: '10.0.0.9',
      status: 'running',
      startTime: '2026-11-17T10:00:00Z',
      endTime: null,
      durationMs: 1500,
      rowCount: null,
      rowCap: null,
      error: null,
      forwardedTo: null,
    });
  });

  it('reads a finished one, with what Arc omits when empty', () => {
    const parsed = parseTrackedQuery(
      arc({ status: 'failed', end_time: '2026-11-17T10:00:01.123456789Z', duration_ms: undefined, row_count: 0, row_cap: 1000, error: 'boom', token_id: undefined, token_name: undefined }),
      'b',
      LIST_SQL_MAX,
    );
    expect(parsed).toMatchObject({ status: 'failed', endTime: '2026-11-17T10:00:01.123456789Z', durationMs: 0, rowCount: null, rowCap: 1000, error: 'boom', tokenId: null, tokenName: null });
  });

  it('reads a completed query without row_count as no rows, and a forward as not counted', () => {
    const done = { status: 'completed', end_time: '2026-11-17T10:00:01Z' };
    expect(parseTrackedQuery(arc({ ...done, row_count: 42 }), 'a', LIST_SQL_MAX)?.rowCount).toBe(42);
    expect(parseTrackedQuery(arc(done), 'a', LIST_SQL_MAX)?.rowCount).toBe(0);
    expect(parseTrackedQuery(arc({ ...done, forwarded_to: 'reader-1' }), 'a', LIST_SQL_MAX)).toMatchObject({ rowCount: null, forwardedTo: 'reader-1' });
    expect(parseTrackedQuery(arc(), 'a', LIST_SQL_MAX, true)?.rowCount).toBeNull();
  });

  it('marks SQL Arc cut in the active list, and SQL cut here', () => {
    const cut = 'x'.repeat(200) + '...';
    expect(parseTrackedQuery(arc({ sql: cut }), 'a', LIST_SQL_MAX, true)?.sqlTruncated).toBe(true);
    expect(parseTrackedQuery(arc({ sql: 'x'.repeat(200) }), 'a', LIST_SQL_MAX, true)?.sqlTruncated).toBe(false);
    // Arc cuts at 200 bytes: 66 three-byte characters and two of a fourth,
    // which Go's JSON encoder turns into U+FFFD each.
    const multibyte = `${'€'.repeat(66)}\ufffd\ufffd...`;
    expect(parseTrackedQuery(arc({ sql: multibyte }), 'a', LIST_SQL_MAX, true)?.sqlTruncated).toBe(true);
    expect(parseTrackedQuery(arc({ sql: `SELECT '${'€'.repeat(60)}'` }), 'a', LIST_SQL_MAX, true)?.sqlTruncated).toBe(false);
    // The same text in history (Arc does not cut it there) is the query's own.
    expect(parseTrackedQuery(arc({ sql: cut, status: 'completed' }), 'a', LIST_SQL_MAX)?.sqlTruncated).toBe(false);
    const long = parseTrackedQuery(arc({ sql: 'y'.repeat(LIST_SQL_MAX + 5) }), 'a', LIST_SQL_MAX);
    expect(long?.sql).toHaveLength(LIST_SQL_MAX);
    expect(long?.sqlTruncated).toBe(true);
  });

  it('removes control characters but keeps line breaks, without calling the SQL cut', () => {
    const parsed = parseTrackedQuery(arc({ sql: 'SELECT\n\t1\u0000\u001b[31m' }), 'a', LIST_SQL_MAX);
    expect(parsed?.sql).toBe('SELECT\n\t1[31m');
    expect(parsed?.sqlTruncated).toBe(false);
  });

  it('drops what it cannot show or act on', () => {
    for (const bad of [null, [], arc({ id: 'active' }), arc({ id: 5 }), arc({ status: 'queued' }), arc({ start_time: 'yesterday' }), arc({ sql: null })]) {
      expect(parseTrackedQuery(bad, 'a', LIST_SQL_MAX)).toBeNull();
    }
  });
});

describe('parseQueryList', () => {
  it('keeps the statuses that belong to each list and bounds it', () => {
    const body = { queries: [arc({ id: 'aaaa' }), arc({ id: 'bbbb', status: 'completed' }), arc({ id: 'cccc' })] };
    expect(parseQueryList(body, 'a', 10, true)?.queries.map((x) => x.id)).toEqual(['aaaa', 'cccc']);
    expect(parseQueryList(body, 'a', 10, false)?.queries.map((x) => x.id)).toEqual(['bbbb']);
    expect(parseQueryList(body, 'a', 2, true)).toEqual({ queries: [expect.objectContaining({ id: 'aaaa' })], truncated: true });
  });

  it('is null when the body is not a list answer', () => {
    expect(parseQueryList({ success: true }, 'a', 10, true)).toBeNull();
    expect(parseQueryList('nope', 'a', 10, true)).toBeNull();
  });
});

describe('mergeNodeQueries', () => {
  it('shows a query that finished between the two reads once, as finished', () => {
    const m = mergeNodeQueries([
      { nodeId: 'a', active: [q({ id: 'aaaa' }), q({ id: 'bbbb' })], history: [q({ id: 'aaaa', status: 'completed', endTime: '2026-11-17T10:00:02Z' })] },
    ]);
    expect(m.active.map((x) => x.id)).toEqual(['bbbb']);
    expect(m.history.map((x) => [x.id, x.status])).toEqual([['aaaa', 'completed']]);
  });

  it('keeps the same id on different nodes apart', () => {
    const m = mergeNodeQueries([
      { nodeId: 'a', active: [q({ id: 'aaaa' })], history: [] },
      { nodeId: 'b', active: [], history: [q({ nodeId: 'b', id: 'aaaa', status: 'completed', endTime: '2026-11-17T10:00:02Z' })] },
    ]);
    expect(m.active.map((x) => `${x.nodeId}/${x.id}`)).toEqual(['a/aaaa']);
    expect(m.history.map((x) => `${x.nodeId}/${x.id}`)).toEqual(['b/aaaa']);
  });

  it('puts the longest running first and the newest finished first, across nodes', () => {
    const m = mergeNodeQueries([
      {
        nodeId: 'a',
        active: [q({ id: 'a1', startTime: '2026-11-17T10:00:05Z' })],
        history: [q({ id: 'a2', status: 'completed', endTime: '2026-11-17T10:00:01Z' }), q({ id: 'a3', status: 'failed', endTime: '2026-11-17T10:00:09Z' })],
      },
      {
        nodeId: 'b',
        active: [q({ nodeId: 'b', id: 'b1', startTime: '2026-11-17T10:00:01Z' })],
        history: [q({ nodeId: 'b', id: 'b2', status: 'cancelled', endTime: '2026-11-17T10:00:05.5Z' })],
      },
    ]);
    expect(m.active.map((x) => x.id)).toEqual(['b1', 'a1']);
    expect(m.history.map((x) => x.id)).toEqual(['a3', 'b2', 'a2']);
  });

  it('orders a finished query without an end time by when it would have ended', () => {
    const m = mergeNodeQueries([
      { nodeId: 'a', active: [], history: [q({ id: 'a1', status: 'completed', endTime: '2026-11-17T10:00:03Z' }), q({ id: 'a2', status: 'completed', durationMs: 5000 })] },
    ]);
    expect(m.history.map((x) => x.id)).toEqual(['a2', 'a1']);
  });

  it('bounds the history and says so', () => {
    const history = Array.from({ length: 5 }, (_, i) => q({ id: `a${i}`, status: 'completed', endTime: `2026-11-17T10:00:0${i}Z` }));
    const m = mergeNodeQueries([{ nodeId: 'a', active: [], history }], 3);
    expect(m.history.map((x) => x.id)).toEqual(['a4', 'a3', 'a2']);
    expect(m.historyTruncated).toBe(true);
    expect(mergeNodeQueries([{ nodeId: 'a', active: [], history }], 5).historyTruncated).toBe(false);
  });
});

describe('matchesFilter / tokenLabel', () => {
  it('labels a query by its token name, id, or the lack of one', () => {
    expect([tokenLabel(q()), tokenLabel(q({ tokenName: null })), tokenLabel(q({ tokenName: null, tokenId: null }))]).toEqual(['grafana', 'token 7', 'no token']);
  });

  it('filters by node, token, status and text', () => {
    const x = q({ nodeId: 'b', status: 'failed', sql: 'SELECT * FROM Disk', error: 'Out of memory' });
    expect(matchesFilter(x, NO_FILTER)).toBe(true);
    expect(matchesFilter(x, { ...NO_FILTER, node: 'a' })).toBe(false);
    expect(matchesFilter(x, { ...NO_FILTER, node: 'b', token: 'grafana', status: 'failed' })).toBe(true);
    expect(matchesFilter(x, { ...NO_FILTER, token: 'token 7' })).toBe(false);
    expect(matchesFilter(x, { ...NO_FILTER, status: 'completed' })).toBe(false);
    expect(matchesFilter(x, { ...NO_FILTER, search: '  from disk ' })).toBe(true);
    expect(matchesFilter(x, { ...NO_FILTER, search: 'memory' })).toBe(true);
    expect(matchesFilter(x, { ...NO_FILTER, search: '000-001' })).toBe(true);
    expect(matchesFilter(x, { ...NO_FILTER, search: 'cpu' })).toBe(false);
  });
});

describe('describeCancel', () => {
  it('names the query, the node and what happened', () => {
    const base = { nodeId: 'b', queryId: 'aaaa', query: null };
    expect(describeCancel({ ...base, result: 'cancelled' })).toBe('Query aaaa was cancelled on b.');
    expect(describeCancel({ ...base, result: 'cancelled', nodeId: 'standalone' })).toBe('Query aaaa was cancelled.');
    expect(describeCancel({ ...base, result: 'already_finished', query: q({ status: 'completed' }) })).toBe('Query aaaa had already completed on b; nothing was cancelled.');
    expect(describeCancel({ ...base, result: 'already_finished', query: q({ status: 'timed_out' }) })).toBe('Query aaaa had already timed out on b; nothing was cancelled.');
    expect(describeCancel({ ...base, result: 'already_finished', query: q({ status: 'cancelled' }) })).toMatch(/had already been cancelled/);
    expect(describeCancel({ ...base, result: 'already_finished' })).toMatch(/had already finished/);
    expect(describeCancel({ ...base, result: 'not_found' })).toMatch(/no longer known on b.*Nothing was cancelled/);
  });
});
