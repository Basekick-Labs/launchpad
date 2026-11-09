import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { allowPrivateEndpoints } from '$lib/server/arcConnection';
import { requireInstanceRole } from '$lib/server/orgAccess';
import { applyRbacChange, getRbacSnapshot, RbacError, type RbacErrorCode } from '$lib/server/rbacAdmin';
import { parseChange } from '$lib/rbac';

const STATUS: Record<RbacErrorCode, number> = {
  invalid: 400,
  not_found: 404,
  stale: 409,
  unlicensed: 403,
  auth_off: 409,
  token_rejected: 502,
  token_not_admin: 502,
  arc_error: 502,
  unreachable: 504,
};

function failure(err: unknown): Response {
  if (err instanceof RbacError) {
    return json({ error: err.code, message: err.message, fields: err.fields }, { status: STATUS[err.code] });
  }
  console.error('[access] unexpected error', { error: err instanceof Error ? err.message : String(err) });
  return json({ error: 'internal', message: 'Unexpected error' }, { status: 500 });
}

/** Arc RBAC tree and token memberships (#8). Owner/admin. */
export const GET: RequestHandler = async ({ locals, params }) => {
  const access = requireInstanceRole(locals.user, params.org_id, params.id, 'admin');
  if (access instanceof Response) return access;
  try {
    return json(await getRbacSnapshot(access.instance, { allowPrivate: allowPrivateEndpoints() }), {
      headers: { 'cache-control': 'no-store' },
    });
  } catch (err) {
    return failure(err);
  }
};

/**
 * Apply one change: `{ change, fingerprint }`, where fingerprint is what the
 * admin's preview was computed from. Owner/admin. Recorded in the change log.
 */
export const POST: RequestHandler = async ({ locals, params, request }) => {
  const access = requireInstanceRole(locals.user, params.org_id, params.id, 'admin');
  if (access instanceof Response) return access;
  let body: { change?: unknown; fingerprint?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid', message: 'Request body must be JSON' }, { status: 400 });
  }
  const change = parseChange(body?.change);
  if (!change || typeof body.fingerprint !== 'string' || body.fingerprint.length > 1_000_000) {
    return json({ error: 'invalid', message: 'Unknown or malformed change' }, { status: 400 });
  }
  try {
    const outcome = await applyRbacChange(access.instance, { allowPrivate: allowPrivateEndpoints() }, locals.user!.id, change, body.fingerprint);
    return json(outcome);
  } catch (err) {
    return failure(err);
  }
};
