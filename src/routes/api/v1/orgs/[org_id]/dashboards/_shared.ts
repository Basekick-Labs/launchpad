/**
 * Shared request handling for the dashboard routes.
 *
 * Every library in this feature throws typed errors; this maps them to the
 * `json({ error })` envelope every other route in the repo returns. SvelteKit's
 * `error()` helper produces `{ message }` instead, and two envelope shapes in
 * one API means every client writes `err.error ?? err.message` and forgets.
 */

import { json } from '@sveltejs/kit';
import { AccessError } from '$lib/server/orgAccess';
import { DashboardNotFoundError, VersionConflictError } from '$lib/server/dashboards';
import { InstanceNotInOrgError } from '$lib/server/dashboardInstance';
import { BadBodyError, BodyTooLargeError } from '$lib/server/util';

/**
 * Map a thrown library error to a response.
 *
 * Anything unrecognised is re-thrown rather than swallowed into a 500 body:
 * better-sqlite3 messages carry table and column names
 * (`UNIQUE constraint failed: dashboards.uid`) and must never be echoed.
 */
export function toErrorResponse(err: unknown): Response {
  if (err instanceof AccessError) return json({ error: err.message }, { status: err.status });
  if (err instanceof DashboardNotFoundError) return json({ error: err.message }, { status: 404 });
  if (err instanceof VersionConflictError) {
    // currentVersion is in the body so a save-conflict dialog can offer more
    // than "someone changed this, reload".
    return json(
      { error: 'Dashboard was modified by someone else', currentVersion: err.currentVersion },
      { status: 409 },
    );
  }
  if (err instanceof InstanceNotInOrgError) return json({ error: err.message }, { status: 400 });
  if (err instanceof BodyTooLargeError) return json({ error: err.message }, { status: 413 });
  if (err instanceof BadBodyError) return json({ error: err.message }, { status: 400 });
  throw err;
}

/**
 * Parse a path segment that must be a positive integer.
 *
 * `params.version` is a string, and SQLite does not coerce across storage
 * classes: binding `'3'` against an INTEGER column matches nothing, so every
 * restore would silently 404. `Number('1e3')` is 1000 and `parseInt('7abc')` is
 * 7, so the shape is checked before the conversion.
 */
export function parseVersionParam(raw: string | undefined): number {
  if (typeof raw !== 'string' || !/^\d{1,9}$/.test(raw)) return Number.NaN;
  const value = Number(raw);
  return value >= 1 ? value : Number.NaN;
}
