import { json } from '@sveltejs/kit';
import { RbacError, type RbacErrorCode } from './rbacAdmin.js';

const STATUS: Record<RbacErrorCode, number> = {
  invalid: 400,
  not_found: 404,
  stale: 409,
  truncated: 409,
  unlicensed: 403,
  auth_off: 409,
  token_rejected: 502,
  token_not_admin: 502,
  arc_error: 502,
  unreachable: 504,
};

/** An RbacError as `{error: code, message, fields}`; anything else is an internal error without detail. */
export function rbacErrorResponse(err: unknown, instanceId: string, phase: string): Response {
  if (err instanceof RbacError) {
    if (err.code === 'unreachable' || err.code === 'arc_error') {
      console.warn('[access] request failed', { instance_id: instanceId, phase, code: err.code });
    }
    return json({ error: err.code, message: err.message, fields: err.fields }, { status: STATUS[err.code] });
  }
  console.error('[access] unexpected error', { instance_id: instanceId, phase, error: err instanceof Error ? err.message : String(err) });
  return json({ error: 'internal', message: 'Unexpected error' }, { status: 500 });
}
