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

import { safeRequest } from './ssrf.js';
import { parseJson } from './util.js';
import { SharedCache } from './sharedCache.js';
import { connectionFingerprint } from './util.js';
import { pinnedNodes, type ClusterOptions, type ClusterTarget, type PinnedNode } from './clusterNodes.js';
import { ADMIN_403, LICENSE_403 } from '../capabilities.js';
import {
  mergePolicies,
  parseLimits,
  parsePolicy,
  parseUsage,
  type GovernanceView,
  type NodeGovernance,
  type NodeUsage,
  type Policy,
} from '../governance.js';

const IDLE_TIMEOUT_MS = 5000;
const DEADLINE_MS = 10_000;
const MAX_BYTES = 4 * 1024 * 1024;
/** Policies per node read; more is not a governance setup Launchpad renders. */
const MAX_POLICIES = 10_000;
const VIEW_TTL_MS = 5000;

interface Answer {
  status: number;
  body: unknown;
  message: string | null;
}

async function get(target: { origin: string; ip: string }, path: string, token: string | null, opts: ClusterOptions, signal: AbortSignal): Promise<Answer | null> {
  try {
    const res = await safeRequest(`${target.origin}${path}`, {
      allowHttp: true,
      allowPrivate: opts.allowPrivate,
      pinTo: target.ip,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      timeoutMs: IDLE_TIMEOUT_MS,
      maxResponseBytes: MAX_BYTES,
      signal,
    });
    const body = parseJson(res.body.toString('utf8'));
    const err = (body as { error?: unknown } | null)?.error;
    return { status: res.status, body, message: typeof err === 'string' ? err.slice(0, 300) : null };
  } catch {
    return null;
  }
}

/** Read one node's governance state from GET /policies (always 200 when governance is on). */
async function readNode(n: PinnedNode, t: ClusterTarget, opts: ClusterOptions, signal: AbortSignal): Promise<NodeGovernance & { truncated: boolean }> {
  const base = { nodeId: n.nodeId, source: n.target?.display ?? null, servesQueries: n.servesQueries, policies: [] as Policy[], defaults: null, truncated: false };
  if (!n.target) return { ...base, state: 'unreachable', reason: n.error };
  const [list, defaults] = await Promise.all([
    get(n.target, '/api/v1/governance/policies', t.admin_token, opts, signal),
    // A token id with no policy answers with this node's config defaults.
    get(n.target, '/api/v1/governance/usage/0', t.admin_token, opts, signal),
  ]);
  if (!list) return { ...base, state: 'unreachable', reason: 'unreachable' };
  if (list.status === 404 && /cannot get/i.test(list.message ?? '')) return { ...base, state: 'off', reason: 'Governance is not enabled on this node' };
  if (list.status === 401) return { ...base, state: 'refused', reason: 'Arc rejected the stored token' };
  if (list.status === 403 && ADMIN_403.test(list.message ?? '')) return { ...base, state: 'refused', reason: 'The stored token is not an admin token' };
  if (list.status === 403 && LICENSE_403.test(list.message ?? '')) return { ...base, state: 'refused', reason: 'The license no longer includes query governance' };
  if (list.status !== 200) return { ...base, state: 'unreachable', reason: `Arc answered ${list.status}` };

  const raw = Array.isArray((list.body as { policies?: unknown })?.policies) ? (list.body as { policies: unknown[] }).policies : [];
  const policies = raw.slice(0, MAX_POLICIES).map(parsePolicy).filter((p): p is Policy => !!p).sort((a, b) => a.tokenId - b.tokenId);
  const effective = defaults?.status === 200 ? (defaults.body as { policy?: unknown })?.policy : null;
  return {
    ...base,
    state: 'on',
    reason: null,
    policies,
    defaults: effective ? parseLimits(effective) : null,
    truncated: raw.length > MAX_POLICIES,
  };
}

const viewCache = new SharedCache<GovernanceView>({ ttlMs: VIEW_TTL_MS, errorTtlMs: () => 0, maxEntries: 128 });

/** Every node's policies and defaults, merged per token. Shared for a few seconds. */
export function getGovernanceView(t: ClusterTarget, opts: ClusterOptions): Promise<GovernanceView> {
  const key = connectionFingerprint(t.id, t.endpoint_url, t.admin_token, String(opts.allowPrivate), opts.nodeCidrs.length ? 'scoped' : '');
  return viewCache.get(key, async () => {
    const signal = AbortSignal.timeout(DEADLINE_MS);
    const nodes = await pinnedNodes(t, opts);
    const read = await Promise.all(nodes.map((n) => readNode(n, t, opts, signal)));
    const anchor = nodes.find((n) => n.target)?.target ?? null;
    const [tokens, verify] = anchor
      ? await Promise.all([
          get(anchor, '/api/v1/auth/tokens', t.admin_token, opts, signal),
          get(anchor, '/api/v1/auth/verify', t.admin_token, opts, signal),
        ])
      : [null, null];
    const tokenList = Array.isArray((tokens?.body as { tokens?: unknown })?.tokens) ? (tokens!.body as { tokens: unknown[] }).tokens : [];
    const launchpadTokenId = (verify?.body as { token_info?: { id?: unknown } } | null)?.token_info?.id;
    return {
      nodes: read.map(({ truncated: _t, ...n }) => n),
      policies: mergePolicies(read),
      tokens: tokenList
        .slice(0, MAX_POLICIES)
        .map((v) => v as { id?: unknown; name?: unknown })
        .filter((v) => typeof v.id === 'number' && Number.isSafeInteger(v.id) && v.id > 0)
        .map((v) => ({ id: v.id as number, name: typeof v.name === 'string' ? v.name.slice(0, 128) : `token ${v.id}` })),
      launchpadTokenId: typeof launchpadTokenId === 'number' && Number.isSafeInteger(launchpadTokenId) ? launchpadTokenId : null,
      truncated: read.some((n) => n.truncated),
      loadedAt: Date.now(),
    };
  });
}

/** A token's usage on every node, each against that node's own effective limits. */
export async function getTokenUsage(t: ClusterTarget, tokenId: number, opts: ClusterOptions): Promise<NodeUsage[]> {
  const signal = AbortSignal.timeout(DEADLINE_MS);
  const nodes = await pinnedNodes(t, opts);
  return Promise.all(nodes.map(async (n): Promise<NodeUsage> => {
    const base = { nodeId: n.nodeId, source: n.target?.display ?? null };
    if (!n.target) return { ...base, state: 'unavailable', reason: n.error, usage: null, effective: null };
    const a = await get(n.target, `/api/v1/governance/usage/${tokenId}`, t.admin_token, opts, signal);
    if (!a || a.status !== 200) {
      return { ...base, state: 'unavailable', reason: a ? (a.status === 404 ? 'Governance is not enabled on this node' : `Arc answered ${a.status}`) : 'unreachable', usage: null, effective: null };
    }
    const body = a.body as { usage?: unknown; policy?: { id?: unknown } | null };
    const policy = body.policy ?? null;
    // Arc builds a policy from config defaults with id 0 when the token has none.
    const from = !policy ? 'none' : policy.id === 0 ? 'defaults' : 'policy';
    return { ...base, state: 'on', reason: null, usage: parseUsage(body.usage), effective: { limits: parseLimits(policy), from } };
  }));
}

/** Test hook. */
export function resetGovernanceCacheForTests(): void {
  viewCache.clear();
}
