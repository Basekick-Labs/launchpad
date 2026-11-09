import { describe, expect, it } from 'vitest';
import { blockedReason, canonicalizePath, isAuditedChange, isDryRun, isMemberAllowed, isNonChangeStatus } from './proxyPolicy';

describe('canonicalizePath', () => {
  it('normalises the spellings Arc normalises', () => {
    expect(canonicalizePath('/api/v1//MQTT/./subscriptions')).toBe('api/v1/mqtt/subscriptions');
    expect(canonicalizePath('api/v1/query/../rbac/organizations')).toBe('api/v1/rbac/organizations');
  });
});

describe('isMemberAllowed', () => {
  it('allows members only the read routes, and POST only for queries', () => {
    expect(isMemberAllowed('GET', 'api/v1/databases')).toBe(true);
    expect(isMemberAllowed('POST', 'api/v1/query')).toBe(true);
    expect(isMemberAllowed('POST', 'api/v1/databases')).toBe(false);
    expect(isMemberAllowed('GET', 'api/v1/logs')).toBe(false);
    expect(isMemberAllowed('GET', 'api/v1/rbac/organizations')).toBe(false);
    expect(isMemberAllowed('GET', 'api/v1/querying')).toBe(false); // prefix, not substring
  });
});

describe('isAuditedChange', () => {
  it('records configuration changes', () => {
    expect(isAuditedChange('POST', 'api/v1/auth/tokens')).toBe(true);
    expect(isAuditedChange('PATCH', 'api/v1/auth/tokens/5')).toBe(true);
    expect(isAuditedChange('DELETE', 'api/v1/retention/3')).toBe(true);
    expect(isAuditedChange('PUT', 'api/v1/mqtt/subscriptions/x')).toBe(true);
    expect(isAuditedChange('POST', 'api/v1/rbac/organizations')).toBe(true);
  });

  it('skips reads, SQL and ingestion', () => {
    expect(isAuditedChange('GET', 'api/v1/auth/tokens')).toBe(false);
    expect(isAuditedChange('HEAD', 'api/v1/auth/tokens')).toBe(false);
    for (const path of ['api/v1/query', 'api/v1/query/arrow', 'write', 'api/v2/write', 'api/v1/write/msgpack', 'api/v1/import/csv']) {
      expect(isAuditedChange('POST', path)).toBe(false);
    }
  });

  it('only exempts POST on those prefixes', () => {
    expect(isAuditedChange('DELETE', 'api/v1/query/history')).toBe(true);
  });
});

describe('isNonChangeStatus', () => {
  it('treats unknown routes and methods as no change', () => {
    expect([404, 405].every(isNonChangeStatus)).toBe(true);
    expect([200, 400, 403, 409, 500].some(isNonChangeStatus)).toBe(false);
  });
});

describe('isDryRun', () => {
  const body = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));

  it('recognises a dry run on the routes that take one', () => {
    expect(isDryRun('api/v1/delete', body({ database: 'x', dry_run: true }))).toBe(true);
    expect(isDryRun('api/v1/retention/3/execute', body({ dry_run: true }))).toBe(true);
    expect(isDryRun('api/v1/continuous_queries/7/execute', body({ dry_run: true }))).toBe(true);
  });

  it('is false for real runs, other routes and bad bodies', () => {
    expect(isDryRun('api/v1/delete', body({ dry_run: false }))).toBe(false);
    expect(isDryRun('api/v1/delete', body({ dry_run: 'true' }))).toBe(false);
    expect(isDryRun('api/v1/retention', body({ dry_run: true }))).toBe(false);
    expect(isDryRun('api/v1/delete', new TextEncoder().encode('{nope'))).toBe(false);
    expect(isDryRun('api/v1/delete', null)).toBe(false);
  });
});

describe('blockedReason', () => {
  it('blocks access-control paths for everyone, in any spelling the proxy forwards', () => {
    for (const path of ['api/v1/rbac/organizations', 'api/v1/rbac', 'api/v1/auth/tokens/5/teams', 'api/v1/auth/tokens/5/teams/9', 'api/v1/auth/tokens/5/permissions', 'api/v1/auth/cache/invalidate']) {
      expect(blockedReason(path)).toMatch(/Access tab/);
    }
    expect(blockedReason(canonicalizePath('/api/v1//RBAC/./organizations'))).not.toBeNull();
  });

  it('leaves token management and everything else alone', () => {
    for (const path of ['api/v1/auth/tokens', 'api/v1/auth/tokens/5', 'api/v1/auth/tokens/5/rotate', 'api/v1/rbacx', 'api/v1/query']) {
      expect(blockedReason(path)).toBeNull();
    }
  });

  it('does not decode: an encoded spelling stays literal, and Arc (no path unescaping) 404s it', () => {
    // Documents the assumption the block relies on rather than testing Arc.
    expect(canonicalizePath('api/v1/rb%61c/organizations')).toBe('api/v1/rb%61c/organizations');
    expect(blockedReason('api/v1/rb%61c/organizations')).toBeNull();
  });
});

describe('blockedReason: query governance', () => {
  it('refuses governance through the proxy, with its own reason', () => {
    expect(blockedReason('api/v1/governance/policies')).toMatch(/every node/);
    expect(blockedReason('api/v1/governance/usage/5')).toMatch(/every node/);
    expect(blockedReason('api/v1/governancex')).toBeNull();
  });
});
