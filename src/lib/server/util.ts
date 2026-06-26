import net from 'net';

const PRIVATE_IP_RANGES = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,   // link-local / cloud metadata
  /^::1$/,
  /^fc00:/i,
  /^fe80:/i,
  /^0\./,
];

export function isSafeWebhookUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname;
  if (net.isIP(host)) {
    for (const range of PRIVATE_IP_RANGES) {
      if (range.test(host)) return false;
    }
  }
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
  return true;
}
