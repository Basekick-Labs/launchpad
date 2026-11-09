/**
 * Arc RBAC administration for the Tokens & access tab (#8): load the whole
 * tree in one server-side pass, and apply one change at a time after checking
 * that what the admin previewed is still what Arc holds.
 *
 * Every request in one operation goes to the same resolved IP of the instance
 * endpoint. In a cluster each node answers reads from its own copy; when the
 * endpoint is a single node that makes reads after a write consistent. When
 * it is a load balancer, one IP can reach several nodes, so after a write the
 * tree is re-read (briefly) until the change shows up.
 *
 * Every change attempt is recorded in the instance change log with the
 * Launchpad user and its outcome.
 *
 * Free of $env imports (the caller passes allowPrivate) so it runs under
 * vitest against a fake Arc.
 */

import { assertSafeResolvedUrl, safeRequest } from './ssrf.js';
import { connectionFingerprint, parseJson } from './util.js';
import { recordChange } from './instanceChangeLog.js';
import { SharedCache } from './sharedCache.js';
import { ADMIN_403, LICENSE_403 } from '../capabilities.js';
import {
  applyChange,
  asList,
  parseMeasurementPermission,
  parseOrg,
  parseRole,
  parseTeam,
  parseToken,
  previewFingerprint,
  targetExists,
  UNLICENSED_CHANGES,
  validateChange,
  type RbacChange,
  type RbacMeasurementPermission,
  type RbacOrg,
  type RbacRole,
  type RbacSnapshot,
  type RbacTeam,
  type RbacToken,
} from '../rbac.js';

export interface RbacTarget {
  id: string;
  endpoint_url: string | null;
  admin_token: string | null;
}

export interface RbacOptions {
  allowPrivate: boolean;
  /** The caller's request; aborting it stops the loads it started. */
  signal?: AbortSignal;
}

export type RbacErrorCode =
  | 'unreachable'
  | 'token_rejected'
  | 'token_not_admin'
  | 'auth_off'
  | 'unlicensed'
  | 'invalid'
  | 'stale'
  | 'truncated'
  | 'not_found'
  | 'arc_error';

export class RbacError extends Error {
  constructor(
    public readonly code: RbacErrorCode,
    message: string,
    public readonly fields?: Record<string, string>,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'RbacError';
  }
}

const IDLE_TIMEOUT_MS = 5000;
const SNAPSHOT_DEADLINE_MS = 20_000;
const WRITE_DEADLINE_MS = 10_000;
const PROBE_TIMEOUT_MS = 2000;
const CONCURRENCY = 6;
/** Items loaded across the whole tree (orgs, teams, roles, measurement permissions, tokens). */
const MAX_ENTITIES = 10_000;
/** Bytes read from Arc for one snapshot, whatever the item count. */
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
/** After a write, re-read this many times (spaced) until the change is visible. */
const VISIBILITY_ATTEMPTS = 3;
const VISIBILITY_DELAY_MS = 300;
const SNAPSHOT_TTL_MS = 5000;

interface Pinned {
  base: string;
  ip: string;
  token: string;
  opts: RbacOptions;
}

/** Concurrent page loads of the same instance share one snapshot for a few seconds. */
const snapshotCache = new SharedCache<RbacSnapshot>({ ttlMs: SNAPSHOT_TTL_MS, errorTtlMs: () => 0, maxEntries: 128 });

function cacheKey(t: RbacTarget, opts: RbacOptions): string {
  return connectionFingerprint(t.id, t.endpoint_url, t.admin_token, String(opts.allowPrivate));
}

/** Resolve the endpoint and pin the first of its IPs that answers. */
async function pin(t: RbacTarget, opts: RbacOptions): Promise<Pinned> {
  const base = (t.endpoint_url ?? '').replace(/\/+$/, '');
  if (!base || !t.admin_token) throw new RbacError('unreachable', 'This connection has no endpoint or token');
  let ips: string[];
  try {
    ips = (await assertSafeResolvedUrl(base, { allowHttp: true, allowPrivate: opts.allowPrivate })).ips;
  } catch (err) {
    throw new RbacError('unreachable', 'The Arc endpoint is not reachable or not allowed', undefined, { cause: err });
  }
  for (const ip of ips) {
    if (ips.length === 1) return { base, ip, token: t.admin_token, opts };
    try {
      // /health is public in Arc: a cheap reachability check per address.
      await safeRequest(`${base}/health`, { allowHttp: true, allowPrivate: opts.allowPrivate, pinTo: ip, timeoutMs: PROBE_TIMEOUT_MS, maxResponseBytes: 64 * 1024, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      return { base, ip, token: t.admin_token, opts };
    } catch {
      /* try the next address */
    }
  }
  throw new RbacError('unreachable', 'Arc did not answer on any of its addresses');
}

interface ArcAnswer {
  status: number;
  body: unknown;
  /** Arc's own error message, bounded. */
  message: string | null;
  bytes: number;
}

async function call(p: Pinned, signal: AbortSignal, method: string, path: string, body?: unknown): Promise<ArcAnswer> {
  const payload = body === undefined ? null : JSON.stringify(body);
  let res;
  try {
    res = await safeRequest(`${p.base}${path}`, {
      allowHttp: true,
      allowPrivate: p.opts.allowPrivate,
      method,
      pinTo: p.ip,
      signal,
      timeoutMs: IDLE_TIMEOUT_MS,
      maxResponseBytes: MAX_RESPONSE_BYTES,
      headers: {
        authorization: `Bearer ${p.token}`,
        ...(payload !== null && { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
      },
      body: payload,
    });
  } catch (err) {
    throw new RbacError('unreachable', 'Arc did not answer', undefined, { cause: err });
  }
  const parsed = parseJson(res.body.toString('utf8'));
  const err = (parsed as { error?: unknown } | null)?.error;
  return { status: res.status, body: parsed, message: typeof err === 'string' ? err.slice(0, 300) : null, bytes: res.body.length };
}

/** Map an Arc refusal on the RBAC routes to a code the UI can explain. */
function refusal(a: ArcAnswer): RbacError | null {
  if (a.status === 401) return new RbacError('token_rejected', 'Arc rejected the stored token');
  if (a.status === 403 && ADMIN_403.test(a.message ?? '')) return new RbacError('token_not_admin', 'The stored token needs admin permission to manage access');
  if (a.status === 403 && LICENSE_403.test(a.message ?? '')) return new RbacError('unlicensed', 'The license does not include RBAC');
  if (a.status === 404 && /cannot (get|post|patch|delete)/i.test(a.message ?? '')) {
    return new RbacError('auth_off', 'Arc runs without authentication, so it has no access control');
  }
  return null;
}

/** Arc's own words, marked as Arc's so they are not read as Launchpad's. */
const fromArc = (a: ArcAnswer) => (a.message ? `Arc: ${a.message}` : `Arc answered ${a.status}`);

/**
 * A read that must succeed: 404 means "gone meanwhile" (null); anything else
 * that is not 200 fails the whole load rather than leaving a silent hole.
 */
async function read(p: Pinned, signal: AbortSignal, path: string, budget: Budget): Promise<unknown | null> {
  const a = await call(p, signal, 'GET', path);
  budget.bytes(a.bytes);
  if (a.status === 200) return a.body;
  if (a.status === 404 && !refusal(a)) return null;
  throw refusal(a) ?? new RbacError('arc_error', fromArc(a));
}

class Budget {
  private total = 0;
  bytes(n: number): void {
    this.total += n;
    if (this.total > MAX_TOTAL_BYTES) throw new RbacError('truncated', 'This instance has more access-control data than Launchpad loads');
  }
}

/**
 * Run `fn` over items with bounded concurrency. The first failure stops the
 * other workers from starting more requests.
 */
async function each<T>(items: T[], signal: AbortSignal, fn: (item: T, signal: AbortSignal) => Promise<void>): Promise<void> {
  const stop = new AbortController();
  const s = AbortSignal.any([signal, stop.signal]);
  let next = 0;
  const worker = async () => {
    while (next < items.length && !s.aborted) {
      try {
        await fn(items[next++], s);
      } catch (err) {
        stop.abort(err);
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  if (signal.aborted) throw new RbacError('unreachable', 'The load was cancelled or took too long');
}

const byId = <T extends { id: number }>(a: T, b: T) => a.id - b.id;

/** Children of each parent, loaded concurrently and returned in id order, so truncation is stable. */
async function children<P extends { id: number }, C extends { id: number }>(
  p: Pinned,
  signal: AbortSignal,
  budget: Budget,
  parents: P[],
  path: (parent: P) => string,
  pick: (body: unknown) => unknown,
  parse: (v: unknown) => C | null,
): Promise<C[]> {
  const out: C[] = [];
  await each(parents, signal, async (parent, s) => {
    const body = await read(p, s, path(parent), budget);
    if (body === null) return;
    for (const v of asList(pick(body))) {
      const c = parse(v);
      if (c) out.push(c);
    }
  });
  return out.sort(byId);
}

async function loadSnapshot(p: Pinned, signal: AbortSignal): Promise<RbacSnapshot> {
  const budget = new Budget();
  let remaining = MAX_ENTITIES;
  let truncated = false;
  const take = <T>(items: T[]): T[] => {
    if (items.length > remaining) {
      truncated = true;
      items = items.slice(0, Math.max(0, remaining));
    }
    remaining -= items.length;
    return items;
  };

  // Tokens and their memberships do not need the RBAC license; the tree does.
  const [orgsAnswer, tokensBody] = await Promise.all([
    call(p, signal, 'GET', '/api/v1/rbac/organizations'),
    read(p, signal, '/api/v1/auth/tokens', budget),
  ]);
  budget.bytes(orgsAnswer.bytes);
  const refused = refusal(orgsAnswer);
  const licensed = refused?.code !== 'unlicensed';
  if (refused && licensed) throw refused;
  if (licensed && orgsAnswer.status !== 200) throw new RbacError('arc_error', fromArc(orgsAnswer));

  const now = Date.now();
  const tokens = take(asList((tokensBody as { tokens?: unknown } | null)?.tokens).map((v) => parseToken(v, now)).filter((t): t is RbacToken => !!t).sort(byId));

  let orgs: RbacOrg[] = [];
  let teams: RbacTeam[] = [];
  let roles: RbacRole[] = [];
  let measurementPermissions: RbacMeasurementPermission[] = [];
  if (licensed) {
    // List endpoints, not the GET-by-id ones: Arc's GET of an org or role
    // answers 200 without its children when loading them fails, which would
    // read as "none" (a measurement-limited role would look database-wide).
    orgs = take(asList((orgsAnswer.body as { organizations?: unknown } | null)?.organizations).map(parseOrg).filter((o): o is RbacOrg => !!o).sort(byId));
    teams = take(await children(p, signal, budget, orgs, (o) => `/api/v1/rbac/organizations/${o.id}/teams`, (b) => (b as { teams?: unknown })?.teams, parseTeam));
    roles = take(await children(p, signal, budget, teams, (t) => `/api/v1/rbac/teams/${t.id}/roles`, (b) => (b as { roles?: unknown })?.roles, parseRole));
    measurementPermissions = take(await children(p, signal, budget, roles, (r) => `/api/v1/rbac/roles/${r.id}/measurements`, (b) => (b as { measurement_permissions?: unknown })?.measurement_permissions, parseMeasurementPermission));
  }

  // Memberships per token (Arc has no team → tokens listing).
  const memberships: Record<number, number[]> = {};
  const teamNames: Record<number, string> = {};
  await each(tokens, signal, async (tok, s) => {
    const body = await read(p, s, `/api/v1/auth/tokens/${tok.id}/teams`, budget);
    if (body === null) return;
    const ts = asList((body as { teams?: unknown })?.teams).map(parseTeam).filter((t): t is RbacTeam => !!t);
    if (ts.length) memberships[tok.id] = ts.map((t) => t.id).sort((x, y) => x - y);
    for (const t of ts) teamNames[t.id] = t.name;
  });

  return { licensed, orgs, teams, roles, measurementPermissions, tokens, memberships, teamNames, truncated, loadedAt: Date.now() };
}

/** The whole RBAC tree and every token's memberships, from one node. Shared for a few seconds. */
export function getRbacSnapshot(t: RbacTarget, opts: RbacOptions): Promise<RbacSnapshot> {
  return snapshotCache.get(cacheKey(t, opts), async () => {
    const p = await pin(t, opts);
    // Not tied to the caller's signal: the load is shared between callers.
    return loadSnapshot(p, AbortSignal.timeout(SNAPSHOT_DEADLINE_MS));
  });
}

// ---------------------------------------------------------------------------
// Changes

interface ArcRequest {
  method: 'POST' | 'PATCH' | 'DELETE';
  path: string;
  body?: Record<string, unknown>;
}

function requestFor(c: RbacChange): ArcRequest {
  const r = '/api/v1/rbac';
  const defined = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  switch (c.kind) {
    case 'org.create': return { method: 'POST', path: `${r}/organizations`, body: { name: c.name, description: c.description } };
    case 'org.update': return { method: 'PATCH', path: `${r}/organizations/${c.orgId}`, body: defined({ name: c.name, description: c.description }) };
    case 'org.delete': return { method: 'DELETE', path: `${r}/organizations/${c.orgId}` };
    case 'team.create': return { method: 'POST', path: `${r}/organizations/${c.orgId}/teams`, body: { name: c.name, description: c.description } };
    case 'team.update': return { method: 'PATCH', path: `${r}/teams/${c.teamId}`, body: defined({ name: c.name, description: c.description, enabled: c.enabled }) };
    case 'team.delete': return { method: 'DELETE', path: `${r}/teams/${c.teamId}` };
    case 'role.create': return { method: 'POST', path: `${r}/teams/${c.teamId}/roles`, body: { database_pattern: c.databasePattern, permissions: c.permissions } };
    case 'role.update': return { method: 'PATCH', path: `${r}/roles/${c.roleId}`, body: defined({ database_pattern: c.databasePattern, permissions: c.permissions }) };
    case 'role.delete': return { method: 'DELETE', path: `${r}/roles/${c.roleId}` };
    case 'mp.create': return { method: 'POST', path: `${r}/roles/${c.roleId}/measurements`, body: { measurement_pattern: c.measurementPattern, permissions: c.permissions } };
    case 'mp.delete': return { method: 'DELETE', path: `${r}/measurement-permissions/${c.mpId}` };
    case 'membership.add': return { method: 'POST', path: `/api/v1/auth/tokens/${c.tokenId}/teams`, body: { team_id: c.teamId } };
    case 'membership.remove': return { method: 'DELETE', path: `/api/v1/auth/tokens/${c.tokenId}/teams/${c.teamId}` };
  }
}

export type ChangeResult =
  /** Arc applied it and the tree shows it. */
  | 'applied'
  /** Arc answered with an error or not at all, but the tree shows the change. */
  | 'applied_after_error'
  /** Arc answered with an error and the tree does not show the change (yet). */
  | 'not_visible'
  /** It cannot be told whether Arc applied it. */
  | 'unknown';

export interface ChangeOutcome {
  result: ChangeResult;
  /** The tree after the change, from the same address; null when it could not be read (reload). */
  snapshot: RbacSnapshot | null;
}

/** Whether `after` shows `c` as applied, compared with `before`. */
export function changeVisible(before: RbacSnapshot, after: RbacSnapshot, c: RbacChange): boolean {
  switch (c.kind) {
    case 'org.create': return after.orgs.filter((o) => o.name === c.name).length > before.orgs.filter((o) => o.name === c.name).length;
    case 'team.create': return after.teams.filter((t) => t.orgId === c.orgId && t.name === c.name).length > before.teams.filter((t) => t.orgId === c.orgId && t.name === c.name).length;
    case 'role.create': return after.roles.filter((r) => r.teamId === c.teamId && r.databasePattern === c.databasePattern).length > before.roles.filter((r) => r.teamId === c.teamId && r.databasePattern === c.databasePattern).length;
    case 'mp.create': return after.measurementPermissions.filter((m) => m.roleId === c.roleId && m.measurementPattern === c.measurementPattern).length > before.measurementPermissions.filter((m) => m.roleId === c.roleId && m.measurementPattern === c.measurementPattern).length;
    case 'membership.add': return (after.memberships[c.tokenId] ?? []).includes(c.teamId);
    case 'membership.remove': return !(after.memberships[c.tokenId] ?? []).includes(c.teamId);
    case 'org.delete': return !after.orgs.some((o) => o.id === c.orgId);
    case 'team.delete': return !after.teams.some((t) => t.id === c.teamId);
    case 'role.delete': return !after.roles.some((r) => r.id === c.roleId);
    case 'mp.delete': return !after.measurementPermissions.some((m) => m.id === c.mpId);
    case 'org.update': {
      const o = after.orgs.find((x) => x.id === c.orgId);
      return !!o && (c.name === undefined || o.name === c.name) && (c.description === undefined || o.description === c.description);
    }
    case 'team.update': {
      const t = after.teams.find((x) => x.id === c.teamId);
      return !!t && (c.name === undefined || t.name === c.name) && (c.description === undefined || t.description === c.description) && (c.enabled === undefined || t.enabled === c.enabled);
    }
    case 'role.update': {
      const r = after.roles.find((x) => x.id === c.roleId);
      const same = (a: string[], b: string[]) => [...a].sort().join() === [...b].sort().join();
      return !!r && (c.databasePattern === undefined || r.databasePattern === c.databasePattern) && (c.permissions === undefined || same(r.permissions, c.permissions));
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Re-read until the change is visible (a load balancer can send the read to another node). */
async function readBack(p: Pinned, before: RbacSnapshot, c: RbacChange): Promise<{ after: RbacSnapshot | null; visible: boolean }> {
  let after: RbacSnapshot | null = null;
  for (let attempt = 0; attempt < VISIBILITY_ATTEMPTS; attempt++) {
    if (attempt) await sleep(VISIBILITY_DELAY_MS);
    try {
      after = await loadSnapshot(p, AbortSignal.timeout(SNAPSHOT_DEADLINE_MS));
    } catch {
      continue;
    }
    if (changeVisible(before, after, c)) return { after, visible: true };
  }
  return { after, visible: false };
}

/**
 * Apply one change. `fingerprint` is previewFingerprint() of the snapshot the
 * admin saw; if Arc's state differs now, the change is refused (409 'stale').
 * That check and the write are separate requests, so it is best effort
 * against concurrent admins, not a lock. Never retried: roles and measurement
 * permissions are not unique in Arc, so a blind retry can duplicate them.
 */
export async function applyRbacChange(
  t: RbacTarget,
  opts: RbacOptions,
  actorUserId: string,
  change: RbacChange,
  fingerprint: string,
): Promise<ChangeOutcome> {
  const fields = validateChange(change);
  if (fields) throw new RbacError('invalid', 'Some fields are not valid', fields);

  const p = await pin(t, opts);
  // The reads before the write stop if the admin's request goes away.
  const readSignal = AbortSignal.any([AbortSignal.timeout(SNAPSHOT_DEADLINE_MS), ...(opts.signal ? [opts.signal] : [])]);
  const before = await loadSnapshot(p, readSignal);
  if (!before.licensed && !UNLICENSED_CHANGES.has(change.kind)) {
    throw new RbacError('unlicensed', 'Without an RBAC license, only removing a token from a team is possible');
  }
  if (before.truncated && change.kind !== 'membership.remove') {
    throw new RbacError('truncated', 'This instance has more access-control items than Launchpad loads, so changes cannot be previewed reliably');
  }
  if (!targetExists(before, change)) throw new RbacError('not_found', 'What this change acts on no longer exists');
  if (previewFingerprint(before, change) !== fingerprint) {
    throw new RbacError('stale', 'Access changed since you opened this preview. Review the change again.');
  }

  // The write gets its own deadline and is not tied to the admin's request:
  // once sent, an abort could not unsend it, only hide its outcome.
  const req = requestFor(change);
  let answer: ArcAnswer | null = null;
  try {
    answer = await call(p, AbortSignal.timeout(WRITE_DEADLINE_MS), req.method, req.path, req.body);
  } catch {
    answer = null; // no answer: settled below by reading the tree
  }
  const record = (outcome?: 'ok' | 'error' | 'unknown') =>
    recordChange({ instanceId: t.id, actorUserId, method: req.method, path: req.path.replace(/^\//, ''), status: answer?.status ?? null, outcome });
  snapshotCache.clear();

  if (answer && answer.status >= 200 && answer.status < 300) {
    record();
    const { after, visible } = await readBack(p, before, change);
    return { result: visible ? 'applied' : 'unknown', snapshot: visible ? after : null };
  }
  if (answer && answer.status < 500) {
    record();
    const refused = refusal(answer);
    if (refused) throw refused;
    if (answer.status === 404) throw new RbacError('not_found', fromArc(answer));
    throw new RbacError('arc_error', fromArc(answer), arcFieldErrors(change, answer));
  }

  // 5xx or no answer: in a cluster a write can commit and still fail its
  // read-back (or commit later). Look before telling the admin to try again.
  const { after, visible } = await readBack(p, before, change);
  record(visible ? 'ok' : 'unknown');
  if (!after) return { result: 'unknown', snapshot: null };
  return { result: visible ? 'applied_after_error' : 'not_visible', snapshot: after };
}

/** Put Arc's validation refusals next to the field they are about. */
function arcFieldErrors(c: RbacChange, a: ArcAnswer): Record<string, string> | undefined {
  const msg = a.message ? `Arc: ${a.message}` : null;
  if (!msg || (a.status !== 400 && a.status !== 409)) return undefined;
  if (/name/i.test(a.message ?? '') && (c.kind === 'org.create' || c.kind === 'org.update' || c.kind === 'team.create' || c.kind === 'team.update')) return { name: msg };
  if (/pattern/i.test(a.message ?? '')) return c.kind === 'mp.create' ? { measurementPattern: msg } : { databasePattern: msg };
  if (/permission/i.test(a.message ?? '') && 'permissions' in c) return { permissions: msg };
  return undefined;
}

/** Test hook. */
export function resetRbacCacheForTests(): void {
  snapshotCache.clear();
}
