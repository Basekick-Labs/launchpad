import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { allowPrivateEndpoints } from '$lib/server/arcConnection';
import { requireInstanceRole } from '$lib/server/orgAccess';
import { applyRbacChange, getRbacSnapshot } from '$lib/server/rbacAdmin';
import { rbacErrorResponse } from '$lib/server/rbacResponse';
import { readBoundedJsonBody } from '$lib/server/util';
import { parseChange } from '$lib/rbac';

/** A change request is a handful of fields plus a 16-character fingerprint. */
const MAX_BODY_BYTES = 16 * 1024;

/** Arc RBAC tree and token memberships (#8). Owner/admin. */
export const GET: RequestHandler = async ({ locals, params }) => {
  const access = requireInstanceRole(locals.user, params.org_id, params.id, 'admin');
  if (access instanceof Response) return access;
  try {
    return json(await getRbacSnapshot(access.instance, { allowPrivate: allowPrivateEndpoints() }), {
      headers: { 'cache-control': 'no-store' },
    });
  } catch (err) {
    return rbacErrorResponse(err, access.instance.id, 'snapshot');
  }
};

/**
 * Apply one change: `{ change, fingerprint }`, where fingerprint is what the
 * admin's preview was computed from. Owner/admin. Recorded in the change log.
 */
export const POST: RequestHandler = async ({ locals, params, request }) => {
  const access = requireInstanceRole(locals.user, params.org_id, params.id, 'admin');
  if (access instanceof Response) return access;
  // Bounded and content-type checked (413/415/400 on a bad body).
  const body = (await readBoundedJsonBody(request, MAX_BODY_BYTES)) as { change?: unknown; fingerprint?: unknown } | null;
  const change = parseChange(body?.change);
  if (!change || typeof body?.fingerprint !== 'string' || !/^[0-9a-f]{16}$/.test(body.fingerprint)) {
    return json({ error: 'invalid', message: 'Unknown or malformed change' }, { status: 400 });
  }
  try {
    const outcome = await applyRbacChange(
      access.instance,
      { allowPrivate: allowPrivateEndpoints(), signal: request.signal },
      locals.user!.id,
      change,
      body.fingerprint,
    );
    return json(outcome, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    return rbacErrorResponse(err, access.instance.id, change.kind);
  }
};
