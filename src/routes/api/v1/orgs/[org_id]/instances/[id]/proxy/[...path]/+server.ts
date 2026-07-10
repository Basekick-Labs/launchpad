import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import https from 'node:https';
import http from 'node:http';
import { dev } from '$app/environment';
import { getDb } from '$lib/server/db';
import { getInstance } from '$lib/server/instance';
import { allowPrivateEndpoints } from '$lib/server/arcConnection';
import { assertSafeResolvedUrl, type ResolvedTarget } from '$lib/server/ssrf';

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
// rbac, backup, mqtt, retention, tokens, …) — requires owner/admin. That way a
// newly-added Arc admin route is locked down by default instead of being
// viewer-reachable until someone remembers to blocklist it.
const MEMBER_READ_PREFIXES = [
  'api/v1/query',        // SQL reads (Arc uses POST for query — see below)
  'api/v1/databases',
  'api/v1/measurements',
  'api/v1/metrics',
  'api/v1/logs',
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

function proxyViaNode(
  method: string,
  resolved: ResolvedTarget,
  hostHeader: string,
  path: string,
  headers: Record<string, string>,
  body: Buffer | null,
): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const isHttps = resolved.protocol === 'https:';
    const mod = isHttps ? https : http;

    // Dial the pinned IP we already validated; keep the original hostname for
    // the Host header and TLS SNI. This closes the DNS-rebinding window.
    const options = {
      host: resolved.ip,
      servername: isHttps ? resolved.hostname : undefined,
      port: resolved.port,
      path: `/${path}`,
      method,
      headers: { ...headers, Host: hostHeader },
      ...(isHttps && dev ? { rejectUnauthorized: false } : {}),
    };

    const req = mod.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const respHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(res.headers)) {
          if (value && ALLOWED_RESPONSE_HEADERS.has(key.toLowerCase())) {
            respHeaders[key] = Array.isArray(value) ? value.join(', ') : value;
          }
        }
        resolve({
          status: res.statusCode || 502,
          headers: respHeaders,
          body: Buffer.concat(chunks),
        });
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(new Error('Proxy timeout')); });

    if (body && method !== 'GET' && method !== 'HEAD') {
      req.write(body);
    }
    req.end();
  });
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

  // The proxy injects the instance's Arc admin token, so on the Arc side every
  // request is admin-privileged. Gate that on the control plane: owners/admins
  // may reach anything; plain members are limited to read-only query/read
  // endpoints (default-closed). Canonicalize first so slash/dot tricks can't
  // smuggle an admin path past the check that Arc would then normalize back.
  if (!['owner', 'admin'].includes(membership.role)) {
    const canonical = canonicalizePath(params.path);
    if (!isMemberAllowed(request.method, canonical)) {
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

  // Preserve the original query string when forwarding to Arc.
  const search = new URL(request.url).search;
  const targetPath = `${params.path}${search}`;

  // Read the body as raw bytes so binary payloads (msgpack/parquet) aren't
  // corrupted by a UTF-8 round-trip.
  const body = request.method !== 'GET' && request.method !== 'HEAD'
    ? Buffer.from(await request.arrayBuffer())
    : null;

  const hostHeader = new URL(instance.endpoint_url).host;
  try {
    const result = await proxyViaNode(request.method, resolved, hostHeader, targetPath, headers, body);

    // Force nosniff so a spoofed/omitted Content-Type can't be sniffed into
    // active content executing on the Launchpad origin.
    const respHeaders = { ...result.headers, 'X-Content-Type-Options': 'nosniff' };

    return new Response(new Uint8Array(result.body), {
      status: result.status,
      headers: respHeaders,
    });
  } catch (err: any) {
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
