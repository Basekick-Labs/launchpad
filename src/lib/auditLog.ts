/**
 * Arc Enterprise audit log (#12): the requests Arc recorded, who made them,
 * and what they touched.
 *
 * Arc writes each node's audit events to that node's own SQLite database and
 * does not replicate them, so Launchpad reads every node and merges the
 * answers by time. This is the pure, isomorphic half: parsing what
 * /api/v1/audit/logs and /api/v1/audit/stats return, the merge, and the API
 * contract with the Audit Log view. The I/O is src/lib/server/auditLog.ts.
 *
 * Shapes are checked against Arc main and v26.09.4 (internal/audit/audit.go,
 * internal/api/audit_routes.go).
 */

import type { ClusterErrorCode } from './cluster';

/** Events per page; Arc caps a read at 10,000, Launchpad far lower. */
export const AUDIT_PAGE_SIZE = 100;
export const AUDIT_PAGE_MAX = 200;
/** Distinct event types per node kept from /api/v1/audit/stats. */
export const AUDIT_STATS_MAX_TYPES = 500;

/**
 * Event types Arc's audit middleware writes (classifyEvent in
 * internal/audit/middleware.go), offered as filter suggestions next to the
 * ones the stats report. RBAC events (rbac.<resource>.<action>) and the
 * method-suffixed families are open-ended, so the filter takes any value.
 */
export const KNOWN_EVENT_TYPES = [
  'auth.failed',
  'token.created',
  'token.rotated',
  'token.deleted',
  'data.query',
  'data.write',
  'data.import',
  'data.delete',
  'database.created',
  'database.deleted',
  'compaction.triggered',
] as const;

/**
 * Filters (event type, actor, database) are free text Arc matches exactly.
 * Event types are dotted names, but RBAC ones carry a raw path segment
 * (rbac.<segment>.<action>), so they are text too.
 */
export const FILTER_TEXT_MAX = 128;

/**
 * Go marshals time.Time as RFC 3339 with up to nine fractional digits. The
 * value is passed back to Arc verbatim as a page boundary, so it must stay in
 * a form Go's time.Parse(time.RFC3339) accepts.
 */
export const ARC_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export interface AuditEvent {
  /** The node whose audit log holds the event ('standalone' for a single node). */
  nodeId: string;
  /** Arc's row id, unique per node only. */
  id: number;
  /** As Arc sent it (RFC 3339, up to nanoseconds). */
  timestamp: string;
  eventType: string;
  /** Arc token name, or "anonymous". */
  actor: string;
  method: string;
  path: string;
  database: string | null;
  measurement: string | null;
  statusCode: number | null;
  ipAddress: string | null;
  userAgent: string | null;
  durationMs: number | null;
  /** Handler-supplied context (e.g. a cluster file removal's path and reason), as key/value pairs. */
  detail: Array<[string, string]> | null;
}

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** A bounded string without control characters; null when empty or absent. */
function text(v: unknown, max: number): string | null {
  if (typeof v !== 'string' || v === '') return null;
  const clean = v.replace(/[\u0000-\u001f\u007f]/g, ' ');
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

const nonNegInt = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);

const DETAIL_MAX_KEYS = 32;

/** Arc stores the detail map as a JSON string; anything else is kept as one bounded value. */
function parseDetail(v: unknown): Array<[string, string]> | null {
  if (typeof v !== 'string' || v === '') return null;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(v);
  } catch {
    /* not JSON: shown as is */
  }
  const o = obj(parsed);
  if (!o) {
    const raw = text(v, 2048);
    return raw ? [['detail', raw]] : null;
  }
  const out: Array<[string, string]> = [];
  for (const [k, value] of Object.entries(o).slice(0, DETAIL_MAX_KEYS)) {
    const key = text(k, 64);
    const val = typeof value === 'string' ? text(value, 2048) ?? '' : text(JSON.stringify(value) ?? '', 2048) ?? '';
    if (key) out.push([key, val]);
  }
  return out.length ? out : null;
}

/** One entry of /api/v1/audit/logs, or null when it is not one. */
export function parseAuditEntry(raw: unknown, nodeId: string): AuditEvent | null {
  const o = obj(raw);
  if (!o) return null;
  const id = nonNegInt(o.id);
  const timestamp = typeof o.timestamp === 'string' && ARC_TIME_RE.test(o.timestamp) ? o.timestamp : null;
  const eventType = text(o.event_type, FILTER_TEXT_MAX);
  const method = typeof o.method === 'string' && /^[A-Z]{1,16}$/.test(o.method) ? o.method : null;
  const path = text(o.path, 1024);
  // Without these the row cannot be ordered, filtered or described.
  if (id === null || !timestamp || Number.isNaN(Date.parse(timestamp)) || !eventType || !method || !path) return null;
  const status = nonNegInt(o.status_code);
  return {
    nodeId,
    id,
    timestamp,
    eventType,
    actor: text(o.actor, FILTER_TEXT_MAX) ?? 'anonymous',
    method,
    path,
    database: text(o.database, FILTER_TEXT_MAX),
    measurement: text(o.measurement, FILTER_TEXT_MAX),
    // Arc stores 0 when the column was NULL.
    statusCode: status && status >= 100 && status <= 599 ? status : null,
    ipAddress: text(o.ip_address, 64),
    userAgent: text(o.user_agent, 256),
    durationMs: nonNegInt(o.duration_ms),
    detail: parseDetail(o.detail),
  };
}

/** A /api/v1/audit/logs answer: the usable entries, and where they sat in what Arc sent. */
export interface ParsedEntries {
  entries: AuditEvent[];
  /** Each entry's position among the rows Arc returned. */
  positions: number[];
  /** Rows Arc returned, usable or not: what its OFFSET counts. */
  received: number;
  /** Timestamp of the first (newest) row Arc returned; null when there were none. */
  newest: string | null;
}

/**
 * Entries of a /api/v1/audit/logs body; null when the body is not one. A row
 * that cannot be used is skipped, but still counted where Arc counts it, so
 * paging neither repeats nor skips around it.
 */
export function parseAuditEntries(body: unknown, nodeId: string, max: number): ParsedEntries | null {
  const data = obj(body)?.data;
  // Arc sends `data: null` when nothing matches (a nil Go slice).
  if (data === null) return { entries: [], positions: [], received: 0, newest: null };
  if (!Array.isArray(data)) return null;
  const rows = data.slice(0, max);
  const out: ParsedEntries = { entries: [], positions: [], received: rows.length, newest: null };
  rows.forEach((row, i) => {
    const e = parseAuditEntry(row, nodeId);
    if (e) {
      out.entries.push(e);
      out.positions.push(i);
    }
  });
  const first = obj(rows[0])?.timestamp;
  out.newest = typeof first === 'string' && ARC_TIME_RE.test(first) && !Number.isNaN(Date.parse(first)) ? first : out.entries[0]?.timestamp ?? null;
  return out;
}

/** Counts per event type of a /api/v1/audit/stats body; null when the body is not one. */
export function parseAuditStats(body: unknown): Record<string, number> | null {
  const data = obj(body)?.data;
  if (data === null) return {};
  const o = obj(data);
  if (!o) return null;
  // Event types come from request paths and may spell an Object.prototype key.
  const out: Record<string, number> = Object.create(null);
  for (const [type, count] of Object.entries(o).slice(0, AUDIT_STATS_MAX_TYPES)) {
    const n = nonNegInt(count);
    const name = text(type, FILTER_TEXT_MAX);
    if (name && n !== null) out[name] = (out[name] ?? 0) + n;
  }
  return out;
}

/**
 * Sort key for an Arc timestamp: epoch milliseconds, then the sub-millisecond
 * digits JavaScript dates drop, so events within one millisecond keep Arc's
 * order.
 */
export function timeKey(ts: string): [number, number] {
  const ms = Date.parse(ts);
  const frac = /\.(\d+)/.exec(ts)?.[1] ?? '';
  return [ms, Number((frac.slice(3) + '000000').slice(0, 6))];
}

/** Newest first; ties broken by node and then Arc's row id, so the order is total. */
export function compareEvents(a: AuditEvent, b: AuditEvent): number {
  const [am, an] = timeKey(a.timestamp);
  const [bm, bn] = timeKey(b.timestamp);
  if (am !== bm) return bm - am;
  if (an !== bn) return bn - an;
  if (a.nodeId !== b.nodeId) return a.nodeId < b.nodeId ? -1 : 1;
  return b.id - a.id;
}

// ---------------------------------------------------------------------------
// Merging pages from several nodes

/**
 * Where to continue reading one node. `until` is the newest timestamp the node
 * returned on the first page: later pages ask for events up to it, so events
 * written meanwhile do not shift the offsets.
 */
export interface NodeCursor {
  until: string;
  offset: number;
}

/** What one node returned for a page. */
export interface NodePage extends ParsedEntries {
  nodeId: string;
  /** How many rows were asked for: fewer back means the node has no more. */
  requested: number;
  /** Where this read started; null on the first page. */
  from: NodeCursor | null;
}

export interface MergedPage {
  events: AuditEvent[];
  /** Nodes with events left to read, and where; empty when every node is done. */
  next: Record<string, NodeCursor>;
}

/**
 * Merge the nodes' pages, newest first, into one page of `limit` events, and
 * say where each node continues. Each node's entries are taken in the order
 * Arc returned them, so what a node continues from is exactly the prefix
 * used, counted in Arc's rows. A node is done once it returned fewer rows
 * than asked for and all of them were used.
 */
export function mergeNodePages(pages: NodePage[], limit: number): MergedPage {
  const taken = pages.map(() => 0);
  const events: AuditEvent[] = [];
  while (events.length < limit) {
    let best = -1;
    pages.forEach((p, i) => {
      const head = p.entries[taken[i]];
      if (head && (best < 0 || compareEvents(head, pages[best].entries[taken[best]]) < 0)) best = i;
    });
    if (best < 0) break;
    events.push(pages[best].entries[taken[best]++]);
  }
  // Node ids are Arc config and may spell an Object.prototype key.
  const next: Record<string, NodeCursor> = Object.create(null);
  pages.forEach((p, i) => {
    const left = taken[i] < p.entries.length;
    if (!p.newest || (!left && p.received < p.requested)) return;
    // Rows used, in Arc's count: up to the first entry not shown, or all of them.
    const used = left ? p.positions[taken[i]] : p.received;
    next[p.nodeId] = { until: p.from?.until ?? p.newest, offset: (p.from?.offset ?? 0) + used };
  });
  return { events, next };
}

/** Event types and counts from every node, most frequent first. */
export function mergeStats(nodes: Array<Record<string, number>>): Array<{ eventType: string; count: number }> {
  const totals = new Map<string, number>();
  for (const stats of nodes) for (const [type, n] of Object.entries(stats)) totals.set(type, (totals.get(type) ?? 0) + n);
  return [...totals]
    .map(([eventType, count]) => ({ eventType, count }))
    .sort((a, b) => b.count - a.count || (a.eventType < b.eventType ? -1 : 1));
}

// ---------------------------------------------------------------------------
// Presentation

export type EventTone = 'failure' | 'error' | 'change' | 'read';

/** How the view colours an event: refused, failed, a change, or a read. */
export function eventTone(e: Pick<AuditEvent, 'eventType' | 'method' | 'statusCode'>): EventTone {
  if (e.eventType === 'auth.failed') return 'failure';
  if (e.statusCode !== null && e.statusCode >= 400) return 'error';
  if (e.method === 'GET' || e.method === 'HEAD' || e.eventType === 'data.query') return 'read';
  return 'change';
}

/** Time windows the view offers; 'all' is whatever Arc still keeps (audit_log.retention_days). */
export const AUDIT_RANGES = [
  { id: '1h', label: 'Last hour', ms: 60 * 60 * 1000 },
  { id: '24h', label: 'Last 24 hours', ms: 24 * 60 * 60 * 1000 },
  { id: '7d', label: 'Last 7 days', ms: 7 * 24 * 60 * 60 * 1000 },
  { id: '30d', label: 'Last 30 days', ms: 30 * 24 * 60 * 60 * 1000 },
  { id: 'all', label: 'All retained', ms: null },
] as const;
export type AuditRangeId = (typeof AUDIT_RANGES)[number]['id'];

/** A preset window as filter bounds, ending now. */
export function rangeBounds(id: AuditRangeId, now: number): { since: string | null; until: string | null } {
  const ms = AUDIT_RANGES.find((r) => r.id === id)?.ms ?? null;
  return { since: ms === null ? null : new Date(now - ms).toISOString(), until: null };
}

/**
 * A datetime-local input value ("2026-11-13T09:30") as an ISO time, read in
 * the timezone the viewer chose for the console. Null when empty or invalid.
 */
export function inputToIso(value: string, tz: 'utc' | 'local'): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) return null;
  const ms = tz === 'utc' ? Date.parse(`${value}Z`) : new Date(value).getTime();
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// API contract between Launchpad's audit routes and the Audit Log view

export interface AuditFilter {
  eventType: string | null;
  actor: string | null;
  database: string | null;
  /** ISO 8601 bounds, inclusive. */
  since: string | null;
  until: string | null;
  /** One node of a cluster; null reads every node. */
  node: string | null;
}

/** What Launchpad found on one node. */
export type NodeAuditState =
  /** The audit log answered. */
  | 'on'
  /** Audit logging is not enabled (or was not licensed at boot) on this node. */
  | 'off'
  /** Arc refused: the license lapsed, or the stored token is not admin. */
  | 'refused'
  /** Launchpad could not reach or verify this node, or Arc failed. */
  | 'unreachable';

/** Why a node is not 'on': a code for logic, a sentence (written by Launchpad) to show. */
export interface AuditNodeIssue {
  code: ClusterErrorCode | 'audit_off' | 'not_licensed';
  message: string;
}

export interface AuditNodeStatus {
  nodeId: string;
  /** host:port the events came from. */
  source: string | null;
  state: NodeAuditState;
  issue: AuditNodeIssue | null;
}

export interface AuditPage {
  /** Every node of the instance, for the node filter. */
  allNodes: string[];
  /** The nodes read for this page and what each answered. */
  nodes: AuditNodeStatus[];
  events: AuditEvent[];
  /** Opaque: pass back with the same filter for older events; null when there are none. */
  next: string | null;
  loadedAt: number;
}

export interface AuditStats {
  nodes: AuditNodeStatus[];
  byType: Array<{ eventType: string; count: number }>;
  total: number;
  /** The window start Arc counted from (its default is the last 24 hours). */
  since: string;
  loadedAt: number;
}
