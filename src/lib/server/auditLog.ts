/**
 * Arc Enterprise audit log, read side (#12): every node's audit events and
 * counts.
 *
 * Arc writes audit events to each node's own SQLite database and does not
 * replicate them, so each node is read separately, pinned and
 * identity-checked like the Cluster view (clusterNodes.pinnedNodes), and the
 * answers are merged by time. A node that cannot be reached is reported as
 * such, never read through the load-balanced endpoint instead: its events
 * would be another node's.
 *
 * Free of $env imports (the caller passes options) so it runs under vitest.
 */

import { SharedCache } from './sharedCache.js';
import { intParam } from './util.js';
import { ClusterError, fingerprint, pinnedGet, pinnedNodes, type ClusterOptions, type ClusterTarget, type NodeAnswer, type PinnedNode } from './clusterNodes.js';
import { ADMIN_403, LICENSE_403 } from '../capabilities.js';
import { describeClusterError, MAX_NODES, NODE_ID_RE } from '../cluster.js';
import {
  ARC_TIME_RE,
  AUDIT_PAGE_MAX,
  AUDIT_PAGE_SIZE,
  FILTER_TEXT_MAX,
  mergeNodePages,
  mergeStats,
  parseAuditEntries,
  parseAuditStats,
  type AuditFilter,
  type AuditNodeIssue,
  type AuditNodeStatus,
  type AuditPage,
  type AuditStats,
  type NodeAuditState,
  type NodeCursor,
  type NodePage,
} from '../auditLog.js';

/** For the node reads, counted once the nodes are resolved. */
const DEADLINE_MS = 10_000;
/** A page is at most AUDIT_PAGE_MAX entries of a few hundred bytes each. */
const LOGS_MAX_BYTES = 2 * 1024 * 1024;
const STATS_MAX_BYTES = 256 * 1024;
/** Arc pages with OFFSET; past this, narrow the filter instead. */
export const MAX_OFFSET = 1_000_000;
const CURSOR_MAX_LENGTH = 32 * 1024;
const STATS_DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

const issue = (code: AuditNodeIssue['code'], message?: string): AuditNodeIssue => ({ code, message: message ?? describeClusterError(code) });

type Target = NonNullable<PinnedNode['target']>;

/** GET on a node, a transport failure folded into an issue. */
async function read(target: Target, path: string, t: ClusterTarget, opts: ClusterOptions, signal: AbortSignal, maxBytes: number): Promise<NodeAnswer | AuditNodeIssue> {
  try {
    return await pinnedGet(target, path, t, opts, signal, maxBytes);
  } catch (err) {
    return issue(err instanceof ClusterError ? err.code : 'internal');
  }
}
const failed = (a: NodeAnswer | AuditNodeIssue): a is AuditNodeIssue => 'code' in a;

/** What an audit answer other than 200 means. */
function refusal(a: NodeAnswer): { state: NodeAuditState; issue: AuditNodeIssue } {
  // Arc registers /api/v1/audit/* only when audit logging is enabled and
  // licensed at boot, so its own 404 for the route means it is off.
  if (a.status === 404 && /cannot get/i.test(a.message ?? '')) return { state: 'off', issue: issue('audit_off', 'Audit logging is not enabled on this node') };
  if (a.status === 401) return { state: 'refused', issue: issue('token_rejected') };
  if (a.status === 403 && ADMIN_403.test(a.message ?? '')) return { state: 'refused', issue: issue('token_not_admin') };
  if (a.status === 403 && LICENSE_403.test(a.message ?? '')) return { state: 'refused', issue: issue('not_licensed', 'The license no longer includes audit logging') };
  return { state: 'unreachable', issue: issue('upstream_status', `Arc answered ${a.status}`) };
}

/** The nodes to read: every node, or the one the filter names. */
async function selectNodes(t: ClusterTarget, node: string | null, opts: ClusterOptions): Promise<{ all: PinnedNode[]; selected: PinnedNode[] }> {
  const all = await pinnedNodes(t, opts);
  if (node === null) return { all, selected: all };
  const one = all.find((n) => n.nodeId === node);
  if (!one) throw new ClusterError('not_found', 'No such node in this instance');
  return { all, selected: [one] };
}

const status = (n: PinnedNode, state: NodeAuditState, i: AuditNodeIssue | null): AuditNodeStatus => ({
  nodeId: n.nodeId,
  source: n.target?.display ?? null,
  state,
  issue: i,
});

// ---------------------------------------------------------------------------
// Page cursor

/**
 * The cursor the view passes back for older events: per node still to read,
 * where to continue. Opaque to the browser; validated here like any input.
 */
export function encodeCursor(next: Record<string, NodeCursor>): string | null {
  return Object.keys(next).length ? Buffer.from(JSON.stringify(next), 'utf8').toString('base64url') : null;
}

export function decodeCursor(raw: string): Record<string, NodeCursor> | null {
  if (raw.length === 0 || raw.length > CURSOR_MAX_LENGTH || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0 || entries.length > MAX_NODES) return null;
  // Node ids are Arc config and may spell an Object.prototype key.
  const out: Record<string, NodeCursor> = Object.create(null);
  for (const [nodeId, v] of entries) {
    const c = v as Partial<NodeCursor> | null;
    if (!NODE_ID_RE.test(nodeId) || typeof c !== 'object' || c === null) return null;
    if (typeof c.until !== 'string' || !ARC_TIME_RE.test(c.until) || Number.isNaN(Date.parse(c.until))) return null;
    if (typeof c.offset !== 'number' || !Number.isSafeInteger(c.offset) || c.offset < 0 || c.offset > MAX_OFFSET) return null;
    out[nodeId] = { until: c.until, offset: c.offset };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Request parameters

export interface AuditQuery {
  filter: AuditFilter;
  limit: number;
  /** From a previous page's `next`; null for the newest events. */
  cursor: Record<string, NodeCursor> | null;
}

/** An RFC 3339 time, normalised to UTC milliseconds (which Arc parses); null when invalid. */
function isoParam(raw: string): string | null {
  if (!ARC_TIME_RE.test(raw)) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** A filter value Arc matches exactly; null when it is not a usable one. */
function textParam(raw: string): string | null {
  return raw.length <= FILTER_TEXT_MAX && !/[\u0000-\u001f\u007f]/.test(raw) && raw.trim() === raw ? raw : null;
}

/** The time window and node, shared by the events and the counts. */
function parseScope(url: URL): { since: string | null; until: string | null; node: string | null } | string {
  const p = url.searchParams;
  const since = p.get('since');
  const until = p.get('until');
  const node = p.get('node');
  const out = {
    since: since ? isoParam(since) : null,
    until: until ? isoParam(until) : null,
    node: node || null,
  };
  if ((since && !out.since) || (until && !out.until)) return 'since and until are RFC 3339 times';
  if (out.since && out.until && out.since > out.until) return 'since is after until';
  if (out.node !== null && !NODE_ID_RE.test(out.node)) return 'Invalid node id';
  return out;
}

/** The events route's query string; a message for a 400 when it is not valid. */
export function parseAuditQuery(url: URL): AuditQuery | string {
  const scope = parseScope(url);
  if (typeof scope === 'string') return scope;
  const p = url.searchParams;
  const eventTypeRaw = p.get('event_type') || null;
  const actorRaw = p.get('actor') || null;
  const databaseRaw = p.get('database') || null;
  const eventType = eventTypeRaw === null ? null : textParam(eventTypeRaw);
  const actor = actorRaw === null ? null : textParam(actorRaw);
  const database = databaseRaw === null ? null : textParam(databaseRaw);
  if ((eventTypeRaw !== null && eventType === null) || (actorRaw !== null && actor === null) || (databaseRaw !== null && database === null)) {
    return `event_type, actor and database are at most ${FILTER_TEXT_MAX} characters, without surrounding spaces`;
  }
  const limit = intParam(url, 'limit', AUDIT_PAGE_SIZE, 1, AUDIT_PAGE_MAX);
  if (limit === null) return `limit 1-${AUDIT_PAGE_MAX}`;
  const cursorRaw = p.get('cursor');
  const cursor = cursorRaw ? decodeCursor(cursorRaw) : null;
  if (cursorRaw && !cursor) return 'Invalid cursor';
  return { filter: { eventType, actor, database, ...scope }, limit, cursor };
}

/** The counts route's query string; a message for a 400 when it is not valid. */
export function parseStatsQuery(url: URL): { since: string | null; node: string | null } | string {
  const scope = parseScope(url);
  return typeof scope === 'string' ? scope : { since: scope.since, node: scope.node };
}

// ---------------------------------------------------------------------------
// Events

function logsPath(filter: AuditFilter, limit: number, from: NodeCursor | null): string {
  const params = new URLSearchParams({ limit: String(limit) });
  if (filter.eventType) params.set('event_type', filter.eventType);
  if (filter.actor) params.set('actor', filter.actor);
  if (filter.database) params.set('database', filter.database);
  if (filter.since) params.set('since', filter.since);
  const until = from?.until ?? filter.until;
  if (until) params.set('until', until);
  if (from && from.offset > 0) params.set('offset', String(from.offset));
  return `/api/v1/audit/logs?${params}`;
}

type NodeRead = { status: AuditNodeStatus; page: NodePage | null };

async function readNodePage(n: PinnedNode, q: AuditQuery, from: NodeCursor | null, t: ClusterTarget, opts: ClusterOptions, signal: AbortSignal): Promise<NodeRead> {
  if (!n.target) return { status: status(n, 'unreachable', issue(n.error ?? 'unreachable')), page: null };
  const a = await read(n.target, logsPath(q.filter, q.limit, from), t, opts, signal, LOGS_MAX_BYTES);
  if (failed(a)) return { status: status(n, 'unreachable', a), page: null };
  if (a.status !== 200) {
    const r = refusal(a);
    return { status: status(n, r.state, r.issue), page: null };
  }
  const parsed = parseAuditEntries(a.body, n.nodeId, q.limit);
  if (!parsed) return { status: status(n, 'unreachable', issue('upstream_status', 'Arc returned an unreadable response')), page: null };
  return { status: status(n, 'on', null), page: { ...parsed, nodeId: n.nodeId, requested: q.limit, from } };
}

const pageCache = new SharedCache<AuditPage>({ ttlMs: 5000, errorTtlMs: () => 0, maxEntries: 64 });

/**
 * One page of audit events from every node (or the filtered one), newest
 * first. A node that does not answer is left out of this page and of the
 * cursor, and the page says why. Shared for a few seconds between identical
 * requests, so it does not take a request's abort signal.
 */
export function getAuditPage(t: ClusterTarget, q: AuditQuery, opts: ClusterOptions): Promise<AuditPage> {
  return pageCache.get(`${fingerprint(t, opts)}|${JSON.stringify(q)}`, async () => {
    const { all, selected } = await selectNodes(t, q.filter.node, opts);
    // Older pages read only the nodes that still have events.
    const cursor = q.cursor;
    const from = (id: string) => (cursor && Object.hasOwn(cursor, id) ? cursor[id] : null);
    const toRead = cursor ? selected.filter((n) => from(n.nodeId)) : selected;
    const gone = cursor ? Object.keys(cursor).filter((id) => !all.some((n) => n.nodeId === id)) : [];
    const signal = AbortSignal.timeout(DEADLINE_MS);
    const reads = await Promise.all(toRead.map((n) => readNodePage(n, q, from(n.nodeId), t, opts, signal)));
    const merged = mergeNodePages(reads.flatMap((r) => (r.page ? [r.page] : [])), q.limit);
    return {
      allNodes: all.map((n) => n.nodeId),
      nodes: [
        ...reads.map((r) => r.status),
        ...gone.map((nodeId) => ({ nodeId, source: null, state: 'unreachable' as const, issue: issue('not_found') })),
      ],
      events: merged.events,
      next: encodeCursor(merged.next),
      loadedAt: Date.now(),
    };
  });
}

// ---------------------------------------------------------------------------
// Counts

const statsCache = new SharedCache<AuditStats>({ ttlMs: 5000, errorTtlMs: () => 0, maxEntries: 64 });

/**
 * Events per type on every node (or the filtered one) since `since`, which
 * defaults to the last 24 hours as in Arc. Arc counts by time only: the
 * actor, database and event type filters do not apply here.
 */
export function getAuditStats(t: ClusterTarget, q: { since: string | null; node: string | null }, opts: ClusterOptions): Promise<AuditStats> {
  return statsCache.get(`${fingerprint(t, opts)}|${q.since ?? ''}|${q.node ?? ''}`, async () => {
    const since = q.since ?? new Date(Date.now() - STATS_DEFAULT_WINDOW_MS).toISOString();
    const { selected } = await selectNodes(t, q.node, opts);
    const signal = AbortSignal.timeout(DEADLINE_MS);
    const path = `/api/v1/audit/stats?${new URLSearchParams({ since })}`;
    const reads = await Promise.all(selected.map(async (n): Promise<{ status: AuditNodeStatus; stats: Record<string, number> | null }> => {
      if (!n.target) return { status: status(n, 'unreachable', issue(n.error ?? 'unreachable')), stats: null };
      const a = await read(n.target, path, t, opts, signal, STATS_MAX_BYTES);
      if (failed(a)) return { status: status(n, 'unreachable', a), stats: null };
      if (a.status !== 200) {
        const r = refusal(a);
        return { status: status(n, r.state, r.issue), stats: null };
      }
      const stats = parseAuditStats(a.body);
      if (!stats) return { status: status(n, 'unreachable', issue('upstream_status', 'Arc returned an unreadable response')), stats: null };
      return { status: status(n, 'on', null), stats };
    }));
    const byType = mergeStats(reads.flatMap((r) => (r.stats ? [r.stats] : [])));
    return {
      nodes: reads.map((r) => r.status),
      byType,
      total: byType.reduce((sum, s) => sum + s.count, 0),
      since,
      loadedAt: Date.now(),
    };
  });
}

/** Test hook. */
export function resetAuditCachesForTests(): void {
  pageCache.clear();
  statsCache.clear();
}
