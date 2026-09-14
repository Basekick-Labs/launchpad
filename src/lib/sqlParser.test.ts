import { describe, it, expect } from 'vitest';
import { parseStatements, getStatementPreview, getStatementType } from './sqlParser';

const sqlOf = (input: string) => parseStatements(input).map((s) => s.sql);

describe('parseStatements — splitting', () => {
  it('splits on semicolons', () => {
    expect(sqlOf('SELECT 1; SELECT 2')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('keeps a trailing statement that has no semicolon', () => {
    expect(sqlOf('SELECT 1')).toEqual(['SELECT 1']);
  });

  it('drops empty statements from consecutive semicolons', () => {
    expect(sqlOf('SELECT 1;;;SELECT 2;')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('returns nothing for empty or whitespace-only input', () => {
    expect(parseStatements('')).toEqual([]);
    expect(parseStatements('   \n\t  ')).toEqual([]);
    expect(parseStatements(';;;')).toEqual([]);
  });

  it('trims surrounding whitespace from each statement', () => {
    expect(sqlOf('  SELECT 1  ;\n\n  SELECT 2  ')).toEqual(['SELECT 1', 'SELECT 2']);
  });
});

describe('parseStatements — semicolons that must not split', () => {
  it('ignores a semicolon inside a single-quoted string', () => {
    expect(sqlOf("SELECT 'hello; world'")).toEqual(["SELECT 'hello; world'"]);
  });

  it('ignores a semicolon inside a double-quoted identifier', () => {
    expect(sqlOf('SELECT "column;name" FROM t')).toEqual(['SELECT "column;name" FROM t']);
  });

  it('ignores a semicolon inside a line comment', () => {
    expect(sqlOf('SELECT 1 -- trailing; comment\n')).toEqual(['SELECT 1 -- trailing; comment']);
  });

  it('ignores a semicolon inside a block comment', () => {
    expect(sqlOf('SELECT /* a; b */ 1')).toEqual(['SELECT /* a; b */ 1']);
  });

  it('resumes splitting after a line comment ends', () => {
    expect(sqlOf('SELECT 1 -- note; here\n; SELECT 2')).toEqual([
      'SELECT 1 -- note; here',
      'SELECT 2',
    ]);
  });

  it('resumes splitting after a block comment closes', () => {
    expect(sqlOf('SELECT /* x; y */ 1; SELECT 2')).toEqual(['SELECT /* x; y */ 1', 'SELECT 2']);
  });
});

describe('parseStatements — escaped quotes', () => {
  it("treats '' as an escaped quote, not a string terminator", () => {
    expect(sqlOf("SELECT 'it''s; fine'")).toEqual(["SELECT 'it''s; fine'"]);
  });

  it('treats "" as an escaped quote in an identifier', () => {
    expect(sqlOf('SELECT "a""b; c" FROM t')).toEqual(['SELECT "a""b; c" FROM t']);
  });

  it('still splits correctly after an escaped quote closes', () => {
    expect(sqlOf("SELECT 'it''s'; SELECT 2")).toEqual(["SELECT 'it''s'", 'SELECT 2']);
  });
});

describe('parseStatements — offsets', () => {
  it('reports offsets that slice back to the original text', () => {
    const input = 'SELECT 1; SELECT 2';
    const parsed = parseStatements(input);
    expect(parsed).toHaveLength(2);
    for (const s of parsed) {
      expect(input.slice(s.startOffset, s.endOffset).trim()).toBe(s.sql);
    }
  });
});

describe('getStatementPreview', () => {
  it('returns a short statement unchanged', () => {
    expect(getStatementPreview('SELECT 1')).toBe('SELECT 1');
  });

  it('uses only the first line', () => {
    expect(getStatementPreview('SELECT 1\nFROM t')).toBe('SELECT 1');
  });

  it('truncates with an ellipsis at the limit', () => {
    const out = getStatementPreview('SELECT a, b, c, d, e, f, g FROM some_table', 20);
    expect(out).toHaveLength(20);
    expect(out.endsWith('...')).toBe(true);
  });

  it('does not truncate a statement exactly at the limit', () => {
    expect(getStatementPreview('12345', 5)).toBe('12345');
  });
});

describe('getStatementType', () => {
  it.each([
    ['SELECT * FROM t', 'SELECT'],
    ['  select 1  ', 'SELECT'],
    ['INSERT INTO t VALUES (1)', 'INSERT'],
    ['UPDATE t SET a = 1', 'UPDATE'],
    ['DELETE FROM t', 'DELETE'],
    ['CREATE TABLE t (a INT)', 'CREATE'],
    ['DROP TABLE t', 'DROP'],
    ['ALTER TABLE t ADD b INT', 'ALTER'],
    ['SHOW TABLES', 'SHOW'],
    ['DESCRIBE t', 'DESCRIBE'],
    ['DESC t', 'DESCRIBE'],
    ['EXPLAIN SELECT 1', 'EXPLAIN'],
    ['WITH cte AS (SELECT 1) SELECT * FROM cte', 'WITH'],
  ])('classifies %j as %s', (sql, expected) => {
    expect(getStatementType(sql)).toBe(expected);
  });

  it('falls back to SQL for anything unrecognised', () => {
    expect(getStatementType('PRAGMA table_info(t)')).toBe('SQL');
    expect(getStatementType('')).toBe('SQL');
  });
});
