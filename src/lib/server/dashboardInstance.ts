/**
 * Org-scoped instance resolution for dashboards.
 *
 * This is the ONLY sanctioned way a dashboard path may turn an instance id into
 * an endpoint or a credential.
 *
 * **Do not use `getInstance` from `./instance` here.** It looks up by id with
 * no `org_id` predicate, which is fine where the id came from a verified route
 * param and catastrophic where it came from a request body — which is what
 * every id in a dashboard model is. `alertEvaluator.ts` is the standing example
 * of the unscoped join this file exists to avoid.
 *
 * The type-only import below is also deliberate: `instance.ts` reaches
 * `$env/dynamic/private` through `auth.ts`, so importing any runtime symbol
 * from it makes this module unloadable under vitest.
 *
 * **The credential is separated from the endpoint on purpose.** The row behind
 * an instance carries `admin_token`, and a helper returning it is one `return`
 * away from a `+page.server.ts` serializing the Arc admin token into HTML that
 * any viewer can read. {@link resolveTargetInstance} returns only what is safe
 * to send to a browser; {@link resolveTargetCredential} is for the fetch call
 * site and its result must never cross a `load` or `json()` boundary.
 */

import { getDb } from './db';
import { isInstanceRef, type Dashboard, type Panel, type Target } from '$lib/dashboard/model';
import type { OrgScope } from '$lib/roles';

/**
 * An instance reference could not be resolved within the org.
 *
 * Never names the offending id: an error naming it confirms which of several
 * guessed ids exists elsewhere, and puts it in the toast and the server log.
 *
 * `path` is only meaningful when the caller actually knows which reference
 * failed — `resolveTargetInstance` does, `assertInstancesInOrg` does not
 * (the validator hands it a deduplicated id set with the paths already
 * discarded), so that one passes null and gets the generic message rather
 * than a misleading one.
 */
export class InstanceNotInOrgError extends Error {
  constructor(readonly path: string | null) {
    super(
      path
        ? `Instance referenced at ${path} is not available in this organization`
        : 'A referenced instance is not available in this organization',
    );
    this.name = 'InstanceNotInOrgError';
  }
}

/** Safe to serialize: no credential. */
export interface ResolvedInstance {
  id: string;
  endpointUrl: string | null;
}

/** NEVER serialize. For the fetch call site only. */
export interface ResolvedCredential {
  id: string;
  endpointUrl: string | null;
  adminToken: string | null;
}

/**
 * Assert every literal instance id a document references belongs to this org.
 *
 * Takes `referencedInstanceIds` from `validateDashboard`, which walks all four
 * levels — dashboard, panel, target and variable — so a caller cannot authorize
 * the dashboard-level id and miss the overrides.
 *
 * One query rather than one per id: an id-at-a-time loop that throws on the
 * first failure is an incremental existence oracle.
 *
 * NOTE this authorizes nothing for a fully templated dashboard, where every
 * reference is a `$variable` and the array is empty by design. Those are
 * authorized at execution time by {@link resolveTargetInstance}, which is why
 * that function does the variable dereference itself.
 */
export function assertInstancesInOrg(orgId: OrgScope, ids: readonly string[]): void {
  if (ids.length === 0) return;
  const db = getDb();
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT id FROM instances
        WHERE org_id = ? AND deleted_at IS NULL AND id IN (${placeholders})`,
    )
    .all(orgId, ...ids) as Array<{ id: string }>;
  const found = new Set(rows.map((r) => r.id));
  for (const id of ids) {
    if (!found.has(id)) throw new InstanceNotInOrgError(null);
  }
}

/**
 * Resolve the instance a target should query, dereferencing a `$variable`
 * against the dashboard's declared variables and the caller's selection.
 *
 * The dereference happens HERE rather than in the caller. If callers resolved
 * `$instance` themselves they would hold a raw id and reach for a lookup
 * without the org predicate — which is exactly how `alertEvaluator` came to
 * query instances with no `org_id` at all.
 *
 * `varValues` is client-controlled (it arrives as `?var-instance=...`), so a
 * reference is only honoured when it names a variable the dashboard actually
 * declares as `type: 'instance'`. Otherwise `?var-anything=<id>` would reach an
 * instance the dashboard never mentioned.
 */
export function resolveTargetInstance(
  orgId: OrgScope,
  dashboard: Dashboard,
  panel: Panel | null,
  target: Target | null,
  varValues: Readonly<Record<string, string>> = {},
): ResolvedInstance {
  const { id, path } = resolveId(dashboard, panel, target, varValues);
  const db = getDb();
  const row = db
    .prepare(
      'SELECT id, endpoint_url FROM instances WHERE id = ? AND org_id = ? AND deleted_at IS NULL',
    )
    .get(id, orgId) as { id: string; endpoint_url: string | null } | undefined;
  if (!row) throw new InstanceNotInOrgError(path);
  return { id: row.id, endpointUrl: row.endpoint_url };
}

/**
 * As {@link resolveTargetInstance}, but including the Arc admin token.
 *
 * The result must not be returned from a `load`, put in a `json()` response, or
 * stored anywhere that is later serialized. Read it at the point of the
 * outbound request and let it go.
 */
export function resolveTargetCredential(
  orgId: OrgScope,
  dashboard: Dashboard,
  panel: Panel | null,
  target: Target | null,
  varValues: Readonly<Record<string, string>> = {},
): ResolvedCredential {
  const { id, path } = resolveId(dashboard, panel, target, varValues);
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, endpoint_url, admin_token FROM instances
        WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
    )
    .get(id, orgId) as
    | { id: string; endpoint_url: string | null; admin_token: string | null }
    | undefined;
  if (!row) throw new InstanceNotInOrgError(path);
  return { id: row.id, endpointUrl: row.endpoint_url, adminToken: row.admin_token };
}

/** target -> panel -> dashboard precedence, with `$variable` dereferenced. */
function resolveId(
  dashboard: Dashboard,
  panel: Panel | null,
  target: Target | null,
  varValues: Readonly<Record<string, string>>,
): { id: string; path: string } {
  const candidates: Array<[string | null | undefined, string]> = [
    [target?.instanceId, 'target.instanceId'],
    [panel?.instanceId, 'panel.instanceId'],
    [dashboard.instanceId, 'instanceId'],
  ];

  for (const [raw, path] of candidates) {
    if (!raw) continue;
    if (!isInstanceRef(raw)) return { id: raw, path };

    const name = raw.slice(1);
    const declared = dashboard.variables.find((v) => v.name === name && v.type === 'instance');
    if (!declared) throw new InstanceNotInOrgError(path);
    const selected = varValues[name];
    if (!selected) throw new InstanceNotInOrgError(path);
    // The selected value is raw client input, and it goes into the same
    // org-predicated query as any literal id. It gets no more trust for having
    // arrived through a variable.
    return { id: selected, path };
  }

  // Saving an unset instance is legal (see Dashboard.instanceId); executing a
  // query against one is not. This is where that distinction is enforced.
  throw new InstanceNotInOrgError('instanceId');
}
