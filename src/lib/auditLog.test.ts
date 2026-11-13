import { describe, expect, it } from 'vitest';
import {
  compareEvents,
  eventTone,
  inputToIso,
  mergeNodePages,
  mergeStats,
  parseAuditEntries,
  parseAuditEntry,
  parseAuditStats,
  rangeBounds,
  type AuditEvent,
  type NodePage,
} from './auditLog';

/** An entry as Arc's /api/v1/audit/logs sends it (internal/audit/audit.go AuditEntry). */
const raw = (o: Record<string, unknown> = {}) => ({
  id: 1,
  timestamp: '2026-11-13T10:00:00.123456789Z',
  event_type: 'token.created',
  actor: 'admin',
  method: 'POST',
  path: '/api/v1/auth/tokens',
  status_code: 201,
  ip_address: '10.0.0.5',
  user_agent: 'curl/8.5.0',
  duration_ms: 3,
  ...o,
});

const ev = (nodeId: string, id: number, timestamp: string): AuditEvent =>
  parseAuditEntry(raw({ id, timestamp }), nodeId) as AuditEvent;

describe('parseAuditEntry', () => {
  it('reads the fields Arc sends, tagged with the node', () => {
    expect(parseAuditEntry(raw({ database: 'prod', measurement: 'cpu' }), 'w1')).toEqual({
      nodeId: 'w1',
      id: 1,
      timestamp: '2026-11-13T10:00:00.123456789Z',
      eventType: 'token.created',
      actor: 'admin',
      method: 'POST',
      path: '/api/v1/auth/tokens',
      database: 'prod',
      measurement: 'cpu',
      statusCode: 201,
      ipAddress: '10.0.0.5',
      userAgent: 'curl/8.5.0',
      durationMs: 3,
      detail: null,
    });
  });

  it('drops rows it cannot order or describe', () => {
    expect(parseAuditEntry(raw({ id: -1 }), 'a')).toBeNull();
    expect(parseAuditEntry(raw({ timestamp: 'yesterday' }), 'a')).toBeNull();
    expect(parseAuditEntry(raw({ event_type: '' }), 'a')).toBeNull();
    expect(parseAuditEntry(raw({ method: 'post' }), 'a')).toBeNull();
    expect(parseAuditEntry(raw({ path: '' }), 'a')).toBeNull();
    expect(parseAuditEntry([], 'a')).toBeNull();
  });

  it('keeps RBAC event types, which carry a raw path segment', () => {
    // classifyEvent: "rbac." + the first segment after /api/v1/rbac/ + action.
    expect(parseAuditEntry(raw({ event_type: 'rbac.Foo%20Bar.read', method: 'GET' }), 'a')?.eventType).toBe('rbac.Foo%20Bar.read');
  });

  it('reads Arc\'s empty columns as absent', () => {
    // A NULL status or actor scans to 0 and "" in Arc.
    const e = parseAuditEntry(raw({ status_code: 0, actor: '', ip_address: '', database: undefined }), 'a');
    expect(e).toMatchObject({ statusCode: null, actor: 'anonymous', ipAddress: null, database: null });
  });

  it('bounds strings and strips control characters', () => {
    const e = parseAuditEntry(raw({ user_agent: `evil\u001b[31m${'x'.repeat(400)}` }), 'a');
    expect(e?.userAgent).not.toContain('\u001b');
    expect(e?.userAgent?.length).toBe(257);
  });

  it('reads the detail map Arc stores as JSON, and keeps anything else as one value', () => {
    expect(parseAuditEntry(raw({ detail: '{"path":"db/cpu/f.parquet","reason":"operator"}' }), 'a')?.detail)
      .toEqual([['path', 'db/cpu/f.parquet'], ['reason', 'operator']]);
    expect(parseAuditEntry(raw({ detail: 'not json' }), 'a')?.detail).toEqual([['detail', 'not json']]);
    expect(parseAuditEntry(raw({ detail: '{}' }), 'a')?.detail).toBeNull();
  });
});

describe('parseAuditEntries and parseAuditStats', () => {
  it('reads a page, Arc\'s null for no match, and refuses other shapes', () => {
    const p = parseAuditEntries({ success: true, data: [{ bogus: true }, raw({ id: 7 })], count: 2 }, 'a', 100);
    // The unusable row is skipped but still counted; without a time of its own, the first usable row bounds the page.
    expect(p).toMatchObject({ positions: [1], received: 2, newest: '2026-11-13T10:00:00.123456789Z' });
    expect(p?.entries.map((e) => e.id)).toEqual([7]);
    expect(parseAuditEntries({ data: [raw({ id: 2, timestamp: '2026-11-13T10:00:05Z', event_type: '' }), raw({ id: 1 })] }, 'a', 100)?.newest)
      .toBe('2026-11-13T10:00:05Z');
    expect(parseAuditEntries({ success: true, data: null, count: 0 }, 'a', 100)).toEqual({ entries: [], positions: [], received: 0, newest: null });
    expect(parseAuditEntries({ success: true }, 'a', 100)).toBeNull();
    expect(parseAuditEntries({ data: [raw({ id: 1 }), raw({ id: 2 }), raw({ id: 3 })] }, 'a', 2)?.received).toBe(2);
  });

  it('reads counts per type', () => {
    expect(parseAuditStats({ success: true, data: { 'auth.failed': 4, 'data.write': 10, 'rbac.Foo.read': 1, 'token.created': -1, '': 3 }, since: 'x' }))
      .toEqual(Object.assign(Object.create(null), { 'auth.failed': 4, 'data.write': 10, 'rbac.Foo.read': 1 }));
    expect(Object.keys(parseAuditStats(JSON.parse('{"data":{"__proto__":2}}')) ?? {})).toEqual(['__proto__']);
    expect(parseAuditStats({ success: true, data: null })).toEqual({});
    expect(parseAuditStats({ success: true, data: [] })).toBeNull();
  });

  it('sums counts over nodes, most frequent first', () => {
    expect(mergeStats([{ 'auth.failed': 2, 'data.write': 5 }, { 'auth.failed': 4 }, {}])).toEqual([
      { eventType: 'auth.failed', count: 6 },
      { eventType: 'data.write', count: 5 },
    ]);
  });
});

describe('ordering', () => {
  it('orders newest first, below the millisecond too', () => {
    const a = ev('a', 1, '2026-11-13T10:00:00.000000100Z');
    const b = ev('a', 2, '2026-11-13T10:00:00.000000200Z');
    const c = ev('a', 3, '2026-11-13T10:00:01Z');
    expect([a, b, c].sort(compareEvents).map((e) => e.id)).toEqual([3, 2, 1]);
  });

  it('compares times with an offset by the instant', () => {
    const utc = ev('a', 1, '2026-11-13T10:00:00Z');
    const plus = ev('a', 2, '2026-11-13T11:30:00+02:00'); // 09:30Z
    expect([plus, utc].sort(compareEvents).map((e) => e.id)).toEqual([1, 2]);
  });

  it('breaks ties by node, then id, so the order is total', () => {
    const t = '2026-11-13T10:00:00Z';
    expect([ev('b', 1, t), ev('a', 1, t), ev('a', 2, t)].sort(compareEvents).map((e) => `${e.nodeId}${e.id}`)).toEqual(['a2', 'a1', 'b1']);
  });
});

describe('mergeNodePages', () => {
  const t = (s: number) => `2026-11-13T10:00:${String(s).padStart(2, '0')}Z`;
  const page = (nodeId: string, seconds: number[], requested: number, from: NodePage['from'] = null): NodePage => ({
    nodeId,
    entries: seconds.map((s, i) => ev(nodeId, 100 - i, t(s))),
    positions: seconds.map((_, i) => i),
    received: seconds.length,
    newest: seconds.length ? t(seconds[0]) : null,
    requested,
    from,
  });

  it('interleaves nodes by time and says where each continues', () => {
    const m = mergeNodePages([page('a', [50, 30, 10], 3), page('b', [40, 20, 5], 3)], 3);
    expect(m.events.map((e) => `${e.nodeId}@${e.timestamp.slice(17, 19)}`)).toEqual(['a@50', 'b@40', 'a@30']);
    // Each node is frozen at its own newest event, so new events do not shift offsets.
    expect(m.next).toEqual({ a: { until: t(50), offset: 2 }, b: { until: t(40), offset: 1 } });
  });

  it('continues from a cursor, keeping its boundary', () => {
    const m = mergeNodePages([page('a', [10], 3, { until: t(50), offset: 2 })], 3);
    expect(m.events).toHaveLength(1);
    // Fewer than asked for and all used: a is done.
    expect(m.next).toEqual({});
  });

  it('keeps a node that filled its page even when all of it was used', () => {
    const m = mergeNodePages([page('a', [50, 40], 2)], 5);
    expect(m.events).toHaveLength(2);
    expect(m.next).toEqual({ a: { until: t(50), offset: 2 } });
  });

  it('counts rows it could not use where Arc counts them', () => {
    // Arc returned 4 rows; the 2nd and 4th were unusable.
    const p: NodePage = {
      nodeId: 'a', entries: [ev('a', 9, t(50)), ev('a', 7, t(30))], positions: [0, 2], received: 4, newest: t(50), requested: 4, from: null,
    };
    // One shown: continue from the next usable row, Arc's 3rd.
    expect(mergeNodePages([p], 1).next.a).toEqual({ until: t(50), offset: 2 });
    // Both shown: all four rows were used, and the page was full.
    expect(mergeNodePages([p], 5).next.a).toEqual({ until: t(50), offset: 4 });
    // A short page whose usable rows were all shown is done, unusable rows or not.
    expect(mergeNodePages([{ ...p, requested: 5 }], 5).next).toEqual({});
  });

  it('keeps a node whose id spells an Object.prototype key', () => {
    const m = mergeNodePages([page('__proto__', [50, 40], 2)], 1);
    expect(Object.keys(m.next)).toEqual(['__proto__']);
    expect(m.next['__proto__']).toEqual({ until: t(50), offset: 1 });
  });

  it('drops nodes with nothing to read', () => {
    expect(mergeNodePages([page('a', [], 3), page('b', [9], 3)], 3).next).toEqual({});
  });

  it('takes each node\'s entries in the order Arc returned them', () => {
    // Same instant: the merge must not reorder a node's rows, or the offset
    // it continues from would not match the rows shown.
    const same = '2026-11-13T10:00:00Z';
    const p: NodePage = { nodeId: 'a', entries: [ev('a', 1, same), ev('a', 2, same)], positions: [0, 1], received: 2, newest: same, requested: 2, from: null };
    const m = mergeNodePages([p], 1);
    expect(m.events.map((e) => e.id)).toEqual([1]);
    expect(m.next.a.offset).toBe(1);
  });
});

describe('presentation helpers', () => {
  it('tells refusals, failures, changes and reads apart', () => {
    expect(eventTone({ eventType: 'auth.failed', method: 'POST', statusCode: 401 })).toBe('failure');
    expect(eventTone({ eventType: 'database.created', method: 'POST', statusCode: 500 })).toBe('error');
    expect(eventTone({ eventType: 'token.deleted', method: 'DELETE', statusCode: 200 })).toBe('change');
    expect(eventTone({ eventType: 'data.query', method: 'POST', statusCode: 200 })).toBe('read');
    expect(eventTone({ eventType: 'api.get', method: 'GET', statusCode: 200 })).toBe('read');
  });

  it('turns a preset into bounds ending now', () => {
    const now = Date.parse('2026-11-13T12:00:00Z');
    expect(rangeBounds('1h', now)).toEqual({ since: '2026-11-13T11:00:00.000Z', until: null });
    expect(rangeBounds('all', now)).toEqual({ since: null, until: null });
  });

  it('reads custom times in the console\'s timezone', () => {
    expect(inputToIso('2026-11-13T09:30', 'utc')).toBe('2026-11-13T09:30:00.000Z');
    expect(inputToIso('2026-11-13T09:30', 'local')).toBe(new Date(2026, 10, 13, 9, 30).toISOString());
    expect(inputToIso('', 'utc')).toBeNull();
    expect(inputToIso('2026-13-45T99:99', 'utc')).toBeNull();
  });
});
