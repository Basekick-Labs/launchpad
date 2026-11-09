import { MAX_JSON_BODY_BYTES } from './util';

// Arc permits SQL up to 1 MiB; JSON escaping can expand that to 6 MiB plus
// the query envelope. 8 MiB leaves headroom without buffering Arc's 1 GiB
// ingestion ceiling in Launchpad's default 512 MiB pod. Larger binary uploads
// require an explicit operator override (or direct Arc access).
export const DEFAULT_PROXY_BODY_BYTES = 8 * 1024 * 1024;

function positiveBytes(name: string, value: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) {
    throw new Error(`${name} must be a positive safe integer in bytes`);
  }
  return Number(value);
}

export function proxyBodyLimit(env: Record<string, string | undefined>): number {
  const limit = env.LAUNCHPAD_PROXY_BODY_SIZE_LIMIT === undefined
    ? DEFAULT_PROXY_BODY_BYTES
    : positiveBytes('LAUNCHPAD_PROXY_BODY_SIZE_LIMIT', env.LAUNCHPAD_PROXY_BODY_SIZE_LIMIT);
  if (limit < MAX_JSON_BODY_BYTES) {
    throw new Error('LAUNCHPAD_PROXY_BODY_SIZE_LIMIT must be at least 1048576 bytes');
  }
  if (env.BODY_SIZE_LIMIT !== undefined && positiveBytes('BODY_SIZE_LIMIT', env.BODY_SIZE_LIMIT) < limit) {
    throw new Error('BODY_SIZE_LIMIT must be at least LAUNCHPAD_PROXY_BODY_SIZE_LIMIT');
  }
  return limit;
}

export const MAX_PROXY_BODY_BYTES = proxyBodyLimit(process.env);
