// Connection helpers for talking to an existing (external) Arc server.
// On-prem, an "instance" is a stored connection — a base URL + admin token —
// not a provisioned Kubernetes deployment.

export interface ProxyTarget {
  hostname: string;
  port: number;
  protocol: 'http' | 'https';
  host: string; // value for the Host header (hostname[:port])
}

/** Normalize a user-supplied Arc URL: trim, add scheme if missing, strip trailing slash. */
export function normalizeEndpointUrl(raw: string): string | null {
  const trimmed = (raw || '').trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    // Drop any path/query/hash — we proxy paths ourselves.
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/** Build a proxy target from a stored endpoint_url. Returns null if missing/invalid. */
export function getProxyTarget(endpointUrl: string | null | undefined): ProxyTarget | null {
  if (!endpointUrl) return null;
  try {
    const u = new URL(endpointUrl);
    const protocol = u.protocol === 'http:' ? 'http' : 'https';
    const port = u.port ? Number(u.port) : (protocol === 'https' ? 443 : 80);
    return { hostname: u.hostname, port, protocol, host: u.host };
  } catch {
    return null;
  }
}

/** Public-facing URL of an instance — simply its endpoint_url. */
export function getInstanceUrl(endpointUrl: string | null | undefined): string | null {
  return endpointUrl ?? null;
}

/**
 * Ping an Arc server's health endpoint. Returns 'running' if reachable and
 * healthy, otherwise 'unreachable'. Best-effort, never throws.
 */
export async function checkArcHealth(endpointUrl: string | null | undefined, adminToken?: string | null): Promise<'running' | 'unreachable'> {
  const base = normalizeEndpointUrl(endpointUrl || '');
  if (!base) return 'unreachable';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const headers: Record<string, string> = {};
    if (adminToken) headers['authorization'] = `Bearer ${adminToken}`;
    const res = await fetch(`${base}/health`, { headers, signal: controller.signal });
    return res.ok ? 'running' : 'unreachable';
  } catch {
    return 'unreachable';
  } finally {
    clearTimeout(timer);
  }
}
