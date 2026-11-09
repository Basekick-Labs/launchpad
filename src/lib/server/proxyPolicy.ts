/**
 * Access rules for the Arc proxy (src/routes/api/v1/orgs/[org_id]/instances/
 * [id]/proxy/[...path]/+server.ts), kept here so they are unit tested.
 */

// Read-only Arc endpoints a plain org `member`/`viewer` may reach through the
// proxy with a safe (GET/HEAD) method. This is a DEFAULT-CLOSED allowlist: any
// path not matched here — every mutating verb, and every admin route (delete,
// rbac, backup, mqtt, retention, tokens, logs, …) — requires owner/admin. That
// way a newly-added Arc admin route is locked down by default instead of being
// viewer-reachable until someone remembers to blocklist it.
//
// IMPORTANT: each entry must correspond to a route Arc itself serves WITHOUT
// `withAdminAuth`/`adminAuth`. Because the proxy injects the instance admin
// token, Arc's own auth won't stop a member here — this list is the only gate.
// Verified against Arc: GET databases, GET databases/:name and GET
// databases/:name/measurements (readAuth, and a per-database read check when
// the server restricts reads per database), POST query + GET measurements
// (readAuth), GET metrics* (no admin). `/api/v1/logs` is deliberately
// EXCLUDED — Arc guards it with withAdminAuth (it leaks SQL, internal IPs,
// and tokens), so it must remain owner/admin-only here too.
//
// Arc's three database listing routes previously carried NO middleware at
// all; they now require read permission. That does not change this list —
// readAuth is not adminAuth, so they stay member-reachable — but it does
// change what a member can get back. The proxy forwards the instance's
// stored token, so Arc answers with that token's reach: no stored token is
// now a 401 where it used to be a 200, and a token Arc restricts to
// particular databases gets a 403 on the list-everything route rather than a
// filtered list (Arc refuses rather than filtering, matching SHOW
// DATABASES). Both pass through to the caller with their own status and body
// — see the non-2xx passthrough tests in `arcProxy.test.ts` — so a caller
// can tell "re-authenticate" from "you are scoped, name a database" from
// "no such database".
const MEMBER_READ_PREFIXES = [
  'api/v1/query',        // SQL reads (Arc uses POST for query — see below)
  'api/v1/databases',    // GET list/get/measurements (readAuth); POST create is adminAuth (blocked by method gate)
  'api/v1/measurements',
  'api/v1/metrics',
  'api/v1/health',
  'health',
];

// Arc runs its query engine over POST /api/v1/query, so that one read path must
// allow POST for members; every other read path is GET/HEAD only.
const MEMBER_POST_PREFIXES = ['api/v1/query'];

/**
 * Canonicalize a proxied path the way the upstream Arc server (fasthttp) will
 * before routing: strip leading slashes, collapse repeated slashes, resolve
 * `.`/`..` segments, lowercase. Gating on this prevents a spelling like
 * `api/v1//mqtt` or `api/v1/./mqtt` from passing the gate while Arc normalizes
 * it back to the admin route.
 */
export function canonicalizePath(path: string): string {
  const raw = path.replace(/^\/+/, '').toLowerCase();
  const out: string[] = [];
  for (const seg of raw.split('/')) {
    if (seg === '' || seg === '.') continue; // collapse // and /./
    if (seg === '..') { out.pop(); continue; } // resolve /../
    out.push(seg);
  }
  return out.join('/');
}

function matchesPrefix(path: string, prefixes: string[]): boolean {
  return prefixes.some((p) => path === p || path.startsWith(p + '/'));
}

/**
 * True if a plain member (non owner/admin) is allowed to make this request.
 * Members get read-only access to the query/read endpoints; everything else
 * (all mutations, all admin routes) is owner/admin only.
 */
export function isMemberAllowed(method: string, canonicalPath: string): boolean {
  const isRead = method === 'GET' || method === 'HEAD';
  if (isRead && matchesPrefix(canonicalPath, MEMBER_READ_PREFIXES)) return true;
  if (method === 'POST' && matchesPrefix(canonicalPath, MEMBER_POST_PREFIXES)) return true;
  return false;
}

/**
 * Arc routes the proxy refuses even to owners/admins, because Launchpad has
 * an audited place for them instead (#8): RBAC administration and a token's
 * team memberships and effective permissions. Changing who can read what in
 * Arc must leave a record of which Launchpad user did it; through the proxy
 * Arc would only ever see the instance's shared admin token.
 */
const BLOCKED_PATTERNS: readonly RegExp[] = [
  /^api\/v1\/rbac(\/|$)/,
  /^api\/v1\/auth\/tokens\/[^/]+\/(teams|permissions)(\/|$)/,
  /^api\/v1\/auth\/cache\/invalidate$/,
];

/** Why the proxy refuses this path for every role, or null. */
export function blockedReason(canonicalPath: string): string | null {
  return BLOCKED_PATTERNS.some((re) => re.test(canonicalPath))
    ? 'Arc access control is managed from the Access tab, which records who made each change'
    : null;
}

/**
 * Whether a proxied request changes something in Arc and so belongs in the
 * instance change log. Reads are not recorded, and neither are SQL queries:
 * Arc runs them over POST, they do not change configuration, and recording
 * every one would bury the changes that matter.
 */
export function isAuditedChange(method: string, canonicalPath: string): boolean {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false;
  return !matchesPrefix(canonicalPath, ['api/v1/query']);
}
