/**
 * Arc query governance, read side (#10): every node's policies, defaults and
 * a token's usage.
 *
 * Arc stores governance per node and does not replicate it, so each node is
 * read separately, pinned and identity-checked like the Cluster view
 * (clusterNodes.pinnedNodes). A node that cannot be reached is reported as
 * such, never read through the load-balanced endpoint instead.
 *
 * Free of $env imports (the caller passes options) so it runs under vitest.
 */

import { SharedCache } from './sharedCache.js';
import { ClusterError, fingerprint, pinnedGet, pinnedNodes, type ClusterOptions, type ClusterTarget, type NodeAnswer, type PinnedNode } from './clusterNodes.js';
import { ADMIN_403, LICENSE_403 } from '../capabilities.js';
import { describeClusterError } from '../cluster.js';
import {
  mergePolicies,
  parseLimits,
  parsePolicy,
  parseUsage,
  type GovernanceView,
  type NodeGovernance,
  type NodeGovernanceState,
  type NodeIssue,
  type NodePolicies,
  type NodeUsage,
  type Policy,
} from '../governance.js';

/** For the node reads, counted once the nodes are resolved. */
const DEADLINE_MS = 10_000;
const MAX_BYTES = 4 * 1024 * 1024;
/** Policies per node read; more is not a governance setup Launchpad renders. */
const MAX_POLICIES = 10_000;
const MAX_TOKENS = 10_000;
const VIEW_TTL_MS = 5000;

const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const issue = (code: NodeIssue['code'], message?: string): NodeIssue => ({ code, message: message ?? describeClusterError(code) });

/** GET on a node, a transport failure folded into an issue. */
async function read(target: NonNullable<PinnedNode['target']>, path: string, t: ClusterTarget, opts: ClusterOptions, signal: AbortSignal): Promise<NodeAnswer | NodeIssue> {
  try {
    return await pinnedGet(target, path, t, opts, signal, MAX_BYTES);
  } catch (err) {
    return issue(err instanceof ClusterError ? err.code : 'internal');
  }
}
const failed = (a: NodeAnswer | NodeIssue): a is NodeIssue => 'code' in a;

/** What a governance answer other than 200 means. */
function refusal(a: NodeAnswer): { state: NodeGovernanceState; issue: NodeIssue } {
  // Arc's own 404 for a route that is not registered: governance is off.
  if (a.status === 404 && /cannot get/i.test(a.message ?? '')) return { state: 'off', issue: issue('governance_off', 'Governance is not enabled on this node') };
  if (a.status === 401) return { state: 'refused', issue: issue('token_rejected') };
  if (a.status === 403 && ADMIN_403.test(a.message ?? '')) return { state: 'refused', issue: issue('token_not_admin') };
  if (a.status === 403 && LICENSE_403.test(a.message ?? '')) return { state: 'refused', issue: issue('not_licensed', 'The license no longer includes query governance') };
  return { state: 'unreachable', issue: issue('upstream_status', `Arc answered ${a.status}`) };
}

type NodeRead = NodeGovernance & { policies: Policy[]; truncated: boolean };

/** One node's governance state: GET /policies, then its defaults. */
async function readNode(n: PinnedNode, t: ClusterTarget, opts: ClusterOptions, signal: AbortSignal): Promise<NodeRead> {
  const base = { nodeId: n.nodeId, source: n.target?.display ?? null, servesQueries: n.servesQueries, policies: [] as Policy[], defaults: null, defaultsKnown: false, truncated: false };
  if (!n.target) return { ...base, state: 'unreachable', issue: issue(n.error ?? 'unreachable') };
  const list = await read(n.target, '/api/v1/governance/policies', t, opts, signal);
  if (failed(list)) return { ...base, state: 'unreachable', issue: list };
  if (list.status !== 200) return { ...base, ...refusal(list) };

  const raw = obj(list.body)?.policies;
  const all = Array.isArray(raw) ? raw : [];
  const policies = all.slice(0, MAX_POLICIES).map(parsePolicy).filter((p): p is Policy => !!p).sort((a, b) => a.tokenId - b.tokenId);
  // A token id with no policy answers with this node's config defaults
  // (policy null when every default is 0).
  const defaults = await read(n.target, '/api/v1/governance/usage/0', t, opts, signal);
  const body = !failed(defaults) && defaults.status === 200 ? obj(defaults.body) : null;
  const effective = body?.policy;
  return {
    ...base,
    state: 'on',
    issue: null,
    policies,
    defaults: obj(effective) ? parseLimits(effective) : null,
    defaultsKnown: !!body && (effective === null || !!obj(effective)),
    truncated: all.length > MAX_POLICIES,
  };
}

function parseTokens(a: NodeAnswer | NodeIssue | null): GovernanceView['tokens'] | null {
  if (!a || failed(a) || a.status !== 200) return null;
  const list = obj(a.body)?.tokens;
  if (!Array.isArray(list)) return null;
  const out: GovernanceView['tokens'] = [];
  for (const v of list.slice(0, MAX_TOKENS)) {
    const o = obj(v);
    if (!o || typeof o.id !== 'number' || !Number.isSafeInteger(o.id) || o.id <= 0) continue;
    out.push({ id: o.id, name: typeof o.name === 'string' ? o.name.slice(0, 128) : `token ${o.id}` });
  }
  return out;
}

function parseTokenId(a: NodeAnswer | NodeIssue | null): number | null {
  if (!a || failed(a) || a.status !== 200) return null;
  const id = obj(obj(a.body)?.token_info)?.id;
  return typeof id === 'number' && Number.isSafeInteger(id) ? id : null;
}

const viewCache = new SharedCache<GovernanceView>({ ttlMs: VIEW_TTL_MS, errorTtlMs: () => 0, maxEntries: 128 });

/**
 * Every node's policies and defaults, merged per token. Shared for a few
 * seconds between viewers, so it does not take a request's abort signal: one
 * viewer leaving must not cache "unreachable" for the others.
 */
export function getGovernanceView(t: ClusterTarget, opts: ClusterOptions): Promise<GovernanceView> {
  return viewCache.get(fingerprint(t, opts), async () => {
    const nodes = await pinnedNodes(t, opts);
    // The budget starts once the nodes are resolved, which has its own deadlines.
    const signal = AbortSignal.timeout(DEADLINE_MS);
    const anchor = nodes.find((n) => n.target)?.target ?? null;
    // Token ids are the same on every node, so names and Launchpad's own id come from one.
    const [reads, tokens, verify] = await Promise.all([
      Promise.all(nodes.map((n) => readNode(n, t, opts, signal))),
      anchor ? read(anchor, '/api/v1/auth/tokens', t, opts, signal) : null,
      anchor ? read(anchor, '/api/v1/auth/verify', t, opts, signal) : null,
    ]);
    const tokenList = parseTokens(tokens);
    return {
      nodes: reads.map(({ policies: _p, truncated: _t, ...n }) => n),
      policies: mergePolicies(reads satisfies NodePolicies[]),
      tokens: tokenList ?? [],
      tokensLoaded: tokenList !== null,
      launchpadTokenId: parseTokenId(verify),
      truncated: reads.some((n) => n.truncated),
      loadedAt: Date.now(),
    };
  });
}

/** A token's usage on every node, each against that node's own effective limits. */
export async function getTokenUsage(t: ClusterTarget, tokenId: number, opts: ClusterOptions, abort?: AbortSignal): Promise<NodeUsage[]> {
  const nodes = await pinnedNodes(t, opts);
  const deadline = AbortSignal.timeout(DEADLINE_MS);
  const signal = abort ? AbortSignal.any([deadline, abort]) : deadline;
  return Promise.all(nodes.map(async (n): Promise<NodeUsage> => {
    const base = { nodeId: n.nodeId, source: n.target?.display ?? null };
    const unavailable = (i: NodeIssue): NodeUsage => ({ ...base, state: 'unavailable', issue: i, usage: null, effective: null });
    if (!n.target) return unavailable(issue(n.error ?? 'unreachable'));
    const a = await read(n.target, `/api/v1/governance/usage/${tokenId}`, t, opts, signal);
    if (failed(a)) return unavailable(a);
    if (a.status !== 200) return unavailable(refusal(a).issue);
    const body = obj(a.body);
    const usage = parseUsage(body?.usage);
    if (!body || !usage) return unavailable(issue('upstream_status', 'Arc returned an unreadable response'));
    const policy = obj(body.policy);
    // Arc builds a policy from config defaults with id 0 when the token has none.
    const from = !policy ? 'none' : policy.id === 0 ? 'defaults' : 'policy';
    return { ...base, state: 'on', issue: null, usage, effective: { limits: parseLimits(policy), from } };
  }));
}

/** Test hook. */
export function resetGovernanceCacheForTests(): void {
  viewCache.clear();
}
