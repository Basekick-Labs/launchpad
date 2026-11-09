/**
 * Arc RBAC administration for the Access tab (#8): load the whole tree in one
 * server-side pass, and apply one change at a time after checking that what
 * the admin previewed is still what Arc holds.
 *
 * Every request in one operation is pinned to the same resolved IP of the
 * instance endpoint: in a cluster each node answers reads from its own copy,
 * so reading after a write on a different node could miss the write.
 * Every change attempt is recorded in the instance change log with the
 * Launchpad user and its outcome.
 *
 * Free of $env imports (the caller passes allowPrivate) so it runs under
 * vitest against a fake Arc.
 */

import { assertSafeResolvedUrl, safeRequest } from './ssrf.js';
import { parseJson } from './util.js';
import { recordChange } from './instanceChangeLog.js';
import {
  applyChange,
  asList,
  parseMeasurementPermission,
  parseOrg,
  parseRole,
  parseTeam,
  parseToken,
  previewFingerprint,
  UNLICENSED_CHANGES,
  validateChange,
  type RbacChange,
  type RbacMeasurementPermission,
  type RbacOrg,
  type RbacRole,
  type RbacSnapshot,
  type RbacTeam,
} from '../rbac.js';

export interface RbacTarget {
  id: string;
  endpoint_url: string | null;
  admin_token: string | null;
}

export interface RbacOptions {
  allowPrivate: boolean;
}

export type RbacErrorCode =
  | 'unreachable'
  | 'token_rejected'
  | 'token_not_admin'
  | 'auth_off'
  | 'unlicensed'
  | 'invalid'
  | 'stale'
  | 'not_found'
  | 'arc_error';

export class RbacError extends Error {
  constructor(
    public readonly code: RbacErrorCode,
    message: string,
    public readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = 'RbacError';
  }
}

const IDLE_TIMEOUT_MS = 5000;
const SNAPSHOT_DEADLINE_MS = 20_000;
const CHANGE_DEADLINE_MS = 15_000;
const CONCURRENCY = 6;
/** Organizations + teams + roles + tokens loaded; beyond this the snapshot is truncated. */
const MAX_ENTITIES = 5000;
const MAX_BYTES = 4 * 1024 * 1024;

interface Pinned {
  base: string;
  ip: string;
  token: string;
  opts: RbacOptions;
  signal: AbortSignal;
}

async function pin(t: RbacTarget, opts: RbacOptions, deadlineMs: number): Promise<Pinned> {
  const base = (t.endpoint_url ?? '').replace(/\/+$/, '');
  if (!base || !t.admin_token) throw new RbacError('unreachable', 'This connection has no endpoint or token');
  const signal = AbortSignal.timeout(deadlineMs);
  try {
    const target = await assertSafeResolvedUrl(base, { allowHttp: true, allowPrivate: opts.allowPrivate });
    return { base, ip: target.ip, token: t.admin_token, opts, signal };
  } catch {
    throw new RbacError('unreachable', 'The Arc endpoint is not reachable or not allowed');
  }
}

interface ArcAnswer {
  status: number;
  body: unknown;
  /** Arc's own error message, bounded. */
  message: string | null;
}

async function call(p: Pinned, method: string, path: string, body?: unknown): Promise<ArcAnswer> {
  const payload = body === undefined ? null : JSON.stringify(body);
  let res;
  try {
    res = await safeRequest(`${p.base}${path}`, {
      allowHttp: true,
      allowPrivate: p.opts.allowPrivate,
      method,
      pinTo: p.ip,
      signal: p.signal,
      timeoutMs: IDLE_TIMEOUT_MS,
      maxResponseBytes: MAX_BYTES,
      headers: {
        authorization: `Bearer ${p.token}`,
        ...(payload !== null && { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
      },
      body: payload,
    });
  } catch {
    throw new RbacError('unreachable', 'Arc did not answer');
  }
  const parsed = parseJson(res.body.toString('utf8'));
  const err = (parsed as { error?: unknown } | null)?.error;
  return { status: res.status, body: parsed, message: typeof err === 'string' ? err.slice(0, 300) : null };
}

/** Map an Arc refusal on the RBAC routes to a code the UI can explain. */
function refusal(a: ArcAnswer): RbacError | null {
  if (a.status === 401) return new RbacError('token_rejected', 'Arc rejected the stored token');
  if (a.status === 403 && /admin required|permission denied/i.test(a.message ?? '')) {
    return new RbacError('token_not_admin', 'The stored token needs admin permission to manage access');
  }
  if (a.status === 403 && /license/i.test(a.message ?? '')) return new RbacError('unlicensed', 'The license does not include RBAC');
  if (a.status === 404 && /cannot (get|post|patch|delete)/i.test(a.message ?? '')) {
    return new RbacError('auth_off', 'Arc runs without authentication, so it has no RBAC');
  }
  return null;
}

/** Run `fn` over items with bounded concurrency, in order of completion. */
async function each<T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
}

async function loadTree(p: Pinned): Promise<Omit<RbacSnapshot, 'tokens' | 'memberships' | 'teamNames' | 'loadedAt'>> {
  const first = await call(p, 'GET', '/api/v1/rbac/organizations');
  const refused = refusal(first);
  if (refused?.code === 'unlicensed') {
    return { licensed: false, orgs: [], teams: [], roles: [], measurementPermissions: [], truncated: false };
  }
  if (refused) throw refused;
  if (first.status !== 200) throw new RbacError('arc_error', first.message ?? `Arc answered ${first.status}`);

  let budget = MAX_ENTITIES;
  let truncated = false;
  const take = <T>(items: T[]): T[] => {
    if (items.length > budget) {
      truncated = true;
      items = items.slice(0, budget);
    }
    budget -= items.length;
    return items;
  };

  const orgs = take(asList((first.body as { organizations?: unknown })?.organizations).map(parseOrg).filter((o): o is RbacOrg => !!o));
  const teams: RbacTeam[] = [];
  await each(orgs, async (o) => {
    const a = await call(p, 'GET', `/api/v1/rbac/organizations/${o.id}`);
    if (a.status !== 200) return; // deleted meanwhile
    const org = (a.body as { organization?: { teams?: unknown } })?.organization;
    teams.push(...take(asList(org?.teams).map(parseTeam).filter((t): t is RbacTeam => !!t)));
  });
  const roles: RbacRole[] = [];
  await each(teams, async (t) => {
    const a = await call(p, 'GET', `/api/v1/rbac/teams/${t.id}`);
    if (a.status !== 200) return;
    const team = (a.body as { team?: { roles?: unknown } })?.team;
    roles.push(...take(asList(team?.roles).map(parseRole).filter((r): r is RbacRole => !!r)));
  });
  const measurementPermissions: RbacMeasurementPermission[] = [];
  await each(roles, async (r) => {
    const a = await call(p, 'GET', `/api/v1/rbac/roles/${r.id}`);
    if (a.status !== 200) return;
    const role = (a.body as { role?: { measurement_permissions?: unknown } })?.role;
    measurementPermissions.push(...asList(role?.measurement_permissions).map(parseMeasurementPermission).filter((m): m is RbacMeasurementPermission => !!m));
  });
  const byId = <T extends { id: number }>(a: T, b: T) => a.id - b.id;
  return { licensed: true, orgs: orgs.sort(byId), teams: teams.sort(byId), roles: roles.sort(byId), measurementPermissions: measurementPermissions.sort(byId), truncated };
}

async function loadSnapshot(p: Pinned): Promise<RbacSnapshot> {
  const [tree, tokensAnswer] = await Promise.all([loadTree(p), call(p, 'GET', '/api/v1/auth/tokens')]);
  const refused = refusal(tokensAnswer);
  if (refused) throw refused;
  if (tokensAnswer.status !== 200) throw new RbacError('arc_error', tokensAnswer.message ?? `Arc answered ${tokensAnswer.status}`);
  let tokens = asList((tokensAnswer.body as { tokens?: unknown })?.tokens).map(parseToken).filter((t): t is NonNullable<typeof t> => !!t);
  let truncated = tree.truncated;
  if (tokens.length > MAX_ENTITIES) {
    tokens = tokens.slice(0, MAX_ENTITIES);
    truncated = true;
  }

  // Memberships per token (Arc has no team → tokens listing). Not license-
  // gated in Arc, so the unlicensed view still has them.
  const memberships: Record<number, number[]> = {};
  const teamNames: Record<number, string> = {};
  await each(tokens, async (tok) => {
    const a = await call(p, 'GET', `/api/v1/auth/tokens/${tok.id}/teams`);
    if (a.status !== 200) return;
    const teams = asList((a.body as { teams?: unknown })?.teams).map(parseTeam).filter((t): t is RbacTeam => !!t);
    if (teams.length) memberships[tok.id] = teams.map((t) => t.id).sort((x, y) => x - y);
    for (const t of teams) teamNames[t.id] = t.name;
  });

  return { ...tree, tokens: tokens.sort((a, b) => a.id - b.id), memberships, teamNames, truncated, loadedAt: Date.now() };
}

/** The whole RBAC tree and every token's memberships, from one node. */
export async function getRbacSnapshot(t: RbacTarget, opts: RbacOptions): Promise<RbacSnapshot> {
  return loadSnapshot(await pin(t, opts, SNAPSHOT_DEADLINE_MS));
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
  /** Arc applied it. */
  | 'applied'
  /** Arc answered 5xx after a create, but the item exists: it was applied. */
  | 'applied_after_error'
  /** Arc answered 5xx and the item does not exist. */
  | 'not_applied'
  /** It cannot be told whether Arc applied it. */
  | 'unknown';

export interface ChangeOutcome {
  result: ChangeResult;
  /** The tree after the change, from the same node. */
  snapshot: RbacSnapshot;
}

/** Items created by `c` that the snapshot holds (same name/pattern under the same parent). */
function createdCount(s: RbacSnapshot, c: RbacChange): number | null {
  switch (c.kind) {
    case 'org.create': return s.orgs.filter((o) => o.name === c.name).length;
    case 'team.create': return s.teams.filter((t) => t.orgId === c.orgId && t.name === c.name).length;
    case 'role.create': return s.roles.filter((r) => r.teamId === c.teamId && r.databasePattern === c.databasePattern).length;
    case 'mp.create': return s.measurementPermissions.filter((m) => m.roleId === c.roleId && m.measurementPattern === c.measurementPattern).length;
    case 'membership.add': return (s.memberships[c.tokenId] ?? []).includes(c.teamId) ? 1 : 0;
    default: return null;
  }
}

/**
 * Apply one change. `fingerprint` is previewFingerprint() of the snapshot the
 * admin saw; if Arc's state differs now, nothing is sent (409 'stale').
 * Never retried: roles and measurement permissions are not unique in Arc, so
 * a blind retry can duplicate them.
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

  const p = await pin(t, opts, CHANGE_DEADLINE_MS);
  const before = await loadSnapshot(p);
  if (!before.licensed && !UNLICENSED_CHANGES.has(change.kind)) {
    throw new RbacError('unlicensed', 'Without an RBAC license, only removing a token from a team is possible');
  }
  if (previewFingerprint(before, change) !== fingerprint) {
    throw new RbacError('stale', 'Access changed since you opened this preview. Review the change again.');
  }

  const req = requestFor(change);
  let answer: ArcAnswer | null = null;
  try {
    answer = await call(p, req.method, req.path, req.body);
  } finally {
    recordChange({ instanceId: t.id, actorUserId, method: req.method, path: req.path.replace(/^\//, ''), status: answer?.status ?? null });
  }

  if (answer.status >= 200 && answer.status < 300) {
    return { result: 'applied', snapshot: await loadSnapshot(p).catch(() => applyChange(before, change)) };
  }
  const refused = refusal(answer);
  if (refused) throw refused;
  if (answer.status === 404) throw new RbacError('not_found', answer.message ?? 'It no longer exists');
  if (answer.status < 500) throw new RbacError('arc_error', answer.message ?? `Arc answered ${answer.status}`);

  // 5xx: in a cluster a create can commit and still fail its read-back.
  // Look before telling the admin to try again.
  const expected = createdCount(before, change);
  let after: RbacSnapshot;
  try {
    after = await loadSnapshot(p);
  } catch {
    return { result: 'unknown', snapshot: before };
  }
  if (expected === null) return { result: 'unknown', snapshot: after };
  return { result: (createdCount(after, change) ?? 0) > expected ? 'applied_after_error' : 'not_applied', snapshot: after };
}
