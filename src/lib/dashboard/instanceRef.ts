/**
 * Which Arc instance a target queries: `target -> panel -> dashboard`
 * precedence, with a `$variable` reference dereferenced.
 *
 * Extracted from `$lib/server/dashboardInstance` so the server resolver and the
 * client query runner share ONE implementation. They must agree: the server
 * decides which instance a saved query may touch, and the client decides which
 * instance URL to POST to. Two copies of this precedence would diverge, and the
 * direction of the divergence is a panel that validates against one instance and
 * executes against another.
 *
 * This module is deliberately framework-neutral and returns a result rather than
 * throwing, because the two callers need different failures: the server raises
 * `InstanceNotInOrgError` with the field path for its audit trail, the client
 * shows the panel an error.
 *
 * ## It resolves an id. It does NOT authorize one.
 *
 * Every level of this precedence is request-body data with no provenance
 * (`model.ts` invariant 3), and a value arriving through a variable gets no more
 * trust for having done so. The id this returns is a CLAIM:
 *
 *   - server-side, `resolveTargetInstance` re-queries `WHERE id = ? AND org_id = ?`
 *   - client-side, the instance proxy enforces the same predicate and 404s
 *
 * Never use this result to build an Arc URL or read a token without one of those
 * checks in between.
 */

import { isInstanceRef, type Dashboard, type Panel, type Target } from './model';

/** Which field supplied the id, for error messages and audit. */
export type InstanceRefPath = 'target.instanceId' | 'panel.instanceId' | 'instanceId';

export type InstanceRefFailure =
  /** No level set one. Saving an unset instance is legal; executing is not. */
  | 'unset'
  /** `$foo` with no matching `type: 'instance'` variable declared. */
  | 'undeclared_variable'
  /** Declared, but nothing selected for it yet. */
  | 'unselected_variable';

export type InstanceRefResult =
  | { ok: true; id: string; path: InstanceRefPath }
  | { ok: false; path: InstanceRefPath; reason: InstanceRefFailure };

/**
 * `target -> panel -> dashboard` precedence, with `$variable` dereferenced
 * against the dashboard's declared `instance` variables.
 */
export function resolveInstanceRef(
  dashboard: Dashboard,
  panel: Panel | null,
  target: Target | null,
  varValues: Readonly<Record<string, string>> = {},
): InstanceRefResult {
  const candidates: Array<[string | null | undefined, InstanceRefPath]> = [
    [target?.instanceId, 'target.instanceId'],
    [panel?.instanceId, 'panel.instanceId'],
    [dashboard.instanceId, 'instanceId'],
  ];

  for (const [raw, path] of candidates) {
    if (!raw) continue;
    if (!isInstanceRef(raw)) return { ok: true, id: raw, path };

    const name = raw.slice(1);
    const declared = dashboard.variables.find((v) => v.name === name && v.type === 'instance');
    if (!declared) return { ok: false, path, reason: 'undeclared_variable' };
    const selected = varValues[name];
    if (!selected) return { ok: false, path, reason: 'unselected_variable' };
    return { ok: true, id: selected, path };
  }

  return { ok: false, path: 'instanceId', reason: 'unset' };
}
