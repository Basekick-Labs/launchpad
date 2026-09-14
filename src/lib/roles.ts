/**
 * Organization roles and the scope brand.
 *
 * Isomorphic on purpose: the Team page renders role names, and the ordering is
 * currently duplicated across three route files plus a Svelte component.
 */

export const ORG_ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

/** Higher is more privileged. Used only through {@link roleAtLeast}. */
const RANK: Record<OrgRole, number> = {
  owner: 4,
  admin: 3,
  member: 2,
  viewer: 1,
};

/**
 * True when `role` is at least as privileged as `minRole`.
 *
 * An unrecognised role is rejected EXPLICITLY rather than by comparing ranks.
 * The natural spelling — `RANK[role] < RANK[minRole]` — evaluates to
 * `undefined < 2`, which is `false`, so an unknown role would be ALLOWED. That
 * version reads identically to this one in review, which is why the check is
 * written out rather than inlined at call sites.
 */
export function roleAtLeast(role: string, minRole: OrgRole): boolean {
  const rank = RANK[role as OrgRole];
  if (rank === undefined) return false;
  return rank >= RANK[minRole];
}

export function isOrgRole(value: unknown): value is OrgRole {
  return typeof value === 'string' && (ORG_ROLES as readonly string[]).includes(value);
}

/**
 * An org id that has been through an access check.
 *
 * The brand exists so a store function cannot be handed a raw `params.org_id`:
 * only `requireOrgRole` produces an `OrgScope`, so passing an unchecked string
 * is a compile error rather than a silent cross-tenant read. It is erased at
 * runtime — an `OrgScope` IS the org id string.
 *
 * ```ts
 * getDashboard(params.org_id, uid);   // compile error
 * const { orgId } = requireOrgRole(locals, params.org_id, 'viewer');
 * getDashboard(orgId, uid);           // ok
 * ```
 */
export type OrgScope = string & { readonly __orgScoped: unique symbol };
