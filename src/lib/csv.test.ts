import { describe, it, expect } from 'vitest';
import { csvCell, csvValue, rowsFromObjects, toCsv, toCsvChunks } from './csv';

const plain = { escapeFormulas: false } as const;

describe('csvValue', () => {
  it.each([
    [null, ''],
    [undefined, ''],
    ['', ''],
    [0, '0'],
    [false, 'false'],
    [{ a: 1 }, '{"a":1}'],
    [[1, 2], '[1,2]'],
  ])('stringifies %p as %p', (input, expected) => {
    // The contract is stated because the two implementations this replaces
    // disagreed: one emitted the text "undefined" and "[object Object]".
    expect(csvValue(input)).toBe(expected);
  });

  it('survives a circular object', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => csvValue(cyclic)).not.toThrow();
  });
});

describe('quoting', () => {
  it.each([
    ['plain', 'plain'],
    ['has,comma', '"has,comma"'],
    ['has"quote', '"has""quote"'],
    ['has\nnewline', '"has\nnewline"'],
    ['has\rcarriage', '"has\rcarriage"'],
    ['has\r\nboth', '"has\r\nboth"'],
  ])('quotes %p correctly', (input, expected) => {
    // A lone CR matters: both implementations this replaces tested only for
    // \n, so a bare carriage return passed through and broke the row for any
    // RFC4180 reader.
    expect(csvCell(input, plain)).toBe(expected);
  });
});

describe('formula injection', () => {
  it.each([
    ['=HYPERLINK("http://x","c")'],
    ['@SUM(A1)'],
    ['+1234'],
    ['\tlead-tab'],
    [String.raw`-1+1)*cmd|" /c calc"!A1`],
    [String.raw`-2+3+cmd|"/c calc"!A0`],
  ])('neutralises %p', (payload) => {
    expect(csvCell(payload)).toContain("'");
    expect(csvCell(payload).replace(/^"?'/, '').startsWith(payload[0])).toBe(true);
  });

  it.each([['-5'], ['-0.3'], ['-273.15'], ['-1e6'], ['-0'], ['-0001']])(
    'leaves the ordinary negative number %p alone',
    (value) => {
      // The usual "prefix anything starting with = + - @ TAB CR" rule corrupts
      // EVERY negative reading — and this is an observability product, so
      // negative deltas, drift and temperature are routine. A prefixed value is
      // no longer a number to pandas, DuckDB or csvkit.
      expect(csvCell(value)).toBe(value);
    },
  );

  it('still neutralises a minus that is not a number', () => {
    expect(csvCell('-Infinity')).toBe("'-Infinity");
    expect(csvCell('--')).toBe("'--");
  });

  it('can be turned off for machine-to-machine output', () => {
    expect(csvCell('=A1', plain)).toBe('=A1');
  });

  it('does not prefix an empty cell', () => {
    expect(csvCell('')).toBe('');
    expect(csvCell(null)).toBe('');
  });

  it('quotes a prefixed value that also needs quoting', () => {
    expect(csvCell('=a,b')).toBe('"\'=a,b"');
  });
});

describe('toCsv', () => {
  it('escapes HEADERS, not just cells', () => {
    // ResultsPanel did `columns.join(',')`, so a column named `avg(cpu, 2)`
    // split the header row while every data row stayed intact — a misalignment
    // that is easy to miss and impossible to recover from.
    const out = toCsv(['avg(cpu, 2)', 'b'], [[1, 2]], plain);
    expect(out.split('\n')[0]).toBe('"avg(cpu, 2)",b');
  });

  it('writes a header-only document for no rows', () => {
    expect(toCsv(['a', 'b'], [], plain)).toBe('a,b');
  });

  it('separates records with a newline', () => {
    expect(toCsv(['a'], [[1], [2]], plain)).toBe('a\n1\n2');
  });

  it('emits a BOM only when asked', () => {
    // Excel on Windows mis-decodes UTF-8 without one; a naive
    // csv.reader(encoding='utf-8') reads it as part of the first header.
    expect(toCsv(['a'], [], { ...plain, bom: true }).startsWith('﻿')).toBe(true);
    expect(toCsv(['a'], [], plain).startsWith('﻿')).toBe(false);
  });

  it('accepts any iterable of rows', () => {
    function* gen() {
      yield [1];
      yield [2];
    }
    expect(toCsv(['a'], gen(), plain)).toBe('a\n1\n2');
  });
});

describe('toCsvChunks', () => {
  it('returns one chunk per row so a large export never becomes one string', () => {
    // maxFrameRows is 200,000; a wide result joined into a single JS string
    // approaches V8's ~512MB ceiling and is then copied again into the Blob.
    // Blob takes the array directly.
    const chunks = toCsvChunks(['a'], [[1], [2], [3]], plain);
    expect(chunks).toHaveLength(4); // header + 3 rows
    expect(chunks.join('')).toBe(toCsv(['a'], [[1], [2], [3]], plain));
  });

  it('puts the BOM in its own leading chunk', () => {
    expect(toCsvChunks(['a'], [], { bom: true })[0]).toBe('﻿');
  });
});

describe('rowsFromObjects', () => {
  it('selects and orders by the given columns', () => {
    const out = rowsFromObjects([{ b: 2, a: 1 }], ['a', 'b']);
    expect(out.columns).toEqual(['a', 'b']);
    expect(out.rows).toEqual([[1, 2]]);
  });

  it('falls back to the FIRST record keys, preserving existing behaviour', () => {
    // Log records are heterogeneous, and widening this to a union of all keys
    // would change every existing logs export.
    const out = rowsFromObjects([{ a: 1 }, { a: 2, b: 3 }], []);
    expect(out.columns).toEqual(['a']);
    expect(out.rows).toEqual([[1], [2]]);
  });

  it('leaves a missing field empty rather than dropping the column', () => {
    const out = rowsFromObjects([{ a: 1 }, { b: 2 }], ['a', 'b']);
    expect(toCsv(out.columns, out.rows, plain)).toBe('a,b\n1,\n,2');
  });

  it('handles an empty record list', () => {
    expect(rowsFromObjects([], [])).toEqual({ columns: [], rows: [] });
  });
});
