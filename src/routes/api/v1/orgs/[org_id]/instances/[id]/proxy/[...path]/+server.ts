import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type http from 'node:http';
import { dev } from '$app/environment';
import { getDb } from '$lib/server/db';
import { getInstance } from '$lib/server/instance';
import { allowPrivateEndpoints } from '$lib/server/arcConnection';
import { assertSafeResolvedUrl, type ResolvedTarget } from '$lib/server/ssrf';
import { streamUpstreamWithFallback, ResponseTooLargeError } from '$lib/server/arcProxy';
import { canonicalizePath, isAuditedChange, isDryRun, isMemberAllowed, isNonChangeStatus } from '$lib/server/proxyPolicy';
import { recordChange } from '$lib/server/instanceChangeLog';

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
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(params.path);
  } catch {
    return json({ error: 'Invalid path' }, { status: 400 }); // a stray '%'
  }
  if (decodedPath.includes('..') || decodedPath.includes('\\')) {
    return json({ error: 'Invalid path' }, { status: 400 });
  }
  const actorUserId = locals.user.id;

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
  // Changes are recorded once, with the Launchpad user, when Arc's status is
  // known (or with none when Arc never answered). Never the body; a 404/405
  // changed nothing and is not recorded.
  const audited = isAuditedChange(request.method, canonicalPath);
  const dryRun = audited && isDryRun(canonicalPath, body);
  const record = (status: number | null) => {
    if (audited && !(status !== null && isNonChangeStatus(status))) {
      recordChange({ instanceId: instance.id, actorUserId, method: request.method, path: canonicalPath, status, dryRun });
    }
  };

  let result: Awaited<ReturnType<typeof streamUpstreamWithFallback>>;
  try {
    result = await streamUpstreamWithFallback(
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

  } catch (err: any) {
    // A declared-too-large answer still carries Arc's status; anything else
    // may have applied before failing, so it is recorded as unknown.
    record(err instanceof ResponseTooLargeError ? err.status ?? null : null);
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
  record(result.status);

  try {
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
    // An unusable upstream header or status: release the upstream stream.
    await result.body?.cancel().catch(() => {});
    console.error('Proxy response error:', err.message);
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
