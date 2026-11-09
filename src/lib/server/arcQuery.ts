/**
 * Reading the answer to an Arc query (POST /api/v1/query) for the alert
 * evaluator and the alert test route. A failed query must never read as "no
 * results": Arc's 429 is query governance (#10), and Launchpad's own token is
 * governed like any other.
 *
 * Free of $env imports so it runs under vitest; the request is
 * arcConnection.queryArc.
 */

import type { SafeResponse } from './ssrf.js';
import { parseJson } from './util.js';

/** Rows, or why there are none. */
export type QueryOutcome = { ok: true; rows: unknown[][] } | { ok: false; error: string };

/** Why Arc refused a query, in words. */
export function queryFailure(status: number, retryAfter: string | string[] | undefined): string {
  if (status === 429) {
    const secs = Number(Array.isArray(retryAfter) ? retryAfter[0] : retryAfter);
    return `Throttled by Arc query governance${Number.isFinite(secs) && secs > 0 ? ` (retry after ${secs}s)` : ''}`;
  }
  return `Arc answered ${status}`;
}

/** Arc answers `{ columns, data: [[…]], … }`; `data` holds the rows. */
export function readQueryResult(res: Pick<SafeResponse, 'status' | 'headers' | 'body'>): QueryOutcome {
  if (res.status < 200 || res.status >= 300) return { ok: false, error: queryFailure(res.status, res.headers['retry-after']) };
  const body = parseJson(res.body.toString('utf8'));
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, error: 'Arc returned an unreadable response' };
  const data = (body as { data?: unknown }).data;
  if (data !== undefined && data !== null && !Array.isArray(data)) return { ok: false, error: 'Arc returned an unreadable response' };
  return { ok: true, rows: ((data ?? []) as unknown[]).filter((r): r is unknown[] => Array.isArray(r)) };
}
