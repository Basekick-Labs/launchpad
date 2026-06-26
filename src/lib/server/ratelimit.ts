// Simple in-memory rate limiter — sliding window per key (IP or email)
// Not suitable for multi-process deployments, fine for single-node SvelteKit.

interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();

// Clean up expired entries every 5 minutes to avoid unbounded growth
setInterval(() => {
  const now = Date.now();
  for (const [key, w] of windows) {
    if (w.resetAt < now) windows.delete(key);
  }
}, 5 * 60 * 1000);

/**
 * Returns true if the key is rate-limited (too many attempts).
 * @param key      Unique key, e.g. `signup:1.2.3.4`
 * @param limit    Max attempts allowed within the window
 * @param windowMs Window duration in milliseconds
 */
export function isRateLimited(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  let w = windows.get(key);

  if (!w || w.resetAt < now) {
    w = { count: 1, resetAt: now + windowMs };
    windows.set(key, w);
    return false;
  }

  w.count++;
  return w.count > limit;
}
