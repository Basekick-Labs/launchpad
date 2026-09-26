import { describe, it, expect } from 'vitest';
import { detectLogFields, detectLogFieldsWithData, LOG_LEVELS } from './logFieldDetector';

describe('detectLogFields — name matching', () => {
  it('maps the obvious column names', () => {
    const m = detectLogFields(['time', 'level', 'message', 'host']);
    expect(m).toMatchObject({
      timestamp: 'time',
      level: 'level',
      message: 'message',
      source: 'host',
    });
  });

  it('matches case-insensitively but returns the original spelling', () => {
    const m = detectLogFields(['TimeStamp', 'SEVERITY', 'Msg']);
    expect(m.timestamp).toBe('TimeStamp');
    expect(m.level).toBe('SEVERITY');
    expect(m.message).toBe('Msg');
  });

  it('returns null for fields with no candidate column', () => {
    const m = detectLogFields(['a', 'b', 'c']);
    expect(m).toEqual({
      timestamp: null,
      level: null,
      message: null,
      source: null,
      traceId: null,
      spanId: null,
      parentSpanId: null,
    });
  });

  it('handles an empty column list', () => {
    expect(detectLogFields([]).timestamp).toBeNull();
  });

  it('prefers the earlier pattern over the earlier column', () => {
    // TIMESTAMP_PATTERNS lists 'time' before 'ts', so 'time' wins even though
    // 'ts' appears first in the column list. Pattern order is the priority.
    expect(detectLogFields(['ts', 'time']).timestamp).toBe('time');
  });

  it('falls back to a suffix match for nested or prefixed columns', () => {
    expect(detectLogFields(['resource.host']).source).toBe('resource.host');
    expect(detectLogFields(['app_message']).message).toBe('app_message');
  });

  it('prefers an exact match over a suffix match', () => {
    expect(detectLogFields(['resource.host', 'host']).source).toBe('host');
  });

  it('detects distributed tracing columns', () => {
    const m = detectLogFields(['trace_id', 'span_id', 'parent_span_id']);
    expect(m.traceId).toBe('trace_id');
    expect(m.spanId).toBe('span_id');
    expect(m.parentSpanId).toBe('parent_span_id');
  });
});

describe('detectLogFieldsWithData — validating names against values', () => {
  const cols = ['time', 'level', 'message'];

  it('keeps a name match when the sample value agrees', () => {
    const m = detectLogFieldsWithData(cols, ['2026-01-01T00:00:00Z', 'ERROR', 'boom']);
    expect(m.timestamp).toBe('time');
    expect(m.level).toBe('level');
    expect(m.message).toBe('message');
  });

  it('clears a timestamp whose value is clearly not a timestamp', () => {
    const m = detectLogFieldsWithData(['time', 'msg'], ['not-a-date', 'boom']);
    expect(m.timestamp).toBeNull();
  });

  it('keeps a named timestamp when a later sample row contains a valid value', () => {
    const m = detectLogFieldsWithData(
      ['time', 'msg'],
      [
        [null, 'starting'],
        ['2026-01-01T00:00:00Z', 'ready'],
      ],
    );
    expect(m.timestamp).toBe('time');
  });

  it('clears a level whose value is not a known level', () => {
    const m = detectLogFieldsWithData(['level', 'msg'], ['banana', 'boom']);
    expect(m.level).toBeNull();
  });

  it('finds a timestamp by value when no column name matched', () => {
    const m = detectLogFieldsWithData(['a', 'b'], ['x', '2026-01-01T00:00:00Z']);
    expect(m.timestamp).toBe('b');
  });

  it('finds a timestamp across multiple sample rows without choosing small integers', () => {
    const m = detectLogFieldsWithData(
      ['retries', 'event_time'],
      [
        [1, null],
        [2, '2026-01-01T00:00:00Z'],
      ],
    );
    expect(m.timestamp).toBe('event_time');
  });

  it('finds a level by value when no column name matched', () => {
    const m = detectLogFieldsWithData(['a', 'b'], ['x', 'WARN']);
    expect(m.level).toBe('b');
  });

  it.each([
    ['2026-01-01T00:00:00Z', 'ISO 8601 with T'],
    ['2026-01-01 00:00:00', 'SQL datetime with a space'],
    ['1767225600', 'unix seconds, 10 digits'],
    ['1767225600000', 'unix millis, 13 digits'],
    ['2026/01/01', 'slash-separated date'],
  ])('accepts %j as a timestamp value (%s)', (value) => {
    expect(detectLogFieldsWithData(['a'], [value]).timestamp).toBe('a');
  });

  it.each([['banana'], [''], [null], [undefined], ['99'], ['0']])(
    'rejects %j as a timestamp value',
    (value) => {
      expect(detectLogFieldsWithData(['a'], [value]).timestamp).toBeNull();
    },
  );

  it.each([[12], ['5'], ['2026'], [' 12 '], [-1], ['5.5']])(
    'rejects bare numeric-looking value %j as a timestamp (#54)',
    (value) => {
      expect(detectLogFieldsWithData(['a'], [value]).timestamp).toBeNull();
    },
  );

  it.each([['ERROR'], ['warn'], ['Info'], ['DEBUG'], ['TRACE'], ['FATAL'], ['CRITICAL']])(
    'accepts %j as a level value',
    (value) => {
      expect(detectLogFieldsWithData(['lvl'], [value]).level).toBe('lvl');
    },
  );

  it.each([['banana'], [''], [null]])('rejects %j as a level value', (value) => {
    expect(detectLogFieldsWithData(['lvl'], [value]).level).toBeNull();
  });

  it('only considers trace-ish column names when detecting a trace id by value', () => {
    const hex = 'a'.repeat(32);
    // A trace-looking value in a column with an unrelated name is not adopted.
    expect(detectLogFieldsWithData(['payload'], [hex]).traceId).toBeNull();
    expect(detectLogFieldsWithData(['my_trace'], [hex]).traceId).toBe('my_trace');
  });
});

describe('LOG_LEVELS', () => {
  it('is ordered most to least severe', () => {
    expect(LOG_LEVELS.map((l) => l.value)).toEqual(['ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE']);
  });

  it('gives every level a label and a color', () => {
    for (const level of LOG_LEVELS) {
      expect(level.label).toBeTruthy();
      expect(level.color).toBeTruthy();
    }
  });
});
