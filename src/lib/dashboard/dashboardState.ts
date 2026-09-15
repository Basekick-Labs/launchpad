/**
 * The decisions the dashboard view page makes, separated from its markup.
 *
 * The page is a `.svelte` route and untestable under a node-only vitest, so
 * anything with a judgement in it lives here.
 */

import { serializeForSave, type Dashboard, type Panel } from './model';
import { roleAtLeast, type OrgRole } from '../roles';
import type { PanelResult } from './queryRunner';
import type { RunContext } from './queryRunner';

/**
 * Has the MODEL changed since it was loaded or last saved?
 *
 * Compared through `serializeForSave`, which is what the server uses for its
 * own no-op check — so client and server agree about what "changed" means
 * rather than drifting.
 *
 * `serializeForSave` throws on an over-deep document, and a bare reactive
 * statement that throws takes the render down. A throw is treated as dirty:
 * refusing to let the user save would be worse than offering a save that then
 * fails validation with a real message.
 */
export function isDirty(model: Dashboard, baseline: string): boolean {
  try {
    return serializeForSave(model) !== baseline;
  } catch {
    return true;
  }
}

/** The baseline to compare against. Always the SERVER's version — see below. */
export function baselineOf(model: Dashboard): string {
  try {
    return serializeForSave(model);
  } catch {
    return '';
  }
}

/**
 * May this user save this dashboard?
 *
 * Mirrors the API exactly: member-and-above, AND either the author or an admin.
 * Gating on `role !== 'viewer'` alone offers a plain member a Save button that
 * 403s on a colleague's dashboard — the list page already carries this same
 * predicate for the same reason.
 *
 * This is presentation. The API enforces it independently.
 */
export function canSave(
  role: OrgRole | null,
  createdBy: string | null,
  userId: string,
): boolean {
  if (role === null || !roleAtLeast(role, 'member')) return false;
  return createdBy === userId || roleAtLeast(role, 'admin');
}

/**
 * Stores a panel result, or decides to drop it.
 *
 * The order matters and both guards are needed:
 *
 * - A CANCELLED result must never be stored. The runner reports a superseded
 *   run as `status: 'idle'`, and `panelView` would paint "this panel has no
 *   query" over a working chart. `isCurrent` alone does not catch it, because a
 *   cancelled run whose panel was not re-run is still the current generation.
 * - A STALE result must never overwrite a fresh one. Two runs can be in flight
 *   for one panel when a range change overtakes a refresh tick.
 *
 * Returns the same object when nothing should change, so a caller can skip the
 * reassignment and avoid a render.
 */
export function applyResult(
  results: Readonly<Record<string, PanelResult>>,
  result: PanelResult,
  isCurrent: (panelId: string, generation: number) => boolean,
): Record<string, PanelResult> {
  if (result.cancelled) return results as Record<string, PanelResult>;
  if (!isCurrent(result.panelId, result.generation)) {
    return results as Record<string, PanelResult>;
  }
  return { ...results, [result.panelId]: result };
}

/**
 * The context every panel in one tick shares.
 *
 * Built ONCE per tick and retained: a panel-scoped re-run — a manual refresh, a
 * resize, a panel scrolling into view — must reuse it rather than resolving the
 * range again. Re-resolving moves `now`, which moves that panel's cache key away
 * from every other panel's, so dedupe and the cache go inert for it. That is the
 * exact failure the runner's `from`/`to` contract exists to prevent.
 */
export function buildRunContext(args: {
  orgId: string;
  from: number;
  to: number;
  timezone: string;
  minInterval?: string;
}): RunContext {
  return {
    orgId: args.orgId,
    from: args.from,
    to: args.to,
    timezone: args.timezone,
    minInterval: args.minInterval,
  };
}

/**
 * The panel to show fullscreen, or null.
 *
 * Validated against the dashboard rather than trusted: a stale link naming a
 * deleted panel would otherwise render a blank page instead of the dashboard.
 */
export function resolveViewPanel(panels: readonly Panel[], id: string | null): Panel | null {
  if (!id) return null;
  return panels.find((p) => p.id === id) ?? null;
}
