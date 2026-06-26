/**
 * Log Pattern Extraction Utility
 * Groups structurally similar logs by extracting templates
 */

import type { LogFieldMapping } from './logFieldDetector';

/** Represents a single log pattern with aggregated statistics */
export interface LogPattern {
  /** Unique identifier for the pattern (hash of template) */
  id: string;
  /** The template string with placeholders */
  template: string;
  /** Number of logs matching this pattern */
  count: number;
  /** Percentage of total logs */
  percentage: number;
  /** Distribution of log levels for this pattern */
  levelDistribution: {
    error: number;
    warn: number;
    info: number;
    debug: number;
    other: number;
  };
  /** Timestamp of first occurrence */
  firstSeen: string | null;
  /** Timestamp of last occurrence */
  lastSeen: string | null;
  /** Indices of logs matching this pattern (for filtering) */
  matchingLogIndices: number[];
  /** Sample log messages (first 3) for preview */
  sampleMessages: string[];
}

/** Options for pattern extraction */
export interface PatternExtractionOptions {
  /** Maximum number of sample messages to store per pattern */
  maxSamples?: number;
  /** Minimum pattern count to include (filter noise) */
  minCount?: number;
}

// Regex patterns ordered by specificity (most specific first)
const EXTRACTION_PATTERNS: Array<{ regex: RegExp; placeholder: string }> = [
  // UUID: 8-4-4-4-12 hex format
  {
    regex: /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g,
    placeholder: '{UUID}',
  },

  // Email: standard email format (before other patterns to avoid partial matches)
  {
    regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    placeholder: '{EMAIL}',
  },

  // Timestamp: ISO 8601 and common formats
  {
    regex: /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g,
    placeholder: '{TS}',
  },

  // IP Address: IPv4
  {
    regex: /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g,
    placeholder: '{IP}',
  },

  // File paths: Unix-style absolute paths
  {
    regex: /\/(?:[a-zA-Z0-9._-]+\/)*[a-zA-Z0-9._-]+/g,
    placeholder: '{PATH}',
  },

  // Hex strings: 0x prefix
  {
    regex: /\b0x[0-9a-fA-F]+\b/g,
    placeholder: '{HEX}',
  },

  // Long hex sequences (8+ chars, likely IDs)
  {
    regex: /\b[0-9a-fA-F]{8,}\b/g,
    placeholder: '{HEX}',
  },

  // Quoted strings: double or single quoted
  {
    regex: /"[^"]*"/g,
    placeholder: '{STR}',
  },
  {
    regex: /'[^']*'/g,
    placeholder: '{STR}',
  },

  // Numbers: integers and decimals (last to avoid over-matching)
  {
    regex: /\b\d+(?:\.\d+)?\b/g,
    placeholder: '{NUM}',
  },
];

/**
 * Converts a log message to a template by replacing variable parts with placeholders
 */
export function messageToTemplate(message: string): string {
  let template = message;

  for (const { regex, placeholder } of EXTRACTION_PATTERNS) {
    // Reset regex lastIndex for global patterns
    regex.lastIndex = 0;
    template = template.replace(regex, placeholder);
  }

  // Collapse consecutive placeholders of same type (e.g., {NUM} {NUM} -> {NUM})
  template = template.replace(/(\{[A-Z]+\})(\s*\1)+/g, '$1');

  return template;
}

/**
 * Generates a simple hash for a template string (for pattern ID)
 */
export function hashTemplate(template: string): string {
  let hash = 0;
  for (let i = 0; i < template.length; i++) {
    const char = template.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(36);
}

/**
 * Normalizes a log level string to a standard category
 */
function normalizeLevel(level: string | null | undefined): 'error' | 'warn' | 'info' | 'debug' | 'other' {
  if (!level) return 'other';

  const upperLevel = String(level).toUpperCase();

  if (['ERROR', 'ERR', 'FATAL', 'CRITICAL', 'EMERG', 'ALERT'].includes(upperLevel)) {
    return 'error';
  }
  if (['WARN', 'WARNING'].includes(upperLevel)) {
    return 'warn';
  }
  if (['INFO', 'INFORMATION', 'NOTICE'].includes(upperLevel)) {
    return 'info';
  }
  if (['DEBUG', 'TRACE'].includes(upperLevel)) {
    return 'debug';
  }

  return 'other';
}

/**
 * Extracts patterns from an array of log records
 */
export function extractPatterns(
  logs: Record<string, unknown>[],
  fieldMapping: LogFieldMapping,
  options: PatternExtractionOptions = {}
): LogPattern[] {
  const { maxSamples = 3, minCount = 1 } = options;

  if (!fieldMapping.message || logs.length === 0) {
    return [];
  }

  // Group logs by pattern template
  const patternMap = new Map<string, {
    template: string;
    indices: number[];
    levels: { error: number; warn: number; info: number; debug: number; other: number };
    timestamps: string[];
    samples: string[];
  }>();

  for (let i = 0; i < logs.length; i++) {
    const log = logs[i];
    const message = log[fieldMapping.message];

    if (message === null || message === undefined) {
      continue;
    }

    const messageStr = String(message);
    const template = messageToTemplate(messageStr);
    const templateId = hashTemplate(template);

    if (!patternMap.has(templateId)) {
      patternMap.set(templateId, {
        template,
        indices: [],
        levels: { error: 0, warn: 0, info: 0, debug: 0, other: 0 },
        timestamps: [],
        samples: [],
      });
    }

    const pattern = patternMap.get(templateId)!;
    pattern.indices.push(i);

    // Track level distribution
    const level = fieldMapping.level ? log[fieldMapping.level] : null;
    const normalizedLevel = normalizeLevel(level as string | null);
    pattern.levels[normalizedLevel]++;

    // Track timestamps
    if (fieldMapping.timestamp) {
      const ts = log[fieldMapping.timestamp];
      if (ts) {
        pattern.timestamps.push(String(ts));
      }
    }

    // Store sample messages
    if (pattern.samples.length < maxSamples) {
      pattern.samples.push(messageStr);
    }
  }

  // Convert to LogPattern array
  const totalLogs = logs.length;
  const patterns: LogPattern[] = [];

  for (const [id, data] of patternMap.entries()) {
    if (data.indices.length < minCount) {
      continue;
    }

    // Sort timestamps to find first/last
    const sortedTimestamps = data.timestamps.sort();

    patterns.push({
      id,
      template: data.template,
      count: data.indices.length,
      percentage: (data.indices.length / totalLogs) * 100,
      levelDistribution: data.levels,
      firstSeen: sortedTimestamps[0] || null,
      lastSeen: sortedTimestamps[sortedTimestamps.length - 1] || null,
      matchingLogIndices: data.indices,
      sampleMessages: data.samples,
    });
  }

  // Sort by count descending
  patterns.sort((a, b) => b.count - a.count);

  return patterns;
}

/**
 * Creates a memoized pattern extractor
 */
export function createPatternExtractor() {
  let cachedLogs: Record<string, unknown>[] | null = null;
  let cachedFieldMapping: LogFieldMapping | null = null;
  let cachedPatterns: LogPattern[] | null = null;
  let cachedLogsLength = 0;

  return {
    extract(logs: Record<string, unknown>[], fieldMapping: LogFieldMapping): LogPattern[] {
      // Simple cache invalidation: check logs array reference, length, and field mapping
      if (
        cachedLogs === logs &&
        cachedLogsLength === logs.length &&
        cachedFieldMapping === fieldMapping &&
        cachedPatterns
      ) {
        return cachedPatterns;
      }

      cachedLogs = logs;
      cachedLogsLength = logs.length;
      cachedFieldMapping = fieldMapping;
      cachedPatterns = extractPatterns(logs, fieldMapping);

      return cachedPatterns;
    },

    invalidate() {
      cachedLogs = null;
      cachedFieldMapping = null;
      cachedPatterns = null;
      cachedLogsLength = 0;
    },
  };
}
