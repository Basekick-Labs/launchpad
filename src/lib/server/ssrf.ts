import net from 'node:net';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';

// Parse an IPv4 dotted string into 4 bytes, or null if malformed.
function parseIpv4Bytes(ip: string): number[] | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const bytes = m.slice(1).map(Number);
  return bytes.every((b) => b >= 0 && b <= 255) ? bytes : null;
}

// Parse an IPv6 string (any notation, incl. compressed and embedded-IPv4) into
// 16 bytes, or null if malformed. This is what makes the SSRF check robust:
// every notation of the same address collapses to the same 16 bytes, so a
// blocklist over bytes can't be defeated by re-spelling the address.
function parseIpv6Bytes(ip: string): number[] | null {
  let head = ip;
  let tailV4: number[] | null = null;
  // A trailing dotted-quad (e.g. ::ffff:127.0.0.1) occupies the last 4 bytes.
  const lastColon = head.lastIndexOf(':');
  const afterColon = head.slice(lastColon + 1);
  if (afterColon.includes('.')) {
    tailV4 = parseIpv4Bytes(afterColon);
    if (!tailV4) return null;
    head = head.slice(0, lastColon + 1) + '0:0'; // placeholder for two groups
  }
  const parts = head.split('::');
  if (parts.length > 2) return null;
  const toGroups = (s: string): number[] | null => {
    if (s === '') return [];
    const out: number[] = [];
    for (const g of s.split(':')) {
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const left = toGroups(parts[0]);
  const right = parts.length === 2 ? toGroups(parts[1]) : [];
  if (left === null || right === null) return null;
  let groups: number[];
  if (parts.length === 2) {
    const fill = 8 - (left.length + right.length);
    if (fill < 0) return null;
    groups = [...left, ...new Array(fill).fill(0), ...right];
  } else {
    groups = left;
  }
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (const g of groups) bytes.push((g >> 8) & 0xff, g & 0xff);
  if (tailV4) { bytes[12] = tailV4[0]; bytes[13] = tailV4[1]; bytes[14] = tailV4[2]; bytes[15] = tailV4[3]; }
  return bytes;
}

// True if 4 IPv4 bytes fall in a private/reserved/metadata range.
function isPrivateIpv4Bytes(b: number[]): boolean {
  const [a, c] = b;
  if (a === 127) return true;                    // 127.0.0.0/8 loopback
  if (a === 10) return true;                      // 10/8
  if (a === 172 && c >= 16 && c <= 31) return true; // 172.16/12
  if (a === 192 && c === 168) return true;        // 192.168/16
  if (a === 169 && c === 254) return true;        // 169.254/16 link-local / IMDS
  if (a === 100 && c >= 64 && c <= 127) return true; // 100.64/10 CGNAT
  if (a === 0) return true;                        // 0/8 "this" network
  if (a >= 224) return true;                       // 224/4 multicast + 240/4 reserved
  return false;
}

/**
 * True if the given IP literal falls in a private/reserved/metadata range.
 * Works on the 16-byte (IPv6) / 4-byte (IPv4) value, not the textual form, so
 * no re-spelling (compressed, expanded, mapped hex/dotted, 6to4, NAT64) can
 * slip a loopback/RFC1918/metadata address past it. Unparseable → unsafe.
 */
export function isPrivateIp(ip: string): boolean {
  const bare = ip.replace(/%.*$/, ''); // strip zone id (fe80::1%eth0)
  const v4 = parseIpv4Bytes(bare);
  if (v4) return isPrivateIpv4Bytes(v4);

  const b = parseIpv6Bytes(bare);
  if (!b) return true; // not a valid IP → treat as unsafe

  // Loopback ::1 and unspecified ::
  if (b.every((x, i) => x === (i === 15 ? 1 : 0))) return true;
  if (b.every((x) => x === 0)) return true;
  // IPv4-mapped ::ffff:0:0/96 and IPv4-compatible ::/96 — classify embedded v4.
  const first10Zero = b.slice(0, 10).every((x) => x === 0);
  if (first10Zero && ((b[10] === 0xff && b[11] === 0xff) || (b[10] === 0 && b[11] === 0))) {
    return isPrivateIpv4Bytes(b.slice(12, 16));
  }
  // 6to4 2002::/16 embeds an IPv4 in bytes 2..5 — classify it.
  if (b[0] === 0x20 && b[1] === 0x02) return isPrivateIpv4Bytes(b.slice(2, 6));
  // NAT64 64:ff9b::/96 embeds an IPv4 in the last 4 bytes.
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    return isPrivateIpv4Bytes(b.slice(12, 16));
  }
  // ULA fc00::/7 (fc00–fdff).
  if ((b[0] & 0xfe) === 0xfc) return true;
  // Link-local fe80::/10 and site-local fec0::/10.
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return true; // fec0::/10 site-local
  return false;
}

/** Reject obviously-unsafe hostnames (localhost, .local, .internal, metadata). */
function isBlockedHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return (
    h === 'localhost' ||
    h.endsWith('.local') ||
    h.endsWith('.internal') ||
    h === 'metadata.google.internal'
  );
}

export interface SafeUrlOptions {
  /** Allowed URL schemes. Defaults to https-only. */
  allowHttp?: boolean;
  /** Permit private/link-local/metadata targets (opt-in, e.g. self-hosted Arc). */
  allowPrivate?: boolean;
}

/**
 * Static (no-DNS) safety check for a URL string. Rejects bad schemes,
 * blocked hostnames, and private IP literals. Does NOT resolve DNS — use
 * {@link assertSafeResolvedUrl} at request time to defeat DNS rebinding.
 */
export function isSafeUrl(rawUrl: string, opts: SafeUrlOptions = {}): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  const allowed = opts.allowHttp ? ['http:', 'https:'] : ['https:'];
  if (!allowed.includes(url.protocol)) return false;
  if (opts.allowPrivate) return true;

  // Strip IPv6 brackets for the literal check.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isBlockedHostname(host)) return false;
  if (net.isIP(host) !== 0 && isPrivateIp(host)) return false;
  return true;
}

/** Backwards-compatible alias — https-only webhook check. */
export function isSafeWebhookUrl(rawUrl: string): boolean {
  return isSafeUrl(rawUrl, { allowHttp: false });
}

export interface ResolvedTarget {
  /** The pinned IP to actually connect to (defeats DNS rebinding). */
  ip: string;
  /** Original hostname — use for the Host header / TLS SNI. */
  hostname: string;
  port: number;
  protocol: 'http:' | 'https:';
}

// Short-TTL cache of validated hostname→IP resolutions. Keeps the hot proxy
// path from doing a DNS lookup per request while keeping the DNS-rebinding
// window small: an attacker must re-point DNS AND wait out this TTL. Keyed on
// hostname+allowPrivate because validation differs by that flag.
const RESOLUTION_TTL_MS = 30_000;
const resolutionCache = new Map<string, { ip: string; expiresAt: number }>();

/**
 * Resolve a URL's hostname and validate EVERY resolved address against the
 * private-range blocklist, then return a target pinned to a safe IP. Throws
 * if the URL is malformed, the scheme is disallowed, the hostname is blocked,
 * or any resolved address is private. Connecting to the returned `ip` (with
 * the original `hostname` as Host/SNI) closes the validate-then-connect
 * DNS-rebinding window because resolution happens (at most) once per TTL.
 */
export async function assertSafeResolvedUrl(
  rawUrl: string,
  opts: SafeUrlOptions = {},
): Promise<ResolvedTarget> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL');
  }
  const allowed = opts.allowHttp ? ['http:', 'https:'] : ['https:'];
  if (!allowed.includes(url.protocol)) {
    throw new Error(`Disallowed URL scheme: ${url.protocol}`);
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!opts.allowPrivate && isBlockedHostname(hostname)) {
    throw new Error('Target host is not allowed');
  }

  const protocol = url.protocol as 'http:' | 'https:';
  const port = url.port ? Number(url.port) : protocol === 'https:' ? 443 : 80;

  // If the host is already an IP literal, validate it directly (no DNS, no cache).
  if (net.isIP(hostname) !== 0) {
    if (!opts.allowPrivate && isPrivateIp(hostname)) {
      throw new Error('Target resolves to a private address');
    }
    return { ip: hostname, hostname, port, protocol };
  }

  const cacheKey = `${opts.allowPrivate ? '1' : '0'}:${hostname}`;
  const cached = resolutionCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { ip: cached.ip, hostname, port, protocol };
  }

  // Resolve ALL addresses; reject if any is private (defensive against
  // multi-record rebinding tricks) and pin to the first safe one. Even when
  // private targets are allowed, we still resolve-and-pin so the address we
  // connect to is the one we validated (no second, attacker-controlled lookup).
  const records = await dns.lookup(hostname, { all: true });
  if (records.length === 0) throw new Error('Target host did not resolve');
  if (!opts.allowPrivate) {
    for (const r of records) {
      if (isPrivateIp(r.address)) {
        throw new Error('Target resolves to a private address');
      }
    }
  }
  const ip = records[0].address;
  // Bound the cache: drop expired entries once it grows past a small cap
  // (endpoints are operator-configured, so N is normally tiny).
  if (resolutionCache.size > 256) {
    const now = Date.now();
    for (const [k, v] of resolutionCache) {
      if (v.expiresAt <= now) resolutionCache.delete(k);
    }
  }
  resolutionCache.set(cacheKey, { ip, expiresAt: Date.now() + RESOLUTION_TTL_MS });
  return { ip, hostname, port, protocol };
}

export interface SafeRequestOptions extends SafeUrlOptions {
  method?: string;
  /** Path override; defaults to the URL's own path + query. */
  path?: string;
  headers?: Record<string, string | number>;
  body?: string | null;
  timeoutMs?: number;
  /** Abort (and treat as failure) once the response exceeds this many bytes. */
  maxResponseBytes?: number;
}

export interface SafeResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

/**
 * Perform an HTTP(S) request to a user/operator-configurable URL, connecting to
 * a DNS-pinned safe IP (SSRF + DNS-rebinding safe): the host is resolved and
 * validated exactly once, then we dial that IP directly while keeping the
 * original hostname for the Host header and TLS SNI. Throws on unsafe target,
 * timeout, oversized response, or transport error. This is the single shared
 * outbound primitive for the proxy, alert queries, health checks, and webhooks.
 */
export async function safeRequest(
  rawUrl: string,
  opts: SafeRequestOptions = {},
): Promise<SafeResponse> {
  const target = await assertSafeResolvedUrl(rawUrl, opts);
  const url = new URL(rawUrl);
  const mod = target.protocol === 'https:' ? https : http;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const method = opts.method ?? 'GET';

  return new Promise<SafeResponse>((resolve, reject) => {
    const req = mod.request(
      {
        host: target.ip, // dial the pinned IP, not the (re-resolvable) hostname
        servername: target.protocol === 'https:' ? target.hostname : undefined, // TLS SNI
        port: target.port,
        path: opts.path ?? (url.pathname + url.search),
        method,
        headers: { Host: url.host, ...(opts.headers ?? {}) }, // preserve vhost routing
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (opts.maxResponseBytes && total > opts.maxResponseBytes) {
            req.destroy(new Error('Response too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
        );
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
    if (opts.body != null && method !== 'GET' && method !== 'HEAD') req.write(opts.body);
    req.end();
  });
}

export interface SafePostResult {
  status: number;
}

/**
 * POST a JSON payload to a user-configurable webhook URL (SSRF-safe, DNS-pinned
 * via {@link safeRequest}). Non-2xx resolves with the status so callers decide
 * how to treat it.
 */
export async function safePostJson(
  rawUrl: string,
  payload: string,
  opts: SafeUrlOptions & { timeoutMs?: number } = {},
): Promise<SafePostResult> {
  const res = await safeRequest(rawUrl, {
    ...opts,
    method: 'POST',
    body: payload,
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    timeoutMs: opts.timeoutMs ?? 10_000,
  });
  return { status: res.status };
}
