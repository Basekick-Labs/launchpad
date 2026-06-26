/**
 * SQL Statement Parser
 * Splits SQL text into individual statements, handling edge cases like
 * semicolons inside strings, quoted identifiers, and comments.
 */

export interface ParsedStatement {
  sql: string;
  startOffset: number;
  endOffset: number;
}

type ParserState = 'normal' | 'single_quote' | 'double_quote' | 'line_comment' | 'block_comment';

/**
 * Parse SQL text into individual statements.
 * Handles:
 * - Semicolons inside single-quoted strings: 'hello; world'
 * - Semicolons inside double-quoted identifiers: "column;name"
 * - Semicolons inside line comments: -- comment; here
 * - Semicolons inside block comments: /* comment; here *​/
 * - Empty statements (consecutive semicolons)
 * - Trailing whitespace and semicolons
 */
export function parseStatements(sql: string): ParsedStatement[] {
  const statements: ParsedStatement[] = [];
  let state: ParserState = 'normal';
  let currentStart = 0;
  let i = 0;

  while (i < sql.length) {
    const char = sql[i];
    const nextChar = sql[i + 1];

    switch (state) {
      case 'normal':
        if (char === "'") {
          state = 'single_quote';
        } else if (char === '"') {
          state = 'double_quote';
        } else if (char === '-' && nextChar === '-') {
          state = 'line_comment';
          i++; // Skip next char
        } else if (char === '/' && nextChar === '*') {
          state = 'block_comment';
          i++; // Skip next char
        } else if (char === ';') {
          // End of statement
          const statementText = sql.slice(currentStart, i).trim();
          if (statementText.length > 0) {
            statements.push({
              sql: statementText,
              startOffset: currentStart,
              endOffset: i,
            });
          }
          currentStart = i + 1;
        }
        break;

      case 'single_quote':
        if (char === "'") {
          // Check for escaped quote ''
          if (nextChar === "'") {
            i++; // Skip the escaped quote
          } else {
            state = 'normal';
          }
        }
        break;

      case 'double_quote':
        if (char === '"') {
          // Check for escaped quote ""
          if (nextChar === '"') {
            i++; // Skip the escaped quote
          } else {
            state = 'normal';
          }
        }
        break;

      case 'line_comment':
        if (char === '\n') {
          state = 'normal';
        }
        break;

      case 'block_comment':
        if (char === '*' && nextChar === '/') {
          state = 'normal';
          i++; // Skip the closing /
        }
        break;
    }

    i++;
  }

  // Handle any remaining text (statement without trailing semicolon)
  const remainingText = sql.slice(currentStart).trim();
  if (remainingText.length > 0) {
    statements.push({
      sql: remainingText,
      startOffset: currentStart,
      endOffset: sql.length,
    });
  }

  return statements;
}

/**
 * Get a short preview of a SQL statement for display in tabs.
 * Truncates to maxLength characters and adds ellipsis if needed.
 */
export function getStatementPreview(sql: string, maxLength: number = 30): string {
  // Get first line and trim
  const firstLine = sql.split('\n')[0].trim();

  if (firstLine.length <= maxLength) {
    return firstLine;
  }

  return firstLine.slice(0, maxLength - 3) + '...';
}

/**
 * Detect the type of SQL statement (SELECT, INSERT, UPDATE, DELETE, etc.)
 */
export function getStatementType(sql: string): string {
  const trimmed = sql.trim().toUpperCase();

  if (trimmed.startsWith('SELECT')) return 'SELECT';
  if (trimmed.startsWith('INSERT')) return 'INSERT';
  if (trimmed.startsWith('UPDATE')) return 'UPDATE';
  if (trimmed.startsWith('DELETE')) return 'DELETE';
  if (trimmed.startsWith('CREATE')) return 'CREATE';
  if (trimmed.startsWith('DROP')) return 'DROP';
  if (trimmed.startsWith('ALTER')) return 'ALTER';
  if (trimmed.startsWith('SHOW')) return 'SHOW';
  if (trimmed.startsWith('DESCRIBE') || trimmed.startsWith('DESC')) return 'DESCRIBE';
  if (trimmed.startsWith('EXPLAIN')) return 'EXPLAIN';
  if (trimmed.startsWith('WITH')) return 'WITH'; // CTE

  return 'SQL';
}
