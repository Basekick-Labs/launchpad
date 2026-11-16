/**
 * Arc Enterprise active query management (#11): every node's running and
 * recently finished queries, one query's detail, and cancelling it.
 *
 * Arc keeps its query registry in memory on each node and does not replicate
 * it, so each node is read separately, pinned and identity-checked like the
 * Cluster view (clusterNodes.pinnedNodes). A cancel goes to the node the
 * query runs on, never through the load-balanced endpoint, where it would
 * reach a random node that does not know the query. A node that cannot be
 * reached is reported as such.
 *
 * Every cancel sent is recorded in the instance change log with the
 * Launchpad user and its outcome.
 *
 * Free of $env imports (the caller passes options) so it runs under vitest.
 */

import { SharedCache } from './sharedCache.js';
import { recordChange } from './instanceChangeLog.js';
import { ClusterError, fingerprint, pinnedDelete, pinnedGet, pinnedNodes, type ClusterOptions, type ClusterTarget, type NodeAnswer, type PinnedNode } from './clusterNodes.js';
import { ADMIN_403, LICENSE_403 } from '../capabilities.js';
import { describeClusterError } from '../cluster.js';
import {
  ACTIVE_PER_NODE,
  DETAIL_SQL_MAX,
  HISTORY_PER_NODE,
  mergeNodeQueries,
  parseQueryList,
  parseTrackedQuery,
  STATUS_LABEL,
  type CancelOutcome,
  type NodeIssue,
  type NodeQueries,
  type NodeQueriesState,
  type NodeQueriesStatus,
  type QueriesView,
  type QueryDetail,
  type TrackedQuery,
} from '../queryManagement.js';

/** For the node reads, counted once the nodes are resolved. */
const DEADLINE_MS = 10_000;
/** The cancel and its read-back; not tied to the admin's request (see cancelQuery). */
const CANCEL_DEADLINE_MS = 10_000;
/** History carries full SQL: up to HISTORY_PER_NODE statements per node. */
const LIST_MAX_BYTES = 8 * 1024 * 1024;
const DETAIL_MAX_BYTES = 2 * 1024 * 1024;
const SMALL_MAX_BYTES = 16 * 1024;
/** Under the view's refresh interval, so viewers share a load but each refresh is fresh. */
const VIEW_TTL_MS = 2000;

const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const issue = (code: NodeIssue['code'], message?: string): NodeIssue => ({ code, message: message ?? describeClusterError(code) });

type Target = NonNullable<PinnedNode['target']>;

/** GET on a node, a transport failure folded into an issue. */
async function read(target: Target, path: string, t: ClusterTarget, opts: ClusterOptions, signal: AbortSignal, maxBytes: number): Promise<NodeAnswer | NodeIssue> {
  try {
    return await pinnedGet(target, path, t, opts, signal, maxBytes);
  } catch (err) {
    return issue(err instanceof ClusterError ? err.code : 'internal');
  }
}
const failed = (a: NodeAnswer | NodeIssue): a is NodeIssue => 'code' in a;

/**
 * Arc's own 404 for a route it did not register: query management is off (or
 * was not licensed at boot) on that node. Its handlers answer a missing query
 * with {"error": "Query not found"} instead.
 */
const routeAbsent = (a: NodeAnswer) => a.status === 404 && /^cannot (get|delete)\b/i.test(a.message ?? '');
/** The handlers' own 404: the node does not know this query (internal/api/query_management.go). */
const queryUnknown = (a: NodeAnswer) => a.status === 404 && /^query not found$/i.test(a.message ?? '');

/** What an answer other than 200 means. */
function refusal(a: NodeAnswer): { state: NodeQueriesState; issue: NodeIssue } {
  if (routeAbsent(a)) return { state: 'off', issue: issue('query_management_off', 'Query management is not enabled on this node') };
  if (a.status === 401) return { state: 'refused', issue: issue('token_rejected') };
  if (a.status === 403 && ADMIN_403.test(a.message ?? '')) return { state: 'refused', issue: issue('token_not_admin') };
  if (a.status === 403 && LICENSE_403.test(a.message ?? '')) return { state: 'refused', issue: issue('not_licensed', 'The license no longer includes query management') };
  return { state: 'unreachable', issue: issue('upstream_status', `Arc answered ${a.status}`) };
}

/** The same refusal, thrown, for the routes about one query. */
function refusalError(a: NodeAnswer): ClusterError {
  const { issue: i } = refusal(a);
  const code = i.code === 'query_management_off' || i.code === 'not_licensed' ? 'upstream_status' : i.code;
  return new ClusterError(code, i.message);
}

type NodeRead = { status: NodeQueriesStatus; lists: NodeQueries | null };

/**
 * One node's running queries, then its finished ones. In that order: a query
 * that finishes between the two reads is then in both lists, and the merge
 * shows it once, as finished. The other order would lose it for a refresh.
 */
async function readNode(n: PinnedNode, t: ClusterTarget, opts: ClusterOptions, signal: AbortSignal): Promise<NodeRead> {
  const status = (state: NodeQueriesState, i: NodeIssue | null, activeTruncated = false): NodeQueriesStatus => ({
    nodeId: n.nodeId,
    source: n.target?.display ?? null,
    state,
    issue: i,
    activeTruncated,
  });
  if (!n.target) return { status: status('unreachable', issue(n.error ?? 'unreachable')), lists: null };
  const unreadable = () => ({ status: status('unreachable', issue('upstream_status', 'Arc returned an unreadable response')), lists: null });

  const activeAnswer = await read(n.target, '/api/v1/queries/active', t, opts, signal, LIST_MAX_BYTES);
  if (failed(activeAnswer)) return { status: status('unreachable', activeAnswer), lists: null };
  if (activeAnswer.status !== 200) {
    const r = refusal(activeAnswer);
    return { status: status(r.state, r.issue), lists: null };
  }
  const active = parseQueryList(activeAnswer.body, n.nodeId, ACTIVE_PER_NODE, true);
  if (!active) return unreadable();

  const historyAnswer = await read(n.target, `/api/v1/queries/history?limit=${HISTORY_PER_NODE}`, t, opts, signal, LIST_MAX_BYTES);
  if (failed(historyAnswer)) return { status: status('unreachable', historyAnswer), lists: null };
  if (historyAnswer.status !== 200) {
    const r = refusal(historyAnswer);
    return { status: status(r.state, r.issue), lists: null };
  }
  const history = parseQueryList(historyAnswer.body, n.nodeId, HISTORY_PER_NODE, false);
  if (!history) return unreadable();

  return { status: status('on', null, active.truncated), lists: { nodeId: n.nodeId, active: active.queries, history: history.queries } };
}

function parseTokenId(a: NodeAnswer | NodeIssue | null): number | null {
  if (!a || failed(a) || a.status !== 200) return null;
  const id = obj(obj(a.body)?.token_info)?.id;
  return typeof id === 'number' && Number.isSafeInteger(id) ? id : null;
}

const viewCache = new SharedCache<Omit<QueriesView, 'servedAt'>>({ ttlMs: VIEW_TTL_MS, errorTtlMs: () => 0, maxEntries: 128 });

/**
 * Every node's running and recently finished queries. A node that does not
 * answer is left out of the lists, and the view says why. Shared for a moment
 * between viewers, so it does not take a request's abort signal: one viewer
 * leaving must not cache "unreachable" for the others.
 */
export function getQueriesView(t: ClusterTarget, opts: ClusterOptions): Promise<Omit<QueriesView, 'servedAt'>> {
  return viewCache.get(fingerprint(t, opts), async () => {
    const nodes = await pinnedNodes(t, opts);
    // The budget starts once the nodes are resolved, which has its own deadlines.
    const signal = AbortSignal.timeout(DEADLINE_MS);
    const anchor = nodes.find((n) => n.target)?.target ?? null;
    // Token ids are the same on every node: one node says which is Launchpad's.
    const [reads, verify] = await Promise.all([
      Promise.all(nodes.map((n) => readNode(n, t, opts, signal))),
      anchor ? read(anchor, '/api/v1/auth/verify', t, opts, signal, SMALL_MAX_BYTES) : null,
    ]);
    const merged = mergeNodeQueries(reads.flatMap((r) => (r.lists ? [r.lists] : [])));
    return {
      nodes: reads.map((r) => r.status),
      ...merged,
      launchpadTokenId: parseTokenId(verify),
      fetchedAt: Date.now(),
    };
  });
}

/** The pinned node a query is on; a ClusterError when it is not in the instance or cannot be reached. */
async function nodeFor(t: ClusterTarget, nodeId: string, opts: ClusterOptions): Promise<Target> {
  const n = (await pinnedNodes(t, opts)).find((x) => x.nodeId === nodeId);
  if (!n) throw new ClusterError('not_found', 'No such node in this instance');
  if (!n.target) throw new ClusterError(n.error ?? 'unreachable', describeClusterError(n.error ?? 'unreachable'));
  return n.target;
}

const queryPath = (queryId: string) => `/api/v1/queries/${encodeURIComponent(queryId)}`;

/** The query as the node holds it: null when it does not know it; throws when the node refuses. */
async function readQuery(target: Target, nodeId: string, queryId: string, t: ClusterTarget, opts: ClusterOptions, signal: AbortSignal): Promise<TrackedQuery | null> {
  const a = await pinnedGet(target, queryPath(queryId), t, opts, signal, DETAIL_MAX_BYTES);
  if (queryUnknown(a)) return null;
  if (a.status !== 200) throw refusalError(a);
  const q = parseTrackedQuery(obj(a.body)?.query, nodeId, DETAIL_SQL_MAX);
  if (!q || q.id !== queryId) throw new ClusterError('upstream_status', 'Arc returned an unreadable response');
  return q;
}

/** One query in full (the lists cut SQL short), from the node that runs or ran it. */
export async function getQueryDetail(t: ClusterTarget, nodeId: string, queryId: string, opts: ClusterOptions, abort?: AbortSignal): Promise<QueryDetail> {
  const target = await nodeFor(t, nodeId, opts);
  const deadline = AbortSignal.timeout(DEADLINE_MS);
  const q = await readQuery(target, nodeId, queryId, t, opts, abort ? AbortSignal.any([deadline, abort]) : deadline);
  if (!q) throw new ClusterError('not_found', 'That node no longer knows this query: it left the history, or the node restarted');
  return { query: q, source: target.display };
}

/**
 * Cancel a running query on the node that runs it, and say what happened.
 * The DELETE has its own deadline and is not tied to the admin's request:
 * once sent, an abort could not unsend it, only hide its outcome. Never
 * retried. Every cancel sent is recorded in the change log.
 */
export async function cancelQuery(t: ClusterTarget, nodeId: string, queryId: string, actorUserId: string, opts: ClusterOptions): Promise<CancelOutcome> {
  const target = await nodeFor(t, nodeId, opts);
  const signal = AbortSignal.timeout(CANCEL_DEADLINE_MS);
  const path = queryPath(queryId);
  let answer: NodeAnswer | null = null;
  try {
    answer = await pinnedDelete(target, path, t, opts, signal, SMALL_MAX_BYTES);
  } catch {
    answer = null; // no answer: settled below by reading the query
  }
  const record = (outcome?: 'ok' | 'error' | 'unknown') =>
    recordChange({ instanceId: t.id, actorUserId, method: 'DELETE', path: path.slice(1), status: answer?.status ?? null, outcome });
  viewCache.clear();
  // The read-back only adds detail to an answer already known.
  const after = () => readQuery(target, nodeId, queryId, t, opts, signal).catch(() => null);
  const outcome = (result: CancelOutcome['result'], query: TrackedQuery | null): CancelOutcome => ({ result, nodeId, queryId, query });

  if (answer && answer.status === 200) {
    record();
    return outcome('cancelled', await after());
  }
  // Arc: 409 "Query already <status>" when it is in the history, 404 "Query
  // not found" when it is in neither list.
  if (answer && answer.status === 409) {
    record();
    return outcome('already_finished', await after());
  }
  if (answer && queryUnknown(answer)) {
    record();
    return outcome('not_found', null);
  }
  if (answer && answer.status < 500) {
    record();
    throw refusalError(answer);
  }

  // 5xx or no answer: the cancel may still have happened. Look before
  // telling the admin it failed.
  const q = await after();
  if (q?.status === 'cancelled') {
    record('ok');
    return outcome('cancelled', q);
  }
  record('unknown');
  const now = !q ? 'it may not have been cancelled' : q.status === 'running' ? 'the query is still running' : `the query ended as ${STATUS_LABEL[q.status].toLowerCase()}`;
  throw answer
    ? new ClusterError('upstream_status', `Arc answered ${answer.status}; ${now}`)
    : new ClusterError('unreachable', `The node did not answer the cancel; ${now}`);
}

/** Test hook. */
export function resetQueryManagementCacheForTests(): void {
  viewCache.clear();
}
