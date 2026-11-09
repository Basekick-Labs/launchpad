/**
 * Arc query governance (#10): per-token query limits and their usage.
 *
 * Arc keeps one policy per token (internal/governance/manager.go) with six
 * limits, where 0 means unlimited. Policies and usage counters are stored per
 * node and are not replicated in a cluster, so Launchpad reads and writes
 * every node and reports where they differ. Pure and isomorphic; the I/O is
 * src/lib/server/governanceAdmin.ts.
 */

import type { ClusterErrorCode } from './cluster';

export const LIMIT_FIELDS = [
  'rate_limit_per_minute',
  'rate_limit_per_hour',
  'max_queries_per_hour',
  'max_queries_per_day',
  'max_rows_per_query',
  'max_scan_duration_sec',
] as const;
export type LimitField = (typeof LIMIT_FIELDS)[number];
export type Limits = Record<LimitField, number>;

/** What each limit does, as Arc enforces it. */
export const LIMIT_INFO: Record<LimitField, { label: string; unit: string; help: string }> = {
  rate_limit_per_minute: { label: 'Rate per minute', unit: 'queries', help: 'Queries in any rolling 60 seconds. Over it, Arc answers 429 with Retry-After.' },
  rate_limit_per_hour: { label: 'Rate per hour', unit: 'queries', help: 'Queries in any rolling 60 minutes.' },
  max_queries_per_hour: { label: 'Hourly quota', unit: 'queries', help: 'Queries per clock hour; resets at the top of the hour.' },
  max_queries_per_day: { label: 'Daily quota', unit: 'queries', help: 'Queries per day; resets at midnight UTC.' },
  max_rows_per_query: { label: 'Rows per query', unit: 'rows', help: 'Results beyond this are cut off (marked rows_capped), not refused.' },
  max_scan_duration_sec: { label: 'Query time limit', unit: 'seconds', help: "Replaces Arc's global query timeout for this token; it can be longer than the global one." },
};

export const UNLIMITED: Limits = Object.fromEntries(LIMIT_FIELDS.map((f) => [f, 0])) as Limits;

export interface Policy extends Limits {
  tokenId: number;
}

export interface Usage {
  queriesThisHour: number;
  queriesThisDay: number;
  hourResetAt: string | null;
  dayResetAt: string | null;
  remainingPerMinute: number;
  remainingPerHour: number;
}

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
const nonNegInt = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0);
const time = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null);

export function parseLimits(v: unknown): Limits {
  const o = obj(v) ?? {};
  return Object.fromEntries(LIMIT_FIELDS.map((f) => [f, nonNegInt(o[f])])) as Limits;
}

/** A policy from Arc, or null when it is not one. */
export function parsePolicy(v: unknown): Policy | null {
  const o = obj(v);
  const tokenId = o?.token_id;
  if (!o || typeof tokenId !== 'number' || !Number.isSafeInteger(tokenId) || tokenId <= 0) return null;
  return { tokenId, ...parseLimits(o) };
}

export function parseUsage(v: unknown): Usage | null {
  const o = obj(v);
  if (!o) return null;
  return {
    queriesThisHour: nonNegInt(o.queries_this_hour),
    queriesThisDay: nonNegInt(o.queries_this_day),
    hourResetAt: time(o.hour_reset_at),
    dayResetAt: time(o.day_reset_at),
    remainingPerMinute: nonNegInt(o.rate_limit_remaining_per_minute),
    remainingPerHour: nonNegInt(o.rate_limit_remaining_per_hour),
  };
}

export function limitsEqual(a: Limits, b: Limits): boolean {
  return LIMIT_FIELDS.every((f) => a[f] === b[f]);
}

export function isUnlimited(l: Limits): boolean {
  return LIMIT_FIELDS.every((f) => l[f] === 0);
}

// ---------------------------------------------------------------------------
// Several nodes

/** What Launchpad found on one node. */
export type NodeGovernanceState =
  /** Governance answers. */
  | 'on'
  /** Governance is not enabled (or not licensed at boot) on this node. */
  | 'off'
  /** Arc refused: the license lapsed, or the stored token is not admin. */
  | 'refused'
  /** Launchpad could not reach or verify this node, or Arc failed. */
  | 'unreachable';

/** Why a node is not 'on': a code for logic, a sentence (written by Launchpad) to show. */
export interface NodeIssue {
  code: ClusterErrorCode | 'governance_off' | 'not_licensed';
  message: string;
}

export interface NodeGovernance {
  nodeId: string;
  /** host:port the data came from. */
  source: string | null;
  /** Compactors forward queries before governance runs: their limits never apply. */
  servesQueries: boolean;
  state: NodeGovernanceState;
  issue: NodeIssue | null;
  /** Limits a token without a policy gets on this node (Arc config defaults); null when none or not known. */
  defaults: Limits | null;
  /** False when the defaults could not be read: then `defaults` null means unknown, not "none". */
  defaultsKnown: boolean;
}

/** One node's policies, as read. Server-side only; the view carries the merge. */
export interface NodePolicies {
  nodeId: string;
  state: NodeGovernanceState;
  servesQueries: boolean;
  policies: Policy[];
}

export interface TokenPolicyView {
  tokenId: number;
  /** Each 'on' node's policy for this token; null where it has none. */
  byNode: Record<string, Limits | null>;
  /** Per limit, the value every query-serving 'on' node holds; null where they differ. */
  shared: Record<LimitField, number | null>;
  /** Every query-serving node is 'on' and holds the same limits. */
  inSync: boolean;
  /** Query-serving nodes whose limits are not known (off, refused or unreachable). */
  unknownOn: string[];
}

/**
 * Per token, what every node that answered holds. No majority vote: nodes
 * either all agree or the view shows each node's values. Compactors are left
 * out of the comparison (they never apply limits); a query-serving node that
 * did not answer keeps the token out of sync, as its limits are unknown.
 */
export function mergePolicies(nodes: NodePolicies[]): TokenPolicyView[] {
  const on = nodes.filter((n) => n.state === 'on');
  const unknownOn = nodes.filter((n) => n.servesQueries && n.state !== 'on').map((n) => n.nodeId);
  const index = on.map((n) => ({ node: n, byToken: new Map(n.policies.map(({ tokenId, ...l }) => [tokenId, l as Limits])) }));
  const tokenIds = new Set<number>();
  for (const { byToken } of index) for (const id of byToken.keys()) tokenIds.add(id);
  return [...tokenIds].sort((a, b) => a - b).map((tokenId) => {
    const byNode: Record<string, Limits | null> = {};
    const serving: Array<Limits | null> = [];
    for (const { node, byToken } of index) {
      const l = byToken.get(tokenId) ?? null;
      byNode[node.nodeId] = l;
      if (node.servesQueries) serving.push(l);
    }
    const shared = Object.fromEntries(LIMIT_FIELDS.map((f) => {
      const first = serving[0]?.[f];
      return [f, serving.length > 0 && first !== undefined && serving.every((l) => l?.[f] === first) ? first : null];
    })) as Record<LimitField, number | null>;
    const inSync = unknownOn.length === 0 && serving.length > 0 && serving.every((l) => l !== null) && LIMIT_FIELDS.every((f) => shared[f] !== null);
    return { tokenId, byNode, shared, inSync, unknownOn };
  });
}

// ---------------------------------------------------------------------------
// Usage next to limits

export type UsageState = 'unlimited' | 'ok' | 'near' | 'exhausted';

export interface UsageLine {
  field: LimitField;
  limit: number;
  /** Queries counted against it, when Arc reports a count; null otherwise. */
  used: number | null;
  state: UsageState;
}

/**
 * The counted limits of one node, configured value next to current use,
 * against that node's own effective limits. Arc reports `remaining` 0 both
 * for an unset limit and an exhausted one, so the configured limit decides
 * which it is. Rows and duration are per query and have no running count.
 */
export function usageLines(limits: Limits | null, usage: Usage): UsageLine[] {
  const l = limits ?? UNLIMITED;
  const line = (field: LimitField, used: number | null): UsageLine => {
    const limit = l[field];
    if (limit === 0) return { field, limit, used: null, state: 'unlimited' };
    const u = used ?? 0;
    return { field, limit, used, state: u >= limit ? 'exhausted' : u >= limit * 0.8 ? 'near' : 'ok' };
  };
  // Arc only counts what has a limit: a rate limiter or quota counter exists
  // only once that field is set, so an unset limit has no meaningful count.
  return [
    line('rate_limit_per_minute', Math.max(0, l.rate_limit_per_minute - usage.remainingPerMinute)),
    line('rate_limit_per_hour', Math.max(0, l.rate_limit_per_hour - usage.remainingPerHour)),
    line('max_queries_per_hour', usage.queriesThisHour),
    line('max_queries_per_day', usage.queriesThisDay),
  ];
}

/** "1,000 queries", "unlimited". */
export function limitText(field: LimitField, value: number): string {
  return value === 0 ? 'unlimited' : `${value.toLocaleString('en-US')} ${LIMIT_INFO[field].unit}`;
}

// ---------------------------------------------------------------------------
// API contract between Launchpad's governance routes and the Access tab

export interface GovernanceView {
  nodes: NodeGovernance[];
  policies: TokenPolicyView[];
  tokens: Array<{ id: number; name: string }>;
  /** Arc's token list was read; otherwise a policy's token cannot be called deleted. */
  tokensLoaded: boolean;
  /** The token Launchpad itself uses for this instance (console, alerts…), when Arc says. */
  launchpadTokenId: number | null;
  truncated: boolean;
  loadedAt: number;
}

export interface NodeUsage {
  nodeId: string;
  source: string | null;
  state: 'on' | 'unavailable';
  issue: NodeIssue | null;
  usage: Usage | null;
  /** The limits this node applies to the token, and where they come from. */
  effective: { limits: Limits; from: 'policy' | 'defaults' | 'none' } | null;
}
