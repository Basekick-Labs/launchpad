// Connection helpers for talking to an existing (external) Arc server.
// On-prem, an "instance" is a stored connection — a base URL + admin token —
// not a provisioned Kubernetes deployment.

import { env } from '$env/dynamic/private';
import { isSafeUrl, safeRequest, type SafeResponse } from './ssrf.js';

/**
 * Whether operators have opted into pointing instances at private/internal
 * addresses. Self-hosted Arc frequently runs on the same private network
 * (10.x, *.internal, localhost), so this is off by default (secure) but can
 * be enabled with LAUNCHPAD_ALLOW_PRIVATE_ENDPOINTS=true.
 */
export function allowPrivateEndpoints(): boolean {
  return env.LAUNCHPAD_ALLOW_PRIVATE_ENDPOINTS === 'true';
}

/** Error thrown when an endpoint is well-formed but blocked for being private. */
export class PrivateEndpointBlockedError extends Error {
  constructor() {
    super(
      'This looks like a private, localhost, or link-local address, which is blocked by default. ' +
        'If your Arc server is on a private network reachable from the Launchpad host, set ' +
        'LAUNCHPAD_ALLOW_PRIVATE_ENDPOINTS=true on the Launchpad server to allow it.',
    );
    this.name = 'PrivateEndpointBlockedError';
  }
}

/**
 * Normalize a user-supplied Arc URL: trim, add scheme if missing, strip
 * trailing slash. Returns null when the URL is malformed or uses a non-http(s)
 * scheme. Throws {@link PrivateEndpointBlockedError} when the URL is otherwise
 * valid but points at a private/link-local/metadata address and
 * LAUNCHPAD_ALLOW_PRIVATE_ENDPOINTS is not enabled — so callers can surface a
 * specific, actionable message instead of a generic "invalid URL".
 */
export function normalizeEndpointUrl(raw: string): string | null {
  const trimmed = (raw || '').trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  // Block private/metadata targets unless operators opted in. isSafeUrl also
  // rejects localhost/.internal/.local and private IP literals.
  if (!allowPrivateEndpoints() && !isSafeUrl(withScheme, { allowHttp: true })) {
    throw new PrivateEndpointBlockedError();
  }
  // Drop any path/query/hash — we proxy paths ourselves.
  return `${u.protocol}//${u.host}`;
}

/** Public-facing URL of an instance — simply its endpoint_url. */
export function getInstanceUrl(endpointUrl: string | null | undefined): string | null {
  return endpointUrl ?? null;
}

/**
 * Run a SQL query against an Arc instance's query API using its admin token,
 * DNS-pinned via safeRequest (SSRF/rebinding-safe). Shared by the alert
 * evaluator background job and the alert-test route. Response is capped at 1 MB.
 */
export function queryArc(endpointUrl: string, adminToken: string, sql: string): Promise<SafeResponse> {
  const body = JSON.stringify({ sql });
  return safeRequest(`${endpointUrl.replace(/\/+$/, '')}/api/v1/query`, {
    allowHttp: true,
    allowPrivate: allowPrivateEndpoints(),
    method: 'POST',
    body,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      Authorization: `Bearer ${adminToken}`,
    },
    timeoutMs: 15_000,
    maxResponseBytes: 1024 * 1024,
  });
}

/**
 * Ping an Arc server's health endpoint. Returns 'running' if reachable and
 * healthy, otherwise 'unreachable'. Best-effort, never throws.
 */
export async function checkArcHealth(endpointUrl: string | null | undefined, adminToken?: string | null): Promise<'running' | 'unreachable'> {
  try {
    // normalizeEndpointUrl throws for private endpoints when the opt-in is off;
    // for a best-effort health probe that just means "unreachable".
    const base = normalizeEndpointUrl(endpointUrl || '');
    if (!base) return 'unreachable';
    const headers: Record<string, string> = {};
    if (adminToken) headers['authorization'] = `Bearer ${adminToken}`;
    // Route through the DNS-pinned SSRF guard so the admin token is never sent
    // to a rebinding/private target (honors the private-endpoint opt-in).
    const res = await safeRequest(`${base}/health`, {
      allowHttp: true,
      allowPrivate: allowPrivateEndpoints(),
      headers,
      timeoutMs: 5000,
      maxResponseBytes: 64 * 1024,
    });
    return res.status >= 200 && res.status < 300 ? 'running' : 'unreachable';
  } catch {
    return 'unreachable';
  }
}
