/**
 * Trace Extraction Utility
 * Groups logs by trace ID and builds span hierarchies for visualization
 */

import type { LogFieldMapping } from './logFieldDetector';

export interface SpanData {
  spanId: string;
  parentSpanId: string | null;
  timestamp: Date;
  endTimestamp: Date | null;
  duration: number;              // In milliseconds
  operation: string | null;      // From message field
  level: string;
  logIndex: number;              // Reference to original log
  service: string | null;        // From source field
  children: SpanData[];          // Child spans
}

export interface TraceData {
  traceId: string;
  spans: SpanData[];
  rootSpans: SpanData[];         // Spans with no parent (or orphaned)
  totalDuration: number;         // End - start time in ms
  startTime: Date;
  endTime: Date;
  services: string[];            // Unique services involved
  hasErrors: boolean;            // Any ERROR level spans
  logCount: number;
}

/**
 * Creates a memoized trace extractor
 */
export function createTraceExtractor() {
  let cachedLogs: Record<string, unknown>[] | null = null;
  let cachedMapping: LogFieldMapping | null = null;
  let cachedResult: TraceData[] = [];

  return {
    extract(logs: Record<string, unknown>[], fieldMapping: LogFieldMapping): TraceData[] {
      // Return cached result if inputs haven't changed
      if (
        cachedLogs === logs &&
        cachedMapping === fieldMapping &&
        cachedResult.length > 0
      ) {
        return cachedResult;
      }

      cachedLogs = logs;
      cachedMapping = fieldMapping;
      cachedResult = extractTraces(logs, fieldMapping);
      return cachedResult;
    },

    clear() {
      cachedLogs = null;
      cachedMapping = null;
      cachedResult = [];
    },
  };
}

/**
 * Extracts traces from logs
 */
function extractTraces(
  logs: Record<string, unknown>[],
  fieldMapping: LogFieldMapping
): TraceData[] {
  if (!fieldMapping.traceId || logs.length === 0) {
    return [];
  }

  const traceIdField = fieldMapping.traceId;
  const spanIdField = fieldMapping.spanId;
  const parentSpanIdField = fieldMapping.parentSpanId;
  const timestampField = fieldMapping.timestamp;
  const levelField = fieldMapping.level;
  const messageField = fieldMapping.message;
  const sourceField = fieldMapping.source;

  // Group logs by trace ID
  const traceMap = new Map<string, { logs: Record<string, unknown>[]; indices: number[] }>();

  logs.forEach((log, index) => {
    const traceId = log[traceIdField];
    if (!traceId) return;

    const traceIdStr = String(traceId);
    if (!traceMap.has(traceIdStr)) {
      traceMap.set(traceIdStr, { logs: [], indices: [] });
    }
    const trace = traceMap.get(traceIdStr)!;
    trace.logs.push(log);
    trace.indices.push(index);
  });

  // Convert each trace group to TraceData
  const traces: TraceData[] = [];

  for (const [traceId, { logs: traceLogs, indices }] of traceMap) {
    // Build spans from logs
    const spanMap = new Map<string, SpanData>();
    const services = new Set<string>();
    let hasErrors = false;

    traceLogs.forEach((log, i) => {
      const spanId = spanIdField ? String(log[spanIdField] || `log-${indices[i]}`) : `log-${indices[i]}`;
      const parentSpanId = parentSpanIdField ? (log[parentSpanIdField] ? String(log[parentSpanIdField]) : null) : null;
      const timestamp = timestampField ? new Date(log[timestampField] as string) : new Date();
      const level = levelField ? String(log[levelField] || 'INFO').toUpperCase() : 'INFO';
      const message = messageField ? String(log[messageField] || '') : '';
      const service = sourceField ? (log[sourceField] ? String(log[sourceField]) : null) : null;

      if (service) services.add(service);
      if (['ERROR', 'FATAL', 'CRITICAL'].includes(level)) hasErrors = true;

      // If span already exists, update it (might have multiple logs per span)
      if (spanMap.has(spanId)) {
        const existingSpan = spanMap.get(spanId)!;
        // Update end timestamp if this log is later
        if (timestamp > existingSpan.timestamp) {
          existingSpan.endTimestamp = timestamp;
        } else if (timestamp < existingSpan.timestamp) {
          existingSpan.endTimestamp = existingSpan.timestamp;
          existingSpan.timestamp = timestamp;
        }
        // Keep the first operation/message
        if (!existingSpan.operation && message) {
          existingSpan.operation = truncateOperation(message);
        }
      } else {
        spanMap.set(spanId, {
          spanId,
          parentSpanId,
          timestamp,
          endTimestamp: null,
          duration: 0,
          operation: message ? truncateOperation(message) : null,
          level,
          logIndex: indices[i],
          service,
          children: [],
        });
      }
    });

    // Build span hierarchy
    const spans = Array.from(spanMap.values());
    const rootSpans: SpanData[] = [];

    // Link children to parents
    for (const span of spans) {
      if (span.parentSpanId && spanMap.has(span.parentSpanId)) {
        const parent = spanMap.get(span.parentSpanId)!;
        parent.children.push(span);
      } else {
        // No parent or parent not found - this is a root span
        rootSpans.push(span);
      }
    }

    // Sort children by timestamp
    for (const span of spans) {
      span.children.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    }

    // Calculate durations
    for (const span of spans) {
      if (span.endTimestamp) {
        span.duration = span.endTimestamp.getTime() - span.timestamp.getTime();
      } else if (span.children.length > 0) {
        // Duration is until the last child ends
        const lastChildEnd = Math.max(
          ...span.children.map(c => (c.endTimestamp || c.timestamp).getTime())
        );
        span.duration = lastChildEnd - span.timestamp.getTime();
      }
    }

    // Calculate trace timing
    const allTimestamps = spans.flatMap(s => [
      s.timestamp.getTime(),
      s.endTimestamp?.getTime() || s.timestamp.getTime(),
    ]);
    const startTime = new Date(Math.min(...allTimestamps));
    const endTime = new Date(Math.max(...allTimestamps));
    const totalDuration = endTime.getTime() - startTime.getTime();

    // Sort root spans by timestamp
    rootSpans.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    traces.push({
      traceId,
      spans,
      rootSpans,
      totalDuration,
      startTime,
      endTime,
      services: Array.from(services),
      hasErrors,
      logCount: traceLogs.length,
    });
  }

  // Sort traces by start time descending (most recent first)
  traces.sort((a, b) => b.startTime.getTime() - a.startTime.getTime());

  return traces;
}

/**
 * Truncates operation/message for display
 */
function truncateOperation(message: string): string {
  // Remove common prefixes
  let op = message.trim();

  // Take first line only
  const newlineIndex = op.indexOf('\n');
  if (newlineIndex > 0) {
    op = op.substring(0, newlineIndex);
  }

  // Truncate if too long
  if (op.length > 100) {
    op = op.substring(0, 97) + '...';
  }

  return op;
}

/**
 * Flattens a span tree into a list for rendering
 * Returns spans in depth-first order with depth info
 */
export function flattenSpanTree(
  rootSpans: SpanData[],
  depth: number = 0
): { span: SpanData; depth: number }[] {
  const result: { span: SpanData; depth: number }[] = [];

  for (const span of rootSpans) {
    result.push({ span, depth });
    if (span.children.length > 0) {
      result.push(...flattenSpanTree(span.children, depth + 1));
    }
  }

  return result;
}

/**
 * Formats duration for display
 */
export function formatDuration(ms: number): string {
  if (ms < 1) return '<1ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}
