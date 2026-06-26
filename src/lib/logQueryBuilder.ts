/**
 * Log Query Builder
 * Generates SQL queries for log exploration
 */

import type { LogFieldMapping } from './logFieldDetector';

export interface LogQueryOptions {
  measurement: string;
  fieldMapping: LogFieldMapping;
  timeRange: TimeRange;
  levels: string[];
  searchText: string;
  limit: number;
}

export interface TimeRange {
  type: 'relative' | 'absolute';
  // For relative: minutes ago
  relativeMinutes?: number;
  // For absolute: start and end timestamps
  start?: string;
  end?: string;
}

export const TIME_RANGE_PRESETS = [
  { value: 5, label: 'Last 5 minutes' },
  { value: 15, label: 'Last 15 minutes' },
  { value: 30, label: 'Last 30 minutes' },
  { value: 60, label: 'Last 1 hour' },
  { value: 180, label: 'Last 3 hours' },
  { value: 360, label: 'Last 6 hours' },
  { value: 720, label: 'Last 12 hours' },
  { value: 1440, label: 'Last 24 hours' },
  { value: 4320, label: 'Last 3 days' },
  { value: 10080, label: 'Last 7 days' },
  { value: 20160, label: 'Last 14 days' },
  { value: 43200, label: 'Last 30 days' },
  { value: 129600, label: 'Last 90 days' },
  { value: -1, label: 'Custom range...' },
] as const;

/**
 * Builds a SQL query for log exploration
 */
export function buildLogQuery(options: LogQueryOptions): string {
  const { measurement, fieldMapping, timeRange, levels, searchText, limit } = options;

  const conditions: string[] = [];

  // Time range condition
  if (fieldMapping.timestamp) {
    const timeCondition = buildTimeCondition(fieldMapping.timestamp, timeRange);
    if (timeCondition) {
      conditions.push(timeCondition);
    }
  }

  // Level filter
  if (levels.length > 0 && fieldMapping.level) {
    const levelValues = levels.map(l => `'${escapeString(l)}'`).join(', ');
    conditions.push(`UPPER(${quoteIdentifier(fieldMapping.level)}) IN (${levelValues.toUpperCase()})`);
  }

  // Text search
  if (searchText.trim() && fieldMapping.message) {
    const escapedSearch = escapeString(searchText.trim());
    // Use ILIKE for case-insensitive search (PostgreSQL-compatible)
    conditions.push(`${quoteIdentifier(fieldMapping.message)} ILIKE '%${escapedSearch}%'`);
  }

  // Build query
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join('\n  AND ')}` : '';
  const orderBy = fieldMapping.timestamp ? `ORDER BY ${quoteIdentifier(fieldMapping.timestamp)} DESC` : '';

  return `SELECT *
FROM ${quoteIdentifier(measurement)}
${whereClause}
${orderBy}
LIMIT ${limit}`.trim();
}

function buildTimeCondition(timestampField: string, timeRange: TimeRange): string | null {
  const field = quoteIdentifier(timestampField);

  if (timeRange.type === 'relative' && timeRange.relativeMinutes) {
    // Use interval for relative time (PostgreSQL-compatible)
    return `${field} >= NOW() - INTERVAL '${timeRange.relativeMinutes} minutes'`;
  }

  if (timeRange.type === 'absolute') {
    const conditions: string[] = [];
    if (timeRange.start) {
      conditions.push(`${field} >= '${escapeString(timeRange.start)}'`);
    }
    if (timeRange.end) {
      conditions.push(`${field} <= '${escapeString(timeRange.end)}'`);
    }
    return conditions.length > 0 ? conditions.join(' AND ') : null;
  }

  return null;
}

/**
 * Escapes a string for SQL
 */
function escapeString(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Quotes an identifier (table/column name)
 */
function quoteIdentifier(name: string): string {
  // If already quoted or is a simple identifier, return as-is
  if (name.startsWith('"') || /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    return name;
  }
  // Quote identifiers with special characters
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Parses the time range from a preset value (minutes)
 */
export function createRelativeTimeRange(minutes: number): TimeRange {
  return {
    type: 'relative',
    relativeMinutes: minutes,
  };
}

/**
 * Creates an absolute time range
 */
export function createAbsoluteTimeRange(start: string, end: string): TimeRange {
  return {
    type: 'absolute',
    start,
    end,
  };
}
