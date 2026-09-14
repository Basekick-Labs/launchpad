import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type http from 'node:http';
import { dev } from '$app/environment';
import { getDb } from '$lib/server/db';
import { getInstance } from '$lib/server/instance';
import { allowPrivateEndpoints } from '$lib/server/arcConnection';
import { assertSafeResolvedUrl, type ResolvedTarget } from '$lib/server/ssrf';
import { streamUpstreamWithFallback, ResponseTooLargeError } from '$lib/server/arcProxy';

// Only these response headers from the upstream Arc server are forwarded back
// to the browser. Everything else is dropped so a malicious/compromised
// upstream can't set cookies, redirect, relax CORS/CSP, or (via a spoofed
// Content-Type) turn a proxied response into script executing on our origin.
const ALLOWED_RESPONSE_HEADERS = new Set([
  'content-type',
  'content-length',
  'content-encoding',
  'cache-control',
  'etag',
  'last-modified',
  'date',
]);

// Read-only Arc endpoints a plain org `member`/`viewer` may reach through the
// proxy with a safe (GET/HEAD) method. This is a DEFAULT-CLOSED allowlist: any
// path not matched here — every mutating verb, and every admin route (delete,
// rbac, backup, mqtt, retention, tokens, logs, …) — requires owner/admin. That
// way a newly-added Arc admin route is locked down by default instead of being
// viewer-reachable until someone remembers to blocklist it.
//
// IMPORTANT: each entry must correspond to a route Arc itself serves WITHOUT
// `withAdminAuth`/`adminAuth`. Because the proxy injects the instance admin
// token, Arc's own auth won't stop a member here — this list is the only gate.
// Verified against Arc: GET databases (handleList, no admin), POST query +
// GET measurements (readAuth), GET metrics* (no admin). `/api/v1/logs` is
// deliberately EXCLUDED — Arc guards it with withAdminAuth (it leaks SQL,
// internal IPs, and tokens), so it must remain owner/admin-only here too.
const MEMBER_READ_PREFIXES = [
  'api/v1/query',        // SQL reads (Arc uses POST for query — see below)
  'api/v1/databases',    // GET list only; POST create is adminAuth (blocked by method gate)
  'api/v1/measurements',
  'api/v1/metrics',
  'api/v1/health',
  'health',
];

// Arc runs its query engine over POST /api/v1/query, so that one read path must
// allow POST for members; every other read path is GET/HEAD only.
const MEMBER_POST_PREFIXES = ['api/v1/query'];

/**
 * Canonicalize a proxied path the way the upstream Arc server (fasthttp) will
 * before routing: strip leading slashes, collapse repeated slashes, resolve
 * `.`/`..` segments, lowercase. Gating on this prevents a spelling like
 * `api/v1//mqtt` or `api/v1/./mqtt` from passing the gate while Arc normalizes
 * it back to the admin route.
 */
function canonicalizePath(path: string): string {
  const raw = path.replace(/^\/+/, '').toLowerCase();
  const out: string[] = [];
  for (const seg of raw.split('/')) {
    if (seg === '' || seg === '.') continue; // collapse // and /./
    if (seg === '..') { out.pop(); continue; } // resolve /../
    out.push(seg);
  }
  return out.join('/');
}

function matchesPrefix(path: string, prefixes: string[]): boolean {
  return prefixes.some((p) => path === p || path.startsWith(p + '/'));
}

/**
 * True if a plain member (non owner/admin) is allowed to make this request.
 * Members get read-only access to the query/read endpoints; everything else
 * (all mutations, all admin routes) is owner/admin only.
 */
function isMemberAllowed(method: string, canonicalPath: string): boolean {
  const isRead = method === 'GET' || method === 'HEAD';
  if (isRead && matchesPrefix(canonicalPath, MEMBER_READ_PREFIXES)) return true;
  if (method === 'POST' && matchesPrefix(canonicalPath, MEMBER_POST_PREFIXES)) return true;
  return false;
}

/** Applies the response allowlist to the upstream's raw headers. */
function filterResponseHeaders(raw: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value && ALLOWED_RESPONSE_HEADERS.has(key.toLowerCase())) {
      out[key] = Array.isArray(value) ? value.join(', ') : value;
    }
  }
  return out;
}

async function proxyRequest(request: Request, params: { org_id: string; id: string; path: string }, locals: App.Locals) {
  if (!locals.user) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Reject path traversal attempts
  if (params.path.includes('..') || params.path.includes('\\')) {
    return json({ error: 'Invalid path' }, { status: 400 });
  }
  const decodedPath = decodeURIComponent(params.path);
  if (decodedPath.includes('..') || decodedPath.includes('\\')) {
    return json({ error: 'Invalid path' }, { status: 400 });
  }

  const db = getDb();
  const membership = db.prepare(
    'SELECT role FROM org_members WHERE org_id = ? AND user_id = ?'
  ).get(params.org_id, locals.user.id) as { role: string } | undefined;

  if (!membership) {
    return json({ error: 'Forbidden' }, { status: 403 });
  }

  // Canonicalize the path the same way Arc will (collapse //, resolve ./ and
  // ../, lowercase). We both GATE on this and FORWARD it, so the byte string we
  // authorize is exactly the one Arc routes on — a slash/dot spelling can never
  // pass the gate as a read while Arc normalizes it back to an admin route.
  const canonicalPath = canonicalizePath(params.path);

  // The proxy injects the instance's Arc admin token, so on the Arc side every
  // request is admin-privileged. Gate that on the control plane: owners/admins
  // may reach anything; plain members are limited to read-only query/read
  // endpoints (default-closed).
  if (!['owner', 'admin'].includes(membership.role)) {
    if (!isMemberAllowed(request.method, canonicalPath)) {
      return json({ error: 'Forbidden' }, { status: 403 });
    }
  }

  const instance = getInstance(params.id);
  if (!instance || instance.org_id !== params.org_id) {
    return json({ error: 'Instance not found' }, { status: 404 });
  }

  if (!instance.endpoint_url) {
    return json({ error: 'Instance has no Arc endpoint configured' }, { status: 503 });
  }

  // Resolve + pin the target IP right before connecting. Honors the private-
  // endpoint opt-in, but always validates so we connect to the address we
  // checked (no second, attacker-controllable DNS lookup).
  let resolved: ResolvedTarget;
  try {
    resolved = await assertSafeResolvedUrl(instance.endpoint_url, {
      allowHttp: true,
      allowPrivate: allowPrivateEndpoints(),
    });
  } catch {
    return json({ error: 'Instance endpoint is not reachable or not allowed' }, { status: 502 });
  }

  // Build request headers. Strip hop-by-hop headers, client-supplied
  // Authorization/Cookie (the stored admin token is the only credential we
  // forward, only to the instance's own stored host), and content-length
  // (Node recomputes it from the actual body we write).
  const headers: Record<string, string> = {};
  for (const [key, value] of request.headers.entries()) {
    const k = key.toLowerCase();
    if (['host', 'connection', 'keep-alive', 'transfer-encoding', 'authorization', 'cookie', 'content-length'].includes(k)) continue;
    headers[key] = value;
  }
  if (instance.admin_token) {
    headers['authorization'] = `Bearer ${instance.admin_token}`;
  }

  // Forward the canonical path (the one we gated on) plus the original query
  // string, so the authorized string and the routed string are identical.
  const search = new URL(request.url).search;
  const targetPath = `${canonicalPath}${search}`;

  // Read the body as raw bytes so binary payloads (msgpack/parquet) aren't
  // corrupted by a UTF-8 round-trip.
  const body = request.method !== 'GET' && request.method !== 'HEAD'
    ? Buffer.from(await request.arrayBuffer())
    : null;

  const hostHeader = new URL(instance.endpoint_url).host;
  try {
    const result = await streamUpstreamWithFallback(
      {
        method: request.method,
        resolved,
        hostHeader,
        path: targetPath,
        headers,
        body,
        allowSelfSigned: dev,
        onStreamError: (err) => {
          // The response status is already committed, so this cannot become a
          // 502 — but a truncated download must not be silent.
          console.error('Proxy stream error:', {
            org_id: params.org_id,
            instance_id: params.id,
            path: canonicalPath,
            error: err.message,
          });
        },
      },
      resolved.ips,
    );

    // Force nosniff so a spoofed/omitted Content-Type can't be sniffed into
    // active content executing on the Launchpad origin.
    const respHeaders = {
      ...filterResponseHeaders(result.headers),
      'X-Content-Type-Options': 'nosniff',
    };

    // `result.body` is null for a null-body status (204/205/304) and for HEAD.
    // Passing anything else there — including a zero-length buffer — makes
    // `new Response` throw.
    return new Response(result.body, {
      status: result.status,
      headers: respHeaders,
    });
  } catch (err: any) {
    if (err instanceof ResponseTooLargeError) {
      console.error('Proxy response too large:', {
        org_id: params.org_id,
        instance_id: params.id,
        path: canonicalPath,
        limit: err.limit,
      });
      return json(
        { error: 'Arc response is too large to proxy. Narrow the query or add a LIMIT.' },
        { status: 502 },
      );
    }
    console.error('Proxy error:', err.message);
    return json({ error: 'Proxy error' }, { status: 502 });
  }
}

export const GET: RequestHandler = async ({ request, params, locals }) => {
  return proxyRequest(request, params as any, locals);
};

export const POST: RequestHandler = async ({ request, params, locals }) => {
  return proxyRequest(request, params as any, locals);
};

export const PUT: RequestHandler = async ({ request, params, locals }) => {
  return proxyRequest(request, params as any, locals);
};

export const PATCH: RequestHandler = async ({ request, params, locals }) => {
  return proxyRequest(request, params as any, locals);
};

export const DELETE: RequestHandler = async ({ request, params, locals }) => {
  return proxyRequest(request, params as any, locals);
};
