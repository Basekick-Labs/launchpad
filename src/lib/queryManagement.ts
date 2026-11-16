/**
 * Arc Enterprise active query management (#11): the queries each node runs
 * now, the ones it finished recently, and cancelling one.
 *
 * Arc tracks queries in memory on the node that runs them
 * (internal/queryregistry): a map of running queries and a ring buffer of
 * finished ones (`[query_management] history_size`, 100 by default). Nothing
 * is replicated, and a cancel only reaches the node that holds the query, so
 * Launchpad reads every node and sends a cancel to the query's own node. This
 * is the pure, isomorphic half: parsing what /api/v1/queries/* returns, the
 * merge, the filters, and the API contract with the Queries view. The I/O is
 * src/lib/server/queryManagement.ts.
 *
 * Shapes are checked against Arc main (internal/queryregistry/registry.go,
 * internal/api/query_management.go).
 */

import type { ClusterErrorCode } from './cluster';

export type QueryStatus = 'running' | 'completed' | 'cancelled' | 'failed' | 'timed_out';

export const FINISHED_STATUSES = ['completed', 'failed', 'cancelled', 'timed_out'] as const satisfies readonly QueryStatus[];

export const STATUS_LABEL: Record<QueryStatus, string> = {
  running: 'Running',
  completed: 'Completed',
  cancelled: 'Cancelled',
  failed: 'Failed',
  timed_out: 'Timed out',
};

const STATUSES = new Set<string>(Object.keys(STATUS_LABEL));

/**
 * Arc's query ids are the first 12 characters of a v4 UUID (lowercase hex and
 * one hyphen). Kept strict: the id becomes a path segment on the node, and
 * must never spell Arc's sibling routes (`active`, `history`).
 */
export const QUERY_ID_RE = /^[0-9a-f][0-9a-f-]{0,35}$/;

/** Finished queries read from each node; Arc keeps 100 unless configured otherwise. */
export const HISTORY_PER_NODE = 200;
/** Finished queries shown across all nodes, newest first. */
export const HISTORY_MAX = 500;
/** Running queries kept per node; more is not a list anyone reads. */
export const ACTIVE_PER_NODE = 1000;
/** SQL kept per query in the lists; the detail reads the full text from the node. */
export const LIST_SQL_MAX = 2000;
export const DETAIL_SQL_MAX = 256 * 1024;
const ERROR_MAX = 2000;
const NAME_MAX = 128;
const ADDR_MAX = 128;

/**
 * The active list cuts SQL longer than this many bytes to that many plus
 * "..." (Go's sql[:200] in internal/api/query_management.go). Bytes, not
 * characters: SQL with non-ASCII text is cut sooner.
 */
const ARC_ACTIVE_SQL_CUT_BYTES = 200;
const utf8 = new TextEncoder();

export interface TrackedQuery {
  /** The node that runs or ran it ('standalone' for a single node). */
  nodeId: string;
  /** Arc's id, unique per node only. */
  id: string;
  sql: string;
  /** The SQL here is cut short; the detail has the full text. */
  sqlTruncated: boolean;
  /** The Arc token that sent it; null when Arc ran without auth. */
  tokenId: number | null;
  tokenName: string | null;
  /** The client address Arc saw. */
  remoteAddr: string | null;
  status: QueryStatus;
  /** RFC 3339, as Arc sent it (whole seconds in the active list). */
  startTime: string;
  endTime: string | null;
  /** Elapsed time when Arc answered for a running query; total time for a finished one. */
  durationMs: number;
  /** Rows returned; null unless it completed here (a forward carries none). */
  rowCount: number | null;
  /** The governance row cap the result reached, when it did. */
  rowCap: number | null;
  /** Arc's failure or cancellation reason. */
  error: string | null;
  /** The node a compactor forwarded this query to; cancelling it ends the forward. */
  forwardedTo: string | null;
}

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

// Control characters other than tab and newline would garble the view.
const strip = (s: string) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
const clean = (s: string, max: number) => strip(s).slice(0, max);
const text = (v: unknown, max: number) => (typeof v === 'string' && v !== '' ? clean(v, max) : null);
const count = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null);
const time = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null);

/**
 * One query from Arc, or null when it is not one Launchpad can show and act
 * on. `sqlMax` bounds the SQL; `fromActiveList` says Arc may have cut it.
 */
export function parseTrackedQuery(v: unknown, nodeId: string, sqlMax: number, fromActiveList = false): TrackedQuery | null {
  const o = obj(v);
  if (!o || typeof o.id !== 'string' || !QUERY_ID_RE.test(o.id)) return null;
  if (typeof o.status !== 'string' || !STATUSES.has(o.status)) return null;
  const startTime = time(o.start_time);
  if (!startTime || typeof o.sql !== 'string') return null;
  const full = strip(o.sql);
  // Arc leaves SQL of up to 200 bytes whole there, so anything longer was cut.
  const arcCut = fromActiveList && utf8.encode(o.sql).length > ARC_ACTIVE_SQL_CUT_BYTES;
  const duration = o.duration_ms;
  const forwardedTo = text(o.forwarded_to, NAME_MAX);
  const rows = o.row_count;
  return {
    nodeId,
    id: o.id,
    sql: full.slice(0, sqlMax),
    sqlTruncated: arcCut || full.length > sqlMax,
    tokenId: count(o.token_id),
    tokenName: text(o.token_name, NAME_MAX),
    remoteAddr: text(o.remote_addr, ADDR_MAX),
    status: o.status as QueryStatus,
    startTime,
    endTime: time(o.end_time),
    // Arc omits it when 0 (omitempty).
    durationMs: typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? duration : 0,
    // Only a completed query run here has a row count, and Arc omits it when 0.
    rowCount: o.status !== 'completed' || forwardedTo ? null : typeof rows === 'number' && Number.isSafeInteger(rows) && rows >= 0 ? rows : 0,
    rowCap: count(o.row_cap),
    error: text(o.error, ERROR_MAX),
    forwardedTo,
  };
}

/** The `queries` array of an active or history answer, bounded; null when the body is not one. */
export function parseQueryList(body: unknown, nodeId: string, max: number, fromActiveList: boolean): { queries: TrackedQuery[]; truncated: boolean } | null {
  const list = obj(body)?.queries;
  if (!Array.isArray(list)) return null;
  const queries: TrackedQuery[] = [];
  for (const v of list.slice(0, max)) {
    const q = parseTrackedQuery(v, nodeId, LIST_SQL_MAX, fromActiveList);
    if (q && (fromActiveList ? q.status === 'running' : q.status !== 'running')) queries.push(q);
  }
  return { queries, truncated: list.length > max };
}

const ms = (iso: string | null) => (iso ? Date.parse(iso) : NaN);

export interface NodeQueries {
  nodeId: string;
  active: TrackedQuery[];
  history: TrackedQuery[];
}

/**
 * Every node's lists as one. A query that finished between the node's two
 * reads is in both lists: it shows once, as finished. Running queries are
 * oldest first (the longest running lead); finished ones newest first, up to
 * `historyMax`.
 */
export function mergeNodeQueries(nodes: NodeQueries[], historyMax = HISTORY_MAX): { active: TrackedQuery[]; history: TrackedQuery[]; historyTruncated: boolean } {
  const active: TrackedQuery[] = [];
  const history: TrackedQuery[] = [];
  for (const n of nodes) {
    const finished = new Set(n.history.map((q) => q.id));
    for (const q of n.active) if (!finished.has(q.id)) active.push(q);
    history.push(...n.history);
  }
  active.sort((a, b) => ms(a.startTime) - ms(b.startTime) || b.durationMs - a.durationMs || a.nodeId.localeCompare(b.nodeId) || a.id.localeCompare(b.id));
  const ended = (q: TrackedQuery) => (Number.isNaN(ms(q.endTime)) ? ms(q.startTime) + q.durationMs : ms(q.endTime));
  history.sort((a, b) => ended(b) - ended(a) || a.nodeId.localeCompare(b.nodeId) || a.id.localeCompare(b.id));
  return { active, history: history.slice(0, historyMax), historyTruncated: history.length > historyMax };
}

// ---------------------------------------------------------------------------
// Filters (applied in the view to what was loaded: Arc filters nothing)

export interface QueryFilter {
  /** Node id, or null for every node. */
  node: string | null;
  /** Token name, or null for every token. */
  token: string | null;
  /** Finished queries only; null for every status. */
  status: QueryStatus | null;
  /** Case-insensitive text in the SQL, the id or the error. */
  search: string;
}

export const NO_FILTER: QueryFilter = { node: null, token: null, status: null, search: '' };

/** The label a query's token is filtered and shown by. */
export function tokenLabel(q: Pick<TrackedQuery, 'tokenId' | 'tokenName'>): string {
  return q.tokenName ?? (q.tokenId !== null ? `token ${q.tokenId}` : 'no token');
}

export function matchesFilter(q: TrackedQuery, f: QueryFilter): boolean {
  if (f.node !== null && q.nodeId !== f.node) return false;
  if (f.token !== null && tokenLabel(q) !== f.token) return false;
  if (f.status !== null && q.status !== f.status) return false;
  const needle = f.search.trim().toLowerCase();
  if (!needle) return true;
  return q.sql.toLowerCase().includes(needle) || q.id.includes(needle) || (q.error?.toLowerCase().includes(needle) ?? false);
}

// ---------------------------------------------------------------------------
// API contract with the view

export type NodeQueriesState =
  /** Query management answers. */
  | 'on'
  /** Not enabled (or not licensed at boot) on this node. */
  | 'off'
  /** The node refused the stored token, or its license lapsed. */
  | 'refused'
  /** The node could not be read. */
  | 'unreachable';

export interface NodeIssue {
  code: ClusterErrorCode | 'query_management_off' | 'not_licensed';
  message: string;
}

export interface NodeQueriesStatus {
  nodeId: string;
  /** host:port the data came from. */
  source: string | null;
  state: NodeQueriesState;
  issue: NodeIssue | null;
  /** More running queries than Launchpad keeps per node. */
  activeTruncated: boolean;
}

export interface QueriesView {
  nodes: NodeQueriesStatus[];
  active: TrackedQuery[];
  history: TrackedQuery[];
  /** Finished queries beyond HISTORY_MAX were left out. */
  historyTruncated: boolean;
  /** The id of the token Launchpad itself uses (console, explorer, alerts); null when unknown. */
  launchpadTokenId: number | null;
  fetchedAt: number;
  servedAt: number;
}

export interface QueryDetail {
  query: TrackedQuery;
  /** host:port of the node that answered. */
  source: string;
}

/**
 * What a cancel did:
 *  - `cancelled`: Arc cancelled it;
 *  - `already_finished`: it had ended before the cancel arrived (`query` says how);
 *  - `not_found`: the node no longer knows it (left its history, or the node restarted).
 */
export type CancelResult = 'cancelled' | 'already_finished' | 'not_found';

export interface CancelOutcome {
  result: CancelResult;
  nodeId: string;
  queryId: string;
  /** The query as the node holds it after the cancel; null when it could not be read. */
  query: TrackedQuery | null;
}

const ALREADY: Record<Exclude<QueryStatus, 'running'>, string> = {
  completed: 'completed',
  failed: 'failed',
  cancelled: 'been cancelled',
  timed_out: 'timed out',
};

/** The sentence for a cancel's outcome. */
export function describeCancel(o: CancelOutcome): string {
  const where = o.nodeId === 'standalone' ? '' : ` on ${o.nodeId}`;
  if (o.result === 'cancelled') return `Query ${o.queryId} was cancelled${where}.`;
  if (o.result === 'already_finished') {
    const how = o.query && o.query.status !== 'running' ? ALREADY[o.query.status] : 'finished';
    return `Query ${o.queryId} had already ${how}${where}; nothing was cancelled.`;
  }
  return `Query ${o.queryId} is no longer known${where}: it left the node's history, or the node restarted. Nothing was cancelled.`;
}
