import { describe, it, expect } from 'vitest';
import { isPrivateIp, isSafeUrl, isSafeWebhookUrl } from './ssrf';

// The whole point of classifying on parsed BYTES rather than the textual form
// is that no re-spelling of an address can slip past the blocklist. These
// tests lock that property down: every alternate notation of a loopback or
// RFC1918 address must still classify as private.

describe('isPrivateIp — IPv4', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback, high end of /8'],
    ['10.0.0.1', 'RFC1918 10/8'],
    ['172.16.0.1', 'RFC1918 172.16/12, low edge'],
    ['172.31.255.254', 'RFC1918 172.16/12, high edge'],
    ['192.168.1.1', 'RFC1918 192.168/16'],
    ['169.254.169.254', 'link-local — the AWS/GCP metadata address'],
    ['100.64.0.1', 'CGNAT 100.64/10, low edge'],
    ['100.127.255.254', 'CGNAT 100.64/10, high edge'],
    ['0.0.0.0', '"this" network'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'broadcast / reserved'],
  ])('treats %s as private (%s)', (ip) => {
    expect(isPrivateIp(ip)).toBe(true);
  });

  it.each([
    ['8.8.8.8', 'public resolver'],
    ['1.1.1.1', 'public resolver'],
    ['172.15.255.255', 'just below the 172.16/12 block'],
    ['172.32.0.1', 'just above the 172.16/12 block'],
    ['100.63.255.255', 'just below CGNAT'],
    ['100.128.0.1', 'just above CGNAT'],
    ['192.167.1.1', 'just below 192.168/16'],
    ['223.255.255.255', 'just below the 224/4 multicast floor'],
  ])('treats %s as public (%s)', (ip) => {
    expect(isPrivateIp(ip)).toBe(false);
  });
});

describe('isPrivateIp — IPv6 and embedded IPv4', () => {
  it.each([
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['0:0:0:0:0:0:0:1', 'loopback, fully expanded'],
    ['fc00::1', 'ULA, low edge of fc00::/7'],
    ['fdff::1', 'ULA, high edge of fc00::/7'],
    ['fe80::1', 'link-local'],
    ['fec0::1', 'site-local'],
  ])('treats %s as private (%s)', (ip) => {
    expect(isPrivateIp(ip)).toBe(true);
  });

  it('strips a zone id before classifying', () => {
    expect(isPrivateIp('fe80::1%eth0')).toBe(true);
  });

  it.each([
    ['2001:4860:4860::8888', 'Google public DNS'],
    ['2606:4700:4700::1111', 'Cloudflare public DNS'],
  ])('treats %s as public (%s)', (ip) => {
    expect(isPrivateIp(ip)).toBe(false);
  });

  // These are the bypass attempts the byte-level parse exists to defeat.
  it.each([
    ['::ffff:127.0.0.1', 'IPv4-mapped, dotted'],
    ['::ffff:7f00:1', 'IPv4-mapped, hex — same address, different spelling'],
    ['::ffff:10.0.0.1', 'IPv4-mapped RFC1918'],
    ['::ffff:169.254.169.254', 'IPv4-mapped metadata address'],
    ['::127.0.0.1', 'IPv4-compatible'],
    ['2002:7f00:1::', '6to4 embedding 127.0.0.1'],
    ['2002:a00:1::', '6to4 embedding 10.0.0.1'],
    ['64:ff9b::127.0.0.1', 'NAT64 embedding loopback'],
    ['64:ff9b::a00:1', 'NAT64 embedding 10.0.0.1 in hex'],
  ])('defeats the %s bypass (%s)', (ip) => {
    expect(isPrivateIp(ip)).toBe(true);
  });

  it('classifies a 6to4 address embedding a public IPv4 as public', () => {
    // 2002:0808:0808:: embeds 8.8.8.8
    expect(isPrivateIp('2002:808:808::')).toBe(false);
  });

  it.each([
    ['not-an-ip'],
    [''],
    ['999.999.999.999'],
    ['12345::'],
    ['::1::2'],
    ['1.2.3'],
  ])('fails closed on unparseable input %j', (ip) => {
    // An address we cannot parse must never be assumed routable.
    expect(isPrivateIp(ip)).toBe(true);
  });
});

describe('isSafeUrl', () => {
  it('defaults to https only', () => {
    expect(isSafeUrl('https://example.com')).toBe(true);
    expect(isSafeUrl('http://example.com')).toBe(false);
  });

  it('allows http when opted in', () => {
    expect(isSafeUrl('http://example.com', { allowHttp: true })).toBe(true);
  });

  it.each([['ftp://example.com'], ['file:///etc/passwd'], ['gopher://example.com']])(
    'rejects the %s scheme even with allowHttp',
    (url) => {
      expect(isSafeUrl(url, { allowHttp: true })).toBe(false);
    },
  );

  it.each([
    ['https://localhost'],
    ['https://LOCALHOST'],
    ['https://localhost.'],
    ['https://foo.local'],
    ['https://foo.internal'],
    ['https://metadata.google.internal'],
  ])('blocks the hostname in %s', (url) => {
    expect(isSafeUrl(url)).toBe(false);
  });

  it.each([
    ['https://127.0.0.1'],
    ['https://10.0.0.1'],
    ['https://169.254.169.254'],
    ['https://[::1]'],
    ['https://[::ffff:127.0.0.1]'],
  ])('blocks the private literal in %s', (url) => {
    expect(isSafeUrl(url)).toBe(false);
  });

  it('allows a public host', () => {
    expect(isSafeUrl('https://arc.example.com:8000/path')).toBe(true);
  });

  it('short-circuits every host check when allowPrivate is set', () => {
    // Documents real behaviour: allowPrivate is checked before the hostname
    // and IP-literal gates, so it permits localhost too. This is what the
    // LAUNCHPAD_ALLOW_PRIVATE_ENDPOINTS opt-in relies on.
    expect(isSafeUrl('https://localhost', { allowPrivate: true })).toBe(true);
    expect(isSafeUrl('http://127.0.0.1:8000', { allowHttp: true, allowPrivate: true })).toBe(true);
  });

  it('still enforces the scheme when allowPrivate is set', () => {
    expect(isSafeUrl('http://127.0.0.1:8000', { allowPrivate: true })).toBe(false);
  });

  it.each([['not a url'], [''], ['//example.com'], ['example.com']])(
    'rejects unparseable input %j',
    (url) => {
      expect(isSafeUrl(url)).toBe(false);
    },
  );
});

describe('isSafeWebhookUrl', () => {
  it('is https-only', () => {
    expect(isSafeWebhookUrl('https://hooks.example.com/abc')).toBe(true);
    expect(isSafeWebhookUrl('http://hooks.example.com/abc')).toBe(false);
  });

  it('rejects private targets', () => {
    expect(isSafeWebhookUrl('https://127.0.0.1/abc')).toBe(false);
    expect(isSafeWebhookUrl('https://169.254.169.254/latest/meta-data')).toBe(false);
  });
});
