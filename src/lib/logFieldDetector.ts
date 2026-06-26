/**
 * Log Field Detection Utility
 * Auto-detects common log field patterns in query results
 */

export interface LogFieldMapping {
  timestamp: string | null;
  level: string | null;
  message: string | null;
  source: string | null;
  // Trace fields for distributed tracing
  traceId: string | null;
  spanId: string | null;
  parentSpanId: string | null;
}

// Common field name patterns for each log field type
const TIMESTAMP_PATTERNS = ['time', 'timestamp', '@timestamp', 'ts', 'datetime', 'created_at', 'logged_at'];
const LEVEL_PATTERNS = ['level', 'severity', 'log_level', 'loglevel', 'severity_text', 'priority'];
const MESSAGE_PATTERNS = ['message', 'msg', 'body', 'text', 'content', 'log', 'description'];
const SOURCE_PATTERNS = ['source', 'host', 'hostname', 'service', 'component', 'logger', 'origin', 'app', 'application'];

// Trace field patterns for distributed tracing
const TRACE_ID_PATTERNS = ['trace_id', 'traceid', 'trace-id', 'traceId', 'x-trace-id', 'request_id', 'correlation_id'];
const SPAN_ID_PATTERNS = ['span_id', 'spanid', 'span-id', 'spanId'];
const PARENT_SPAN_PATTERNS = ['parent_span_id', 'parentspanid', 'parent-span-id', 'parentSpanId', 'parent_id'];

/**
 * Detects log field mappings from column names
 */
export function detectLogFields(columns: string[]): LogFieldMapping {
  const lowerColumns = columns.map(c => c.toLowerCase());

  return {
    timestamp: findMatchingColumn(columns, lowerColumns, TIMESTAMP_PATTERNS),
    level: findMatchingColumn(columns, lowerColumns, LEVEL_PATTERNS),
    message: findMatchingColumn(columns, lowerColumns, MESSAGE_PATTERNS),
    source: findMatchingColumn(columns, lowerColumns, SOURCE_PATTERNS),
    traceId: findMatchingColumn(columns, lowerColumns, TRACE_ID_PATTERNS),
    spanId: findMatchingColumn(columns, lowerColumns, SPAN_ID_PATTERNS),
    parentSpanId: findMatchingColumn(columns, lowerColumns, PARENT_SPAN_PATTERNS),
  };
}

/**
 * Detects log field mappings using both column names and sample data values
 * This is more robust for tables with non-standard column names
 */
export function detectLogFieldsWithData(columns: string[], sampleRow: unknown[]): LogFieldMapping {
  // First try name-based detection
  const nameBasedMapping = detectLogFields(columns);

  // Validate name-detected timestamp against sample data
  // This prevents false positives where column names match patterns but data type doesn't
  if (nameBasedMapping.timestamp && sampleRow) {
    const timestampIndex = columns.indexOf(nameBasedMapping.timestamp);
    if (timestampIndex !== -1) {
      const value = sampleRow[timestampIndex];
      if (!isTimestampValue(value)) {
        // Name matched but value is not a timestamp, clear it
        nameBasedMapping.timestamp = null;
      }
    }
  }

  // If timestamp wasn't found by name (or was invalidated), try to detect by value
  if (!nameBasedMapping.timestamp && sampleRow) {
    for (let i = 0; i < columns.length; i++) {
      const value = sampleRow[i];
      if (isTimestampValue(value)) {
        nameBasedMapping.timestamp = columns[i];
        break;
      }
    }
  }

  // Validate name-detected level against sample data
  if (nameBasedMapping.level && sampleRow) {
    const levelIndex = columns.indexOf(nameBasedMapping.level);
    if (levelIndex !== -1) {
      const value = sampleRow[levelIndex];
      if (!isLogLevelValue(value)) {
        // Name matched but value is not a log level, clear it
        nameBasedMapping.level = null;
      }
    }
  }

  // If level wasn't found by name (or was invalidated), try to detect by value
  if (!nameBasedMapping.level && sampleRow) {
    for (let i = 0; i < columns.length; i++) {
      const value = sampleRow[i];
      if (isLogLevelValue(value)) {
        nameBasedMapping.level = columns[i];
        break;
      }
    }
  }

  // Validate trace fields against sample data
  // For trace_id, we validate that it looks like a trace ID format
  if (nameBasedMapping.traceId && sampleRow) {
    const traceIdIndex = columns.indexOf(nameBasedMapping.traceId);
    if (traceIdIndex !== -1) {
      const value = sampleRow[traceIdIndex];
      if (!isTraceIdValue(value)) {
        nameBasedMapping.traceId = null;
      }
    }
  }

  // If trace_id wasn't found by name, try to detect by value
  // Only check columns with trace-like names to avoid false positives
  if (!nameBasedMapping.traceId && sampleRow) {
    for (let i = 0; i < columns.length; i++) {
      const colName = columns[i].toLowerCase();
      // Only consider columns with "trace" or "request" in the name
      if ((colName.includes('trace') || colName.includes('request') || colName.includes('correlation')) && isTraceIdValue(sampleRow[i])) {
        nameBasedMapping.traceId = columns[i];
        break;
      }
    }
  }

  return nameBasedMapping;
}

/**
 * Checks if a value looks like a timestamp
 */
function isTimestampValue(value: unknown): boolean {
  if (!value) return false;
  const str = String(value);

  // ISO 8601 format
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(str)) return true;

  // Unix timestamp (10 or 13 digits)
  if (/^\d{10,13}$/.test(str)) return true;

  // Common date formats
  if (/^\d{4}\/\d{2}\/\d{2}/.test(str)) return true;

  // Try parsing as date
  const date = new Date(str);
  if (!isNaN(date.getTime()) && date.getFullYear() > 2000 && date.getFullYear() < 2100) {
    return true;
  }

  return false;
}

/**
 * Checks if a value looks like a log level
 */
function isLogLevelValue(value: unknown): boolean {
  if (!value) return false;
  const str = String(value).toUpperCase();
  const knownLevels = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'WARNING', 'ERROR', 'FATAL', 'CRITICAL', 'EMERG', 'ALERT', 'NOTICE'];
  return knownLevels.includes(str);
}

/**
 * Checks if a value looks like a trace/span ID
 * Supports: 32-char hex (128-bit), 16-char hex (64-bit), UUID format
 */
function isTraceIdValue(value: unknown): boolean {
  if (!value) return false;
  const str = String(value).trim();

  // UUID format: 8-4-4-4-12 hex chars
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str)) {
    return true;
  }

  // 32-char hex (128-bit trace ID, common in OpenTelemetry)
  if (/^[0-9a-f]{32}$/i.test(str)) {
    return true;
  }

  // 16-char hex (64-bit span ID or older trace formats)
  if (/^[0-9a-f]{16}$/i.test(str)) {
    return true;
  }

  return false;
}

function findMatchingColumn(
  originalColumns: string[],
  lowerColumns: string[],
  patterns: string[]
): string | null {
  for (const pattern of patterns) {
    const index = lowerColumns.indexOf(pattern);
    if (index !== -1) {
      return originalColumns[index];
    }
  }
  // Try partial matching for nested fields (e.g., resource.host)
  for (const pattern of patterns) {
    const index = lowerColumns.findIndex(col => col.endsWith(`.${pattern}`) || col.endsWith(`_${pattern}`));
    if (index !== -1) {
      return originalColumns[index];
    }
  }
  return null;
}

/**
 * Gets the CSS class for log level coloring
 */
export function getLevelColorClass(level: string | null | undefined): string {
  if (!level) return 'text-muted-foreground';

  const upperLevel = level.toUpperCase();
  switch (upperLevel) {
    case 'ERROR':
    case 'FATAL':
    case 'CRITICAL':
    case 'EMERG':
    case 'ALERT':
      return 'text-red-500';
    case 'WARN':
    case 'WARNING':
      return 'text-yellow-500';
    case 'INFO':
    case 'NOTICE':
      return 'text-blue-400';
    case 'DEBUG':
    case 'TRACE':
      return 'text-neutral-500';
    default:
      return 'text-muted-foreground';
  }
}

/**
 * Gets the CSS background class for log level row highlighting
 */
export function getLevelBgClass(level: string | null | undefined): string {
  if (!level) return '';

  const upperLevel = level.toUpperCase();
  switch (upperLevel) {
    case 'ERROR':
    case 'FATAL':
    case 'CRITICAL':
    case 'EMERG':
    case 'ALERT':
      return 'bg-red-500/10';
    case 'WARN':
    case 'WARNING':
      return 'bg-yellow-500/10';
    case 'INFO':
    case 'NOTICE':
      return 'bg-blue-500/5';
    case 'DEBUG':
    case 'TRACE':
      return 'bg-neutral-500/5';
    default:
      return '';
  }
}

/**
 * Formats a timestamp for display
 */
export function formatLogTimestamp(timestamp: string | null | undefined, useUtc = false): string {
  if (!timestamp) return '-';

  try {
    const date = new Date(timestamp);
    if (isNaN(date.getTime())) return timestamp;

    return date.toLocaleString(undefined, {
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZone: useUtc ? 'UTC' : undefined,
    });
  } catch {
    return timestamp;
  }
}

/**
 * Formats a timestamp for compact display (time only)
 */
export function formatLogTimestampCompact(timestamp: string | null | undefined, useUtc = false): string {
  if (!timestamp) return '-';

  try {
    const date = new Date(timestamp);
    if (isNaN(date.getTime())) return timestamp;

    return date.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZone: useUtc ? 'UTC' : undefined,
    });
  } catch {
    return timestamp;
  }
}

/**
 * Known log levels for filtering
 */
export const LOG_LEVELS = [
  { value: 'ERROR', label: 'Error', color: 'red' },
  { value: 'WARN', label: 'Warning', color: 'yellow' },
  { value: 'INFO', label: 'Info', color: 'blue' },
  { value: 'DEBUG', label: 'Debug', color: 'gray' },
  { value: 'TRACE', label: 'Trace', color: 'gray' },
] as const;

export type LogLevel = typeof LOG_LEVELS[number]['value'];
