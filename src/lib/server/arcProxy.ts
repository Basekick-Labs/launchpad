/**
 * The transport half of the instance proxy: one upstream HTTP request to an
 * Arc instance, streamed rather than buffered.
 *
 * Extracted from the route so the failure modes below can be tested. Every one
 * of them was reproduced against a real `http.createServer` before being fixed,
 * and none is reachable from a route-level test we do not have (#64).
 *
 * ## Why streaming, not a bigger buffer
 *
 * The previous implementation collected the whole response
 * (`chunks.push` then `Buffer.concat`) and the route then copied it again into a
 * `Uint8Array`, which `new Response` copies a third time. Measured against a
 * 200 MB response through the real prod build: **RSS grew 1065 MB**, about 5x
 * the payload, in a shared process serving every org. The proxy never inspects
 * the body — it copies an allowlisted set of headers and passes bytes through —
 * so the buffer had no purpose.
 *
 * ## Three failures this fixes, each verified
 *
 * 1. **A mid-body upstream failure hung the request forever.** On a dropped
 *    socket the `ClientRequest` does NOT emit `error`; the error lands on the
 *    `IncomingMessage`, which had no listener, so Node discarded it. Observed
 *    events were `response, data, aborted, close` — no `end`, no `error` — so
 *    the promise resolved never and the client waited on a response that could
 *    not come. Settling on `response` removes the window entirely.
 *
 * 2. **`req.setTimeout` fires *because of* backpressure.** The timeout is socket
 *    inactivity, and under streaming WE are the idle party whenever the client
 *    reads slowly. Measured: a 2s timeout fired at 2005ms with the consumer
 *    paused. Left in place it would truncate a `200` for any client that paused
 *    longer than the timeout — a bug the buffered version could not have,
 *    because it always drained at full speed. So the timeout covers connect and
 *    headers only, and is cleared once the response arrives. Client disconnect
 *    is what reaps a stalled stream after that.
 *
 * 3. **`new Response(body, { status: 204 })` throws.** It rejects a null-body
 *    status whatever the body is — a zero-length `Uint8Array` included — so the
 *    route already 502'd on any 204/205/304 from Arc. Under streaming it would
 *    also leak the upstream socket, since the throw happened with the response
 *    neither consumed nor destroyed.
 */

import https from 'node:https';
import http from 'node:http';
import { Readable } from 'node:stream';
import type { ResolvedTarget } from './ssrf';

/**
 * Statuses that must carry no body. `new Response` throws on these unless the
 * body is exactly `null`, and 304 is reachable here: the route forwards the
 * client's `if-none-match` / `if-modified-since`, and `etag` / `last-modified`
 * are in the response allowlist.
 */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/**
 * How long to wait for a connection and response headers. Deliberately NOT a
 * bound on body transfer — see failure 2 above.
 */
const HEADER_TIMEOUT_MS = 30_000;

/**
 * Ceiling on a single proxied response.
 *
 * Streaming fixes the memory problem on its own, so this is not what keeps the
 * control plane alive. It exists because every browser consumer of this proxy
 * reads the body with `response.json()` — 30 call sites in `arcClient.ts`, and
 * no streaming consumer at all — so a response too large to cap is also too
 * large for the only thing that reads it. Capping turns "the tab dies parsing
 * 2 GB of JSON" into a clear error, and bounds how long one request can hold a
 * socket while Node's global agent allows unlimited sockets.
 *
 * Generous on purpose: a dashboard query at `LIMITS.maxDataPoints` is single-
 * digit megabytes of JSON, so this is roughly two orders of magnitude of
 * headroom. It is NOT a throughput control — that is rate limiting on the
 * route, which does not exist yet and is tracked separately.
 */
export const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024 * 1024;

export interface UpstreamResponse {
  status: number;
  /** Raw upstream headers; the caller applies its own allowlist. */
  headers: http.IncomingHttpHeaders;
  /** null for a null-body status, so the caller can pass it to `new Response`. */
  body: ReadableStream<Uint8Array> | null;
}

export class ResponseTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`upstream response exceeds ${limit} bytes`);
    this.name = 'ResponseTooLargeError';
  }
}

export interface StreamUpstreamOptions {
  method: string;
  resolved: ResolvedTarget;
  /** The validated, pinned IP to dial. */
  ip: string;
  hostHeader: string;
  path: string;
  headers: Record<string, string>;
  body: Buffer | null;
  /** Dev-only: accept a self-signed cert on an https instance. */
  allowSelfSigned?: boolean;
  maxResponseBytes?: number;
  /** Connect-and-headers deadline. Overridable so tests need not wait it out. */
  headerTimeoutMs?: number;
  /** Called when the stream ends early, so a truncation is diagnosable. */
  onStreamError?: (err: Error) => void;
}

/**
 * Issues one request and resolves as soon as response headers arrive, with the
 * body as a web stream.
 *
 * Resolving at `response` rather than at `end` is what makes the retry window
 * in the caller mean what it says: a rejection here is a connect-or-headers
 * failure, which is safe to retry against another IP. Once headers exist the
 * request has been accepted and must not be re-sent — a POSTed query has
 * already run.
 */
export function streamUpstream(opts: StreamUpstreamOptions): Promise<UpstreamResponse> {
  const {
    method,
    resolved,
    ip,
    hostHeader,
    path,
    headers,
    body,
    allowSelfSigned = false,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    headerTimeoutMs = HEADER_TIMEOUT_MS,
    onStreamError,
  } = opts;

  return new Promise((resolve, reject) => {
    const isHttps = resolved.protocol === 'https:';
    const mod = isHttps ? https : http;

    // Dial a validated pinned IP; keep the original hostname for the Host header
    // and TLS SNI. This closes the DNS-rebinding window.
    const req = mod.request(
      {
        host: ip,
        servername: isHttps ? resolved.hostname : undefined,
        port: resolved.port,
        path: `/${path}`,
        method,
        headers: { ...headers, Host: hostHeader },
        ...(isHttps && allowSelfSigned ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        // Connect/header phase is over. Leaving this armed would destroy the
        // socket whenever a slow client stops reading, truncating a 200.
        req.setTimeout(0);

        const status = res.statusCode || 502;

        if (NULL_BODY_STATUSES.has(status) || method === 'HEAD') {
          // Drain so the socket is released to the agent rather than left
          // half-read. There is nothing to forward.
          res.resume();
          resolve({ status, headers: res.headers, body: null });
          return;
        }

        // Refuse before committing a status when the upstream declares a size we
        // will not carry. Cheap, exact, and it lets the caller answer cleanly.
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > maxResponseBytes) {
          res.resume();
          req.destroy();
          reject(new ResponseTooLargeError(maxResponseBytes));
          return;
        }

        // Without this, a mid-body error is discarded by Node and the only
        // symptom is a short read at the client.
        res.on('error', (err) => onStreamError?.(err));

        let seen = 0;
        if (Number.isFinite(maxResponseBytes)) {
          res.on('data', (chunk: Buffer) => {
            seen += chunk.length;
            if (seen > maxResponseBytes) {
              // Destroy rather than truncate quietly: the consumer is a
              // `response.json()` call, and a silently short body parses as
              // corrupt data or, worse, parses.
              const err = new ResponseTooLargeError(maxResponseBytes);
              onStreamError?.(err);
              res.destroy(err);
              req.destroy();
            }
          });
        }

        // Readable.toWeb propagates backpressure and cancellation, and is what
        // SvelteKit itself uses for file responses. Measured in-flight bytes
        // stayed at a few MB across a 200 MB transfer with a slow consumer.
        resolve({
          status,
          headers: res.headers,
          body: Readable.toWeb(res) as ReadableStream<Uint8Array>,
        });
      },
    );

    // Still useful AFTER the promise settles: a late rejection is discarded
    // harmlessly, and this is the only place a connect error surfaces.
    req.on('error', reject);
    req.setTimeout(headerTimeoutMs, () => {
      req.destroy(new Error('Proxy timeout'));
    });

    if (body && method !== 'GET' && method !== 'HEAD') {
      req.write(body);
    }
    req.end();
  });
}

/**
 * Tries each validated IP the host resolved to, falling back on connect-level
 * errors. A dual-stack host may resolve to ::1 and 127.0.0.1 while the upstream
 * listens on only one family; every IP already passed the SSRF check, so trying
 * the next is safe.
 *
 * Response headers of ANY status end the loop — that is a real answer. So does
 * a response we refuse on size, which is an answer about the upstream, not a
 * connection fault, and retrying would re-run the query that produced it.
 */
export async function streamUpstreamWithFallback(
  opts: Omit<StreamUpstreamOptions, 'ip'>,
  ips: readonly string[],
): Promise<UpstreamResponse> {
  let lastErr: unknown;
  for (const ip of ips) {
    try {
      return await streamUpstream({ ...opts, ip });
    } catch (err) {
      if (err instanceof ResponseTooLargeError) throw err;
      lastErr = err;
    }
  }
  throw lastErr ?? new Error('Proxy error');
}
