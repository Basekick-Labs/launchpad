import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import https from 'node:https';
import http from 'node:http';
import { dev } from '$app/environment';
import { getDb } from '$lib/server/db';
import { getInstance } from '$lib/server/instance';
import { getProxyTarget } from '$lib/server/arcConnection';

function proxyViaNode(
  method: string,
  target: { hostname: string; port: number; protocol: string; host: string },
  path: string,
  headers: Record<string, string>,
  body: string | null,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const isHttps = target.protocol === 'https';
    const mod = isHttps ? https : http;

    const reqHeaders: Record<string, string> = { ...headers, Host: target.host };

    const options = {
      hostname: target.hostname,
      port: target.port,
      path: `/${path}`,
      method,
      headers: reqHeaders,
      ...(isHttps && dev ? { rejectUnauthorized: false } : {}),
    };

    const req = mod.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const respHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(res.headers)) {
          if (value && !['transfer-encoding', 'connection'].includes(key)) {
            respHeaders[key] = Array.isArray(value) ? value.join(', ') : value;
          }
        }
        resolve({
          status: res.statusCode || 502,
          headers: respHeaders,
          body: Buffer.concat(chunks).toString('utf-8'),
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
  ).get(params.org_id, locals.user.id);

  if (!membership) {
    return json({ error: 'Forbidden' }, { status: 403 });
  }

  const instance = getInstance(params.id);
  if (!instance || instance.org_id !== params.org_id) {
    return json({ error: 'Instance not found' }, { status: 404 });
  }

  const target = getProxyTarget(instance.endpoint_url);
  if (!target) {
    return json({ error: 'Instance has no Arc endpoint configured' }, { status: 503 });
  }

  // Build headers
  const headers: Record<string, string> = {};
  for (const [key, value] of request.headers.entries()) {
    if (['host', 'connection', 'keep-alive', 'transfer-encoding'].includes(key.toLowerCase())) continue;
    headers[key] = value;
  }

  // Inject the instance's configured token when the caller didn't supply one.
  // Any member who can see this instance proxies with the connection's credential.
  const existingAuth = headers['authorization']?.replace(/^Bearer\s*/i, '').trim();
  if (!existingAuth && instance.admin_token) {
    headers['authorization'] = `Bearer ${instance.admin_token}`;
  }

  // Preserve the original query string when forwarding to Arc.
  const search = new URL(request.url).search;
  const targetPath = `${params.path}${search}`;

  const body = request.method !== 'GET' && request.method !== 'HEAD'
    ? await request.text()
    : null;

  try {
    const result = await proxyViaNode(request.method, target, targetPath, headers, body);

    return new Response(result.body, {
      status: result.status,
      headers: result.headers,
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
