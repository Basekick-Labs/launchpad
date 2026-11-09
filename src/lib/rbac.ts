/**
 * Arc RBAC model for the Access tab (#8): the tree Launchpad loads from Arc,
 * what each token can actually do, and what a change would do to every token
 * it touches — shown before the change is made.
 *
 * Mirrors Arc's enforcement (internal/auth/rbac_manager.go, v26.09.3+):
 *  - a token holding `admin` bypasses RBAC entirely (hasCoarseAdmin, :1795);
 *  - a token in at least one team is decided by RBAC alone, and a denial is
 *    final (:1643-1661) — membership counts even when the team is disabled;
 *  - grants come from enabled teams only; a role that has measurement
 *    permissions grants only those, never its database-wide permissions
 *    (checkRBACPermissionCached, :1921-1976);
 *  - a token in no team falls back to its own permissions on every database;
 *  - an organization's `enabled` flag is not enforced.
 * Separately, Arc's SQL and ingest routes still require the token's own
 * read/write bit before RBAC applies (Basekick-Labs/arc#1559), so each grant
 * is shown with that route gate.
 *
 * Pure and isomorphic; the I/O is src/lib/server/rbacAdmin.ts.
 */

export const RBAC_PERMISSIONS = ['read', 'write', 'delete', 'admin'] as const;
export type RbacPermission = (typeof RBAC_PERMISSIONS)[number];

/** Arc's rules (rbac_manager.go:20-23). Used as form hints; Arc decides. */
export const RBAC_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
export const RBAC_PATTERN_RE = /^[a-zA-Z0-9_-]+\*?$|^\*[a-zA-Z0-9_-]*$|^\*$/;
export const RBAC_DESCRIPTION_MAX = 1024;

export interface RbacOrg {
  id: number;
  name: string;
  description: string;
}
export interface RbacTeam {
  id: number;
  orgId: number;
  name: string;
  description: string;
  enabled: boolean;
}
export interface RbacRole {
  id: number;
  teamId: number;
  databasePattern: string;
  permissions: RbacPermission[];
}
export interface RbacMeasurementPermission {
  id: number;
  roleId: number;
  measurementPattern: string;
  permissions: RbacPermission[];
}
export interface RbacToken {
  id: number;
  name: string;
  permissions: RbacPermission[];
  /** False when disabled or expired. */
  enabled: boolean;
}

export interface RbacSnapshot {
  /** False when the license lacks RBAC: only token memberships are loaded. */
  licensed: boolean;
  orgs: RbacOrg[];
  teams: RbacTeam[];
  roles: RbacRole[];
  measurementPermissions: RbacMeasurementPermission[];
  tokens: RbacToken[];
  /** tokenId → teamIds (as Arc reports them, enabled or not). */
  memberships: Record<number, number[]>;
  /** Team names known from token memberships (the unlicensed view has no tree). */
  teamNames: Record<number, string>;
  loadedAt: number;
  /** The tree was larger than Launchpad loads; some items are missing. */
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Parsing what Arc returns (lists are `null` when empty)

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function id(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null;
}
function str(v: unknown, max = 1024): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}
export function asList(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function perms(v: unknown): RbacPermission[] {
  const out = asList(v).filter((p): p is RbacPermission => (RBAC_PERMISSIONS as readonly unknown[]).includes(p));
  return [...new Set(out)];
}

export function parseOrg(v: unknown): RbacOrg | null {
  const o = obj(v);
  const oid = id(o?.id);
  return o && oid ? { id: oid, name: str(o.name, 64), description: str(o.description) } : null;
}
export function parseTeam(v: unknown): RbacTeam | null {
  const o = obj(v);
  const tid = id(o?.id);
  const orgId = id(o?.organization_id);
  return o && tid && orgId
    ? { id: tid, orgId, name: str(o.name, 64), description: str(o.description), enabled: o.enabled !== false }
    : null;
}
export function parseRole(v: unknown): RbacRole | null {
  const o = obj(v);
  const rid = id(o?.id);
  const teamId = id(o?.team_id);
  return o && rid && teamId ? { id: rid, teamId, databasePattern: str(o.database_pattern, 256), permissions: perms(o.permissions) } : null;
}
export function parseMeasurementPermission(v: unknown): RbacMeasurementPermission | null {
  const o = obj(v);
  const mid = id(o?.id);
  const roleId = id(o?.role_id);
  return o && mid && roleId
    ? { id: mid, roleId, measurementPattern: str(o.measurement_pattern, 256), permissions: perms(o.permissions) }
    : null;
}
/** `now` decides whether an expiry has passed: Arc refuses expired tokens outright. */
export function parseToken(v: unknown, now = Date.now()): RbacToken | null {
  const o = obj(v);
  const tid = id(o?.id);
  if (!o || !tid) return null;
  const expires = typeof o.expires_at === 'string' ? Date.parse(o.expires_at) : NaN;
  return { id: tid, name: str(o.name, 128), permissions: perms(o.permissions), enabled: o.enabled !== false && !(expires <= now) };
}

// ---------------------------------------------------------------------------
// What a token can do

export interface Grant {
  teamId: number;
  roleId: number;
  /** The measurement permission this grant comes from; null for a database-wide role grant. */
  mpId: number | null;
  databasePattern: string;
  /** null = every measurement in the matched databases. */
  measurementPattern: string | null;
  permissions: RbacPermission[];
}

export type AccessMode =
  /** Holds `admin`: RBAC does not apply. */
  | 'admin_bypass'
  /** In teams, but the license has no RBAC, so their grants cannot be read. */
  | 'rbac_unknown'
  /** Disabled token: nothing. */
  | 'disabled'
  /** In at least one team: exactly the grants listed, nothing else. */
  | 'rbac'
  /** In no team: its own permissions on every database. */
  | 'token';

export interface TokenAccess {
  tokenId: number;
  mode: AccessMode;
  /** For mode 'rbac'; empty means the token is denied everything. */
  grants: Grant[];
  /** The token's own permissions (mode 'token', and the SQL/ingest gate). */
  ownPermissions: string[];
  /** Arc's query/ingest routes need these bits on the token itself (arc#1559). */
  routeGate: { query: boolean; ingest: boolean };
}

interface Index {
  teams: Map<number, RbacTeam>;
  rolesByTeam: Map<number, RbacRole[]>;
  mpsByRole: Map<number, RbacMeasurementPermission[]>;
  tokens: Map<number, RbacToken>;
}

/** Lookups built once per snapshot (snapshots are never mutated in place). */
const indexes = new WeakMap<RbacSnapshot, Index>();

function group<T, K>(items: T[], key: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const it of items) {
    const k = key(it);
    const list = m.get(k);
    if (list) list.push(it);
    else m.set(k, [it]);
  }
  return m;
}

export function indexOf(s: RbacSnapshot): Index {
  let ix = indexes.get(s);
  if (!ix) {
    ix = {
      teams: new Map(s.teams.map((t) => [t.id, t])),
      rolesByTeam: group(s.roles, (r) => r.teamId),
      mpsByRole: group(s.measurementPermissions, (m) => m.roleId),
      tokens: new Map(s.tokens.map((t) => [t.id, t])),
    };
    indexes.set(s, ix);
  }
  return ix;
}

function grantsFor(s: RbacSnapshot, teamIds: number[]): Grant[] {
  const ix = indexOf(s);
  const grants: Grant[] = [];
  for (const teamId of teamIds) {
    if (!ix.teams.get(teamId)?.enabled) continue;
    for (const role of ix.rolesByTeam.get(teamId) ?? []) {
      const mps = ix.mpsByRole.get(role.id) ?? [];
      if (mps.length > 0) {
        for (const m of mps) {
          grants.push({ teamId, roleId: role.id, mpId: m.id, databasePattern: role.databasePattern, measurementPattern: m.measurementPattern, permissions: m.permissions });
        }
      } else {
        grants.push({ teamId, roleId: role.id, mpId: null, databasePattern: role.databasePattern, measurementPattern: null, permissions: role.permissions });
      }
    }
  }
  // Plain code-unit order: the browser and the server must agree (fingerprints).
  const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  return grants.sort((a, b) =>
    cmp(a.databasePattern, b.databasePattern) || cmp(a.measurementPattern ?? '', b.measurementPattern ?? '') || a.roleId - b.roleId || (a.mpId ?? 0) - (b.mpId ?? 0));
}

export function tokenAccess(s: RbacSnapshot, tokenId: number): TokenAccess {
  const token = indexOf(s).tokens.get(tokenId);
  const own = token?.permissions ?? [];
  const gate = { query: own.includes('read') || own.includes('admin'), ingest: own.includes('write') || own.includes('admin') };
  const base = { tokenId, grants: [] as Grant[], ownPermissions: own, routeGate: gate };
  // Arc refuses a disabled (or expired) token before any permission check.
  if (token && !token.enabled) return { ...base, mode: 'disabled' };
  if (own.includes('admin')) return { ...base, mode: 'admin_bypass' };
  const teamIds = s.memberships[tokenId] ?? [];
  if (teamIds.length === 0) return { ...base, mode: 'token' };
  if (!s.licensed) return { ...base, mode: 'rbac_unknown' };
  return { ...base, mode: 'rbac', grants: grantsFor(s, teamIds) };
}

// ---------------------------------------------------------------------------
// Changes

export type RbacChange =
  | { kind: 'org.create'; name: string; description: string }
  | { kind: 'org.update'; orgId: number; name?: string; description?: string }
  | { kind: 'org.delete'; orgId: number }
  | { kind: 'team.create'; orgId: number; name: string; description: string }
  | { kind: 'team.update'; teamId: number; name?: string; description?: string; enabled?: boolean }
  | { kind: 'team.delete'; teamId: number }
  | { kind: 'role.create'; teamId: number; databasePattern: string; permissions: RbacPermission[] }
  | { kind: 'role.update'; roleId: number; databasePattern?: string; permissions?: RbacPermission[] }
  | { kind: 'role.delete'; roleId: number }
  | { kind: 'mp.create'; roleId: number; measurementPattern: string; permissions: RbacPermission[] }
  | { kind: 'mp.delete'; mpId: number }
  | { kind: 'membership.add'; tokenId: number; teamId: number }
  | { kind: 'membership.remove'; tokenId: number; teamId: number };

/** Changes allowed without an RBAC license (Arc keeps this one ungated: it is how a lockout is undone). */
export const UNLICENSED_CHANGES: ReadonlySet<RbacChange['kind']> = new Set(['membership.remove']);

const ENCODER = new TextEncoder();

/** Field errors for a change, or null. Arc's name and pattern rules plus a description cap; Arc still decides. */
export function validateChange(c: RbacChange): Record<string, string> | null {
  const errors: Record<string, string> = {};
  const name = (v: string | undefined, field = 'name') => {
    if (v !== undefined && !RBAC_NAME_RE.test(v)) errors[field] = 'Start with a letter; letters, digits, _ and - only; at most 64 characters';
  };
  const desc = (v: string | undefined) => {
    if (v !== undefined && ENCODER.encode(v).length > RBAC_DESCRIPTION_MAX) errors.description = `At most ${RBAC_DESCRIPTION_MAX} bytes`;
  };
  const pattern = (v: string | undefined, field: string) => {
    if (v !== undefined && !RBAC_PATTERN_RE.test(v)) errors[field] = 'An exact name, prefix*, *suffix or *; letters, digits, _ and - only';
  };
  const permList = (v: RbacPermission[] | undefined) => {
    if (v !== undefined && (v.length === 0 || v.some((p) => !(RBAC_PERMISSIONS as readonly string[]).includes(p)))) {
      errors.permissions = 'Choose at least one of read, write, delete, admin';
    }
  };
  switch (c.kind) {
    case 'org.create': name(c.name); desc(c.description); break;
    case 'org.update': name(c.name); desc(c.description); if (c.name === undefined && c.description === undefined) errors.form = 'Nothing to change'; break;
    case 'team.create': name(c.name); desc(c.description); break;
    case 'team.update': name(c.name); desc(c.description); if (c.name === undefined && c.description === undefined && c.enabled === undefined) errors.form = 'Nothing to change'; break;
    case 'role.create': pattern(c.databasePattern, 'databasePattern'); permList(c.permissions); break;
    case 'role.update': pattern(c.databasePattern, 'databasePattern'); permList(c.permissions); if (c.databasePattern === undefined && c.permissions === undefined) errors.form = 'Nothing to change'; break;
    case 'mp.create': pattern(c.measurementPattern, 'measurementPattern'); permList(c.permissions); break;
  }
  return Object.keys(errors).length ? errors : null;
}

/** The snapshot as it would be after `c`. A created item gets a negative id. */
export function applyChange(s: RbacSnapshot, c: RbacChange): RbacSnapshot {
  const tempId = -1;
  const n: RbacSnapshot = {
    ...s,
    orgs: [...s.orgs],
    teams: [...s.teams],
    roles: [...s.roles],
    measurementPermissions: [...s.measurementPermissions],
    memberships: Object.fromEntries(Object.entries(s.memberships).map(([k, v]) => [k, [...v]])),
  };
  const dropTeams = (list: number[]) => {
    const ids = new Set(list);
    const roleIds = new Set(n.roles.filter((r) => ids.has(r.teamId)).map((r) => r.id));
    n.teams = n.teams.filter((t) => !ids.has(t.id));
    n.roles = n.roles.filter((r) => !ids.has(r.teamId));
    n.measurementPermissions = n.measurementPermissions.filter((m) => !roleIds.has(m.roleId));
    for (const k of Object.keys(n.memberships)) {
      const kept = n.memberships[+k].filter((t) => !ids.has(t));
      if (kept.length) n.memberships[+k] = kept;
      else delete n.memberships[+k];
    }
  };
  switch (c.kind) {
    case 'org.create': n.orgs.push({ id: tempId, name: c.name, description: c.description }); break;
    case 'org.update': n.orgs = n.orgs.map((o) => (o.id === c.orgId ? { ...o, ...(c.name !== undefined && { name: c.name }), ...(c.description !== undefined && { description: c.description }) } : o)); break;
    case 'org.delete': dropTeams(n.teams.filter((t) => t.orgId === c.orgId).map((t) => t.id)); n.orgs = n.orgs.filter((o) => o.id !== c.orgId); break;
    case 'team.create': n.teams.push({ id: tempId, orgId: c.orgId, name: c.name, description: c.description, enabled: true }); break;
    case 'team.update': n.teams = n.teams.map((t) => (t.id === c.teamId ? { ...t, ...(c.name !== undefined && { name: c.name }), ...(c.description !== undefined && { description: c.description }), ...(c.enabled !== undefined && { enabled: c.enabled }) } : t)); break;
    case 'team.delete': dropTeams([c.teamId]); break;
    case 'role.create': n.roles.push({ id: tempId, teamId: c.teamId, databasePattern: c.databasePattern, permissions: c.permissions }); break;
    case 'role.update': n.roles = n.roles.map((r) => (r.id === c.roleId ? { ...r, ...(c.databasePattern !== undefined && { databasePattern: c.databasePattern }), ...(c.permissions !== undefined && { permissions: c.permissions }) } : r)); break;
    case 'role.delete': n.roles = n.roles.filter((r) => r.id !== c.roleId); n.measurementPermissions = n.measurementPermissions.filter((m) => m.roleId !== c.roleId); break;
    case 'mp.create': n.measurementPermissions.push({ id: tempId, roleId: c.roleId, measurementPattern: c.measurementPattern, permissions: c.permissions }); break;
    case 'mp.delete': n.measurementPermissions = n.measurementPermissions.filter((m) => m.id !== c.mpId); break;
    case 'membership.add': n.memberships[c.tokenId] = [...new Set([...(n.memberships[c.tokenId] ?? []), c.teamId])]; break;
    case 'membership.remove': {
      const kept = (n.memberships[c.tokenId] ?? []).filter((t) => t !== c.teamId);
      if (kept.length) n.memberships[c.tokenId] = kept;
      else delete n.memberships[c.tokenId];
      break;
    }
  }
  return n;
}

export type ImpactFlag =
  /** The token leaves its own permissions and is governed by RBAC from now on. */
  | 'switches_to_rbac'
  /** The token leaves RBAC and gets its own permissions on every database. */
  | 'reverts_to_token_permissions'
  /** A grant that covered a whole database now covers listed measurements only. */
  | 'narrowed_to_measurements'
  /** A grant limited to measurements now covers the whole database. */
  | 'widened_to_database'
  /** The token ends up with no access at all. */
  | 'total_denial'
  /** The token holds `admin`; RBAC changes do not affect it. */
  | 'no_effect_admin';

export interface TokenImpact {
  tokenId: number;
  tokenName: string;
  before: TokenAccess;
  after: TokenAccess;
  gained: Grant[];
  lost: Grant[];
  flags: ImpactFlag[];
}

export interface ChangePreview {
  impacts: TokenImpact[];
  /** Any impact that widens access needs the same care as a delete. */
  widensAccess: boolean;
  /** What a delete removes. */
  cascade: { teams: number; roles: number; measurementPermissions: number; memberships: number } | null;
}

/** Whether grant `a` already allows everything grant `b` does (same database pattern). */
function covers(a: Grant, b: Grant): boolean {
  if (a.databasePattern !== b.databasePattern) return false;
  if (a.measurementPattern !== null && a.measurementPattern !== b.measurementPattern) return false;
  return a.permissions.includes('admin') || b.permissions.every((p) => a.permissions.includes(p));
}

const grantKey = (g: Grant) => `${g.teamId}|${g.roleId}|${g.mpId ?? '-'}|${g.databasePattern}|${g.measurementPattern ?? '*all*'}|${[...g.permissions].sort().join(',')}`;

function affectedTokens(s: RbacSnapshot, c: RbacChange): number[] {
  const teamsOf = (teamIds: number[]) => {
    const set = new Set(teamIds);
    return s.tokens.filter((t) => (s.memberships[t.id] ?? []).some((tid) => set.has(tid))).map((t) => t.id);
  };
  const roleTeam = (roleId: number) => s.roles.find((r) => r.id === roleId)?.teamId;
  switch (c.kind) {
    case 'org.delete': return teamsOf(s.teams.filter((t) => t.orgId === c.orgId).map((t) => t.id));
    case 'team.update': case 'team.delete': return teamsOf([c.teamId]);
    case 'role.create': return teamsOf([c.teamId]);
    case 'role.update': case 'role.delete': case 'mp.create': {
      const t = roleTeam(c.roleId);
      return t ? teamsOf([t]) : [];
    }
    case 'mp.delete': {
      const role = s.measurementPermissions.find((m) => m.id === c.mpId)?.roleId;
      const t = role ? roleTeam(role) : undefined;
      return t ? teamsOf([t]) : [];
    }
    case 'membership.add': case 'membership.remove': return [c.tokenId];
    default: return [];
  }
}

function flagsFor(before: TokenAccess, after: TokenAccess): ImpactFlag[] {
  if (before.mode === 'admin_bypass') return ['no_effect_admin'];
  const flags: ImpactFlag[] = [];
  if (before.mode === 'token' && after.mode === 'rbac') flags.push('switches_to_rbac');
  if (before.mode === 'rbac' && after.mode === 'token') flags.push('reverts_to_token_permissions');
  if (after.mode === 'rbac' && after.grants.length === 0 && !(before.mode === 'rbac' && before.grants.length === 0)) flags.push('total_denial');
  if (before.mode === 'rbac' && after.mode === 'rbac') {
    const wide = (a: TokenAccess) => new Set(a.grants.filter((g) => g.measurementPattern === null).map((g) => g.roleId));
    const narrow = (a: TokenAccess) => new Set(a.grants.filter((g) => g.measurementPattern !== null).map((g) => g.roleId));
    const [wb, wa, nb, na] = [wide(before), wide(after), narrow(before), narrow(after)];
    if ([...wb].some((r) => na.has(r) && !wa.has(r))) flags.push('narrowed_to_measurements');
    if ([...nb].some((r) => wa.has(r) && !na.has(r))) flags.push('widened_to_database');
  }
  return flags;
}

/** What `c` would do to every token it touches, computed before it is made. */
export function previewChange(s: RbacSnapshot, c: RbacChange): ChangePreview {
  const after = applyChange(s, c);
  const impacts: TokenImpact[] = [];
  for (const tokenId of affectedTokens(s, c)) {
    const b = tokenAccess(s, tokenId);
    const a = tokenAccess(after, tokenId);
    const bk = new Set(b.grants.map(grantKey));
    const ak = new Set(a.grants.map(grantKey));
    impacts.push({
      tokenId,
      tokenName: indexOf(s).tokens.get(tokenId)?.name ?? `token ${tokenId}`,
      before: b,
      after: a,
      gained: a.grants.filter((g) => !bk.has(grantKey(g))),
      lost: b.grants.filter((g) => !ak.has(grantKey(g))),
      flags: flagsFor(b, a),
    });
  }
  // Joining RBAC "gains" grants but narrows the token overall, and narrowing
  // a role trades a database-wide grant for a smaller one. Widening is leaving
  // RBAC, a measurement-limited grant growing, or a gained grant that nothing
  // the token already had covers.
  const widensAccess = impacts.some((i) =>
    i.flags.includes('reverts_to_token_permissions') ||
    i.flags.includes('widened_to_database') ||
    (i.before.mode === 'rbac' && i.after.mode === 'rbac' && i.gained.some((g) => !i.before.grants.some((b) => covers(b, g)))) ||
    // A token joining RBAC with a permission it does not hold itself gains it
    // where Arc checks RBAC alone (database listing, arc#1559).
    (i.before.mode === 'token' && i.after.mode === 'rbac' && i.gained.some((g) => g.permissions.some((p) => !i.before.ownPermissions.includes(p)))));
  return { impacts, widensAccess, cascade: cascadeOf(s, c) };
}

function cascadeOf(s: RbacSnapshot, c: RbacChange): ChangePreview['cascade'] {
  let teamIds: number[];
  let roleIds: number[];
  if (c.kind === 'org.delete') teamIds = s.teams.filter((t) => t.orgId === c.orgId).map((t) => t.id);
  else if (c.kind === 'team.delete') teamIds = [c.teamId];
  else if (c.kind === 'role.delete') return { teams: 0, roles: 1, measurementPermissions: s.measurementPermissions.filter((m) => m.roleId === c.roleId).length, memberships: 0 };
  else return null;
  const teamSet = new Set(teamIds);
  roleIds = s.roles.filter((r) => teamSet.has(r.teamId)).map((r) => r.id);
  const roleSet = new Set(roleIds);
  return {
    teams: teamIds.length,
    roles: roleIds.length,
    measurementPermissions: s.measurementPermissions.filter((m) => roleSet.has(m.roleId)).length,
    memberships: Object.values(s.memberships).reduce((n, ids) => n + ids.filter((t) => teamSet.has(t)).length, 0),
  };
}

/**
 * The state a change was previewed against, as a comparable string: the
 * access of every token it touches and the target's existence. The server
 * recomputes it from a fresh snapshot and refuses the change if another
 * admin changed things in between.
 */
export function previewFingerprint(s: RbacSnapshot, c: RbacChange): string {
  const p = previewChange(s, c);
  return hash64(JSON.stringify({
    kind: c.kind,
    exists: targetExists(s, c),
    // What the admin read in the preview: the sentence (names), the cascade
    // and each affected token's access.
    text: describeChange(s, c),
    cascade: p.cascade,
    // Before AND after: another admin adding a role to the team a token is
    // joining changes the result without changing the token's current access.
    tokens: p.impacts.map((i) => [
      i.tokenId,
      i.before.mode,
      i.before.ownPermissions,
      i.before.grants.map(grantKey),
      i.after.grants.map((g) => grantKey({ ...g, roleId: Math.max(g.roleId, 0), mpId: g.mpId === null ? null : Math.max(g.mpId, 0) })),
    ]),
  }));
}

/**
 * 64-bit FNV-1a as 16 hex characters: compact and identical in the browser
 * and on the server. Not a security measure — it detects that state changed,
 * and the only party that could craft a collision is an admin who could make
 * the change anyway.
 */
export function hash64(text: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, '0');
}

/** Whether what `c` acts on is in the snapshot (creates: whether the parent is). */
export function targetExists(s: RbacSnapshot, c: RbacChange): boolean {
  switch (c.kind) {
    case 'org.update': case 'org.delete': return s.orgs.some((o) => o.id === c.orgId);
    case 'team.create': return s.orgs.some((o) => o.id === c.orgId);
    case 'team.update': case 'team.delete': case 'role.create': return s.teams.some((t) => t.id === c.teamId);
    case 'role.update': case 'role.delete': case 'mp.create': return s.roles.some((r) => r.id === c.roleId);
    case 'mp.delete': return s.measurementPermissions.some((m) => m.id === c.mpId);
    case 'membership.add': return s.tokens.some((t) => t.id === c.tokenId) && s.teams.some((t) => t.id === c.teamId);
    case 'membership.remove': return (s.memberships[c.tokenId] ?? []).includes(c.teamId);
    case 'org.create': return true;
  }
}

/** Plain-language text for each flag. */
export const IMPACT_TEXT: Record<ImpactFlag, string> = {
  switches_to_rbac: 'Joins RBAC: from now on it can do only what its teams grant; its own permissions stop applying',
  reverts_to_token_permissions: 'Leaves RBAC: it gets its own permissions on every database',
  narrowed_to_measurements: 'A database-wide grant becomes limited to specific measurements',
  widened_to_database: 'A grant limited to measurements now covers the whole database',
  total_denial: 'It will be denied everything',
  no_effect_admin: 'Holds admin, which bypasses RBAC: no effect',
};

// ---------------------------------------------------------------------------
// Change requests from the browser

const KIND_FIELDS: Record<RbacChange['kind'], { ids: string[]; required: string[]; optional: string[] }> = {
  'org.create': { ids: [], required: ['name'], optional: ['description'] },
  'org.update': { ids: ['orgId'], required: [], optional: ['name', 'description'] },
  'org.delete': { ids: ['orgId'], required: [], optional: [] },
  'team.create': { ids: ['orgId'], required: ['name'], optional: ['description'] },
  'team.update': { ids: ['teamId'], required: [], optional: ['name', 'description', 'enabled'] },
  'team.delete': { ids: ['teamId'], required: [], optional: [] },
  'role.create': { ids: ['teamId'], required: ['databasePattern', 'permissions'], optional: [] },
  'role.update': { ids: ['roleId'], required: [], optional: ['databasePattern', 'permissions'] },
  'role.delete': { ids: ['roleId'], required: [], optional: [] },
  'mp.create': { ids: ['roleId'], required: ['measurementPattern', 'permissions'], optional: [] },
  'mp.delete': { ids: ['mpId'], required: [], optional: [] },
  'membership.add': { ids: ['tokenId', 'teamId'], required: [], optional: [] },
  'membership.remove': { ids: ['tokenId', 'teamId'], required: [], optional: [] },
};

/**
 * A change as the browser sent it, checked field by field and rebuilt from
 * known fields only; null for anything else. Value rules are validateChange's.
 */
export function parseChange(raw: unknown): RbacChange | null {
  const o = obj(raw);
  const kind = o?.kind;
  if (!o || typeof kind !== 'string' || !Object.hasOwn(KIND_FIELDS, kind)) return null;
  const spec = KIND_FIELDS[kind as RbacChange['kind']];
  const allowed = new Set(['kind', ...spec.ids, ...spec.required, ...spec.optional]);
  if (Object.keys(o).some((k) => !allowed.has(k))) return null;
  const out: Record<string, unknown> = { kind };
  for (const f of spec.ids) {
    const v = id(o[f]);
    if (!v) return null;
    out[f] = v;
  }
  for (const f of [...spec.required, ...spec.optional]) {
    const v = o[f];
    if (v === undefined) {
      if (spec.required.includes(f)) return null;
      continue;
    }
    if (f === 'permissions') {
      // Only Arc's four permissions, each once; anything else is malformed.
      if (!Array.isArray(v) || v.length > RBAC_PERMISSIONS.length || v.some((p) => !(RBAC_PERMISSIONS as readonly unknown[]).includes(p))) return null;
      out[f] = [...new Set(v as RbacPermission[])];
    } else if (f === 'enabled') {
      if (typeof v !== 'boolean') return null;
      out[f] = v;
    } else {
      if (typeof v !== 'string' || v.length > 2048) return null;
      out[f] = v;
    }
  }
  if ((kind === 'org.create' || kind === 'team.create') && out.description === undefined) out.description = '';
  return out as unknown as RbacChange;
}

// ---------------------------------------------------------------------------
// Text

export function permissionText(p: readonly string[]): string {
  return p.includes('admin') ? 'admin (everything)' : p.join(', ') || 'nothing';
}

/** One sentence saying what a change does, using the names in the snapshot. */
export function describeChange(s: RbacSnapshot, c: RbacChange): string {
  const org = (id: number) => s.orgs.find((o) => o.id === id)?.name ?? `organization ${id}`;
  const team = (id: number) => s.teams.find((t) => t.id === id)?.name ?? s.teamNames[id] ?? `team ${id}`;
  const role = (id: number) => {
    const r = s.roles.find((x) => x.id === id);
    return r ? `the ${r.databasePattern} role of ${team(r.teamId)}` : `role ${id}`;
  };
  const token = (id: number) => s.tokens.find((t) => t.id === id)?.name ?? `token ${id}`;
  switch (c.kind) {
    case 'org.create': return `Create organization ${c.name}.`;
    case 'org.update': return `Update organization ${org(c.orgId)}${c.name && c.name !== org(c.orgId) ? ` (rename to ${c.name})` : ''}.`;
    case 'org.delete': return `Delete organization ${org(c.orgId)} and everything in it.`;
    case 'team.create': return `Create team ${c.name} in ${org(c.orgId)}.`;
    case 'team.update':
      if (c.enabled !== undefined && c.name === undefined && c.description === undefined) return `${c.enabled ? 'Enable' : 'Disable'} team ${team(c.teamId)}.`;
      return `Update team ${team(c.teamId)}${c.name && c.name !== team(c.teamId) ? ` (rename to ${c.name})` : ''}.`;
    case 'team.delete': return `Delete team ${team(c.teamId)}, its roles and its token memberships.`;
    case 'role.create': return `Give ${team(c.teamId)} ${permissionText(c.permissions)} on databases matching ${c.databasePattern}.`;
    case 'role.update': return `Change ${role(c.roleId)}${c.databasePattern ? ` to databases matching ${c.databasePattern}` : ''}${c.permissions ? ` with ${permissionText(c.permissions)}` : ''}.`;
    case 'role.delete': return `Delete ${role(c.roleId)}.`;
    case 'mp.create': return `Limit ${role(c.roleId)}: ${permissionText(c.permissions)} on measurements matching ${c.measurementPattern}.`;
    case 'mp.delete': {
      const m = s.measurementPermissions.find((x) => x.id === c.mpId);
      return m ? `Remove the ${m.measurementPattern} measurement permission from ${role(m.roleId)}.` : `Remove measurement permission ${c.mpId}.`;
    }
    case 'membership.add': return `Add token ${token(c.tokenId)} to team ${team(c.teamId)}.`;
    case 'membership.remove': return `Remove token ${token(c.tokenId)} from team ${team(c.teamId)}.`;
  }
}
