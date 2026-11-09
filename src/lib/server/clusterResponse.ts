import { json } from '@sveltejs/kit';
import { ClusterError } from './clusterNodes.js';
import type { ClusterErrorCode } from '../cluster.js';

/** HTTP status for each failure; upstream problems are gateway errors. */
const STATUS: Record<ClusterErrorCode, number> = {
  not_found: 404,
  standalone: 409,
  bad_address: 502,
  address_blocked: 502,
  identity_mismatch: 502,
  tls_error: 502,
  token_rejected: 502,
  token_not_admin: 502,
  upstream_status: 502,
  unreachable: 504,
  internal: 500,
};

/** A ClusterError as `{error: code, message}`; anything else is an internal error without detail. */
export function clusterErrorResponse(err: unknown): Response {
  if (err instanceof ClusterError) {
    return json({ error: err.code, message: err.message }, { status: STATUS[err.code] });
  }
  console.error('[cluster] unexpected error', { error: err instanceof Error ? err.message : String(err) });
  return json({ error: 'internal', message: 'Unexpected error' }, { status: 500 });
}
