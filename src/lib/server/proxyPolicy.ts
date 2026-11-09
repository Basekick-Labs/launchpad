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
 * Arc routes the proxy refuses even to owners/admins, because the Access tab
 * handles them (#8): RBAC administration and a token's team memberships and
 * effective permissions. The Access tab previews what a change does to every
 * token before it is made and records who made it.
 *
 * This channels access-control changes; it is not a security boundary
 * against owners/admins, who are trusted with the instance: they can still
 * manage tokens through the proxy (including granting Arc `admin`, which
 * bypasses RBAC) and can set the stored token itself. Those token changes
 * are recorded in the change log like every other change.
 *
 * Matched on the canonical path. Arc (Fiber, default config) routes on the
 * raw path without percent-decoding, so an encoded spelling such as
 * `rb%61c` does not reach these routes either.
 */
const ACCESS = 'Arc access control is managed from the Access tab, which previews and records each change';
const BLOCKED: ReadonlyArray<[RegExp, string]> = [
  [/^api\/v1\/rbac(\/|$)/, ACCESS],
  [/^api\/v1\/auth\/tokens\/[^/]+\/(teams|permissions)(\/|$)/, ACCESS],
  [/^api\/v1\/auth\/cache\/invalidate$/, ACCESS],
  // Query governance (#10): Arc keeps it per node, so a change through the
  // load-balanced proxy would land on one random node. The Access tab reads
  // and writes every node.
  [/^api\/v1\/governance(\/|$)/, 'Arc query limits are managed from the Access tab, which applies them to every node'],
];

/** Why the proxy refuses this path for every role, or null. */
export function blockedReason(canonicalPath: string): string | null {
  return BLOCKED.find(([re]) => re.test(canonicalPath))?.[1] ?? null;
}

/**
 * Requests that are data, not configuration: SQL (Arc runs reads over POST)
 * and ingestion/imports. Recording each would bury the changes that matter.
 * Data-changing SQL (DELETE, DDL) is therefore not in the change log.
 */
const UNAUDITED_POST_PREFIXES = ['api/v1/query', 'write', 'api/v1/write', 'api/v2/write', 'api/v1/import'];

/** Whether a proxied request changes Arc's configuration and belongs in the change log. */
export function isAuditedChange(method: string, canonicalPath: string): boolean {
  if (method === 'GET' || method === 'HEAD') return false;
  return !(method === 'POST' && matchesPrefix(canonicalPath, UNAUDITED_POST_PREFIXES));
}

/** Arc routes that accept `dry_run` in the body: a preview, not a change. */
const DRY_RUN_ROUTES = [/^api\/v1\/delete$/, /^api\/v1\/retention\/[^/]+\/execute$/, /^api\/v1\/continuous_queries\/[^/]+\/execute$/];

/** Whether a request body asks one of those routes for a dry run. */
export function isDryRun(canonicalPath: string, body: Uint8Array | null): boolean {
  if (!body || body.length === 0 || body.length > 64 * 1024 || !DRY_RUN_ROUTES.some((re) => re.test(canonicalPath))) return false;
  try {
    return (JSON.parse(Buffer.from(body).toString('utf8')) as { dry_run?: unknown } | null)?.dry_run === true;
  } catch {
    return false;
  }
}

/** A response that means nothing was changed (no such route or method). */
export function isNonChangeStatus(status: number): boolean {
  return status === 404 || status === 405;
}
